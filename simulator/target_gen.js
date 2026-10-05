/**
 * Target movement physics and JSON serialization for the RDXXB radar simulator.
 * All coordinates follow WGS-84 / ENU conventions from the protocol spec.
 */

'use strict';

// Target classification codes from Section 4 of the protocol
const TYPE_CODES = {
  UNKNOWN: 0x00,
  PERSON:  0x11,
  CAR:     0x12,
  DRONE:   0x20,
  BIRD:    0x24,
  VESSEL:  0x31,
  OTHER:   0x40,
  FALSE:   0x41,
};

const TYPE_LABELS = {
  [TYPE_CODES.UNKNOWN]: 'unknown',
  [TYPE_CODES.PERSON]:  'person',
  [TYPE_CODES.CAR]:     'car',
  [TYPE_CODES.DRONE]:   'drone',
  [TYPE_CODES.BIRD]:    'bird',
  [TYPE_CODES.VESSEL]:  'vessel',
  [TYPE_CODES.OTHER]:   'other',
  [TYPE_CODES.FALSE]:   'false_target',
};

/**
 * Converts meters offset in ENU to geodetic delta degrees.
 * @param {number} eastM   - East offset in meters
 * @param {number} northM  - North offset in meters
 * @param {number} refLat  - Reference latitude in degrees
 * @returns {{ dLat: number, dLon: number }}
 */
function metersToDegreeDelta(eastM, northM, refLat) {
  const latRad = refLat * Math.PI / 180;
  return {
    dLat: northM / 110540,
    dLon: eastM  / (111320 * Math.cos(latRad)),
  };
}

class Target {
  /**
   * @param {object} opts
   * @param {number} opts.id            - Unique track ID
   * @param {number} opts.type          - Type code (e.g. TYPE_CODES.DRONE)
   * @param {number} opts.lat           - Initial latitude (WGS-84)
   * @param {number} opts.lon           - Initial longitude (WGS-84)
   * @param {number} opts.alt           - Altitude in meters
   * @param {number} opts.speed         - Speed in m/s
   * @param {number} opts.confidence    - Initial confidence [0,1]
   * @param {number} opts.energy        - Initial signal energy
   * @param {object} [opts.orbit]       - Orbit motion config
   * @param {object} [opts.linear]      - Linear motion config
   */
  constructor(opts) {
    this.track_id        = opts.id;
    this.type_code       = opts.type;
    this.lat             = opts.lat;
    this.lon             = opts.lon;
    this.alt             = opts.alt;
    this.speed           = opts.speed;
    this.confidence      = opts.confidence   || 0.85;
    this.energy          = opts.energy        || 2000 + Math.random() * 1000;
    this.credit_ratio    = opts.credit_ratio  || 0.80 + Math.random() * 0.15;
    this.track_point_count = 0;
    this.track_delete_flag = '0x00';

    // Velocity components (m/s, ENU)
    this.vx_east  = 0;
    this.vy_north = 0;
    this.vz_up    = 0;

    // Motion mode
    this.orbit  = opts.orbit  || null;
    this.linear = opts.linear || null;
  }

  /**
   * Advance physics by dt seconds.
   * @param {number} dt - Time delta in seconds
   */
  update(dt) {
    if (this.orbit) {
      this._updateOrbit(dt);
    } else if (this.linear) {
      this._updateLinear(dt);
    }

    this.track_point_count++;

    // Subtle noise on telemetry values
    this.confidence  = Math.min(1, Math.max(0.05, this.confidence  + (Math.random() - 0.5) * 0.015));
    this.energy      = Math.max(100, this.energy + (Math.random() - 0.5) * 60);
    this.credit_ratio = Math.min(1, Math.max(0.1, this.credit_ratio + (Math.random() - 0.5) * 0.01));
  }

  _updateOrbit(dt) {
    const { radarLat, radarLon, radius, direction } = this.orbit;

    // Advance the orbit angle (clockwise from North = positive direction)
    this.orbit.angle += direction * (this.speed / radius) * dt;

    // New absolute position
    const { dLat, dLon } = metersToDegreeDelta(
      radius * Math.sin(this.orbit.angle),
      radius * Math.cos(this.orbit.angle),
      radarLat
    );
    this.lat = radarLat + dLat;
    this.lon = radarLon + dLon;

    // ENU velocity (tangent to the circle)
    this.vx_east  = direction * this.speed * Math.cos(this.orbit.angle);
    this.vy_north = -direction * this.speed * Math.sin(this.orbit.angle);

    // Drones have subtle vertical movement
    if (this.type_code === TYPE_CODES.DRONE) {
      this.vz_up = (Math.random() - 0.5) * 0.8;
      this.alt  += this.vz_up * dt;
    } else {
      this.vz_up = 0;
    }
  }

  _updateLinear(dt) {
    const latRad  = this.lat * Math.PI / 180;
    this.lat += (this.linear.vy * dt) / 110540;
    this.lon += (this.linear.vx * dt) / (111320 * Math.cos(latRad));

    this.vx_east  = this.linear.vx;
    this.vy_north = this.linear.vy;
    this.vz_up    = 0;

    // Bounce off bounding box
    const b = this.linear.bounds;
    if (this.lat < b.minLat || this.lat > b.maxLat) this.linear.vy = -this.linear.vy;
    if (this.lon < b.minLon || this.lon > b.maxLon) this.linear.vx = -this.linear.vx;
  }

  /**
   * Compute polar coordinates relative to the radar.
   * @param {number} radarLat
   * @param {number} radarLon
   * @param {number} radarAlt
   */
  _getPolar(radarLat, radarLon, radarAlt) {
    const latRad = radarLat * Math.PI / 180;
    const east   = (this.lon - radarLon) * 111320 * Math.cos(latRad);
    const north  = (this.lat - radarLat) * 110540;
    const up     = this.alt - radarAlt;

    const horizDist = Math.sqrt(east * east + north * north);
    const distance  = Math.sqrt(horizDist * horizDist + up * up);

    const azimuth   = ((Math.atan2(east, north) * 180 / Math.PI) + 360) % 360;
    const elevation =  Math.atan2(up, horizDist) * 180 / Math.PI;

    // Radial speed = dot(velocity, unit_LOS)
    const radialSpeed = distance > 0
      ? (east * this.vx_east + north * this.vy_north + up * this.vz_up) / distance
      : 0;

    return {
      distance_m:          parseFloat(distance.toFixed(2)),
      azimuth_deg:         parseFloat(azimuth.toFixed(2)),
      elevation_pitch_deg: parseFloat(elevation.toFixed(2)),
      height_m:            parseFloat(up.toFixed(2)),
      radial_speed_ms:     parseFloat(radialSpeed.toFixed(3)),
    };
  }

  /**
   * Serialize to the RDXXB Basic Usage JSON target record.
   */
  toJSON(radarLat, radarLon, radarAlt) {
    const polar = this._getPolar(radarLat, radarLon, radarAlt);
    const typeHex = `0x${this.type_code.toString(16).padStart(2, '0').toUpperCase()}`;

    return {
      track_id:            this.track_id,
      track_delete_flag:   this.track_delete_flag,
      track_status:        this.track_delete_flag === '0x00' ? 'active' : 'deleted',
      track_type_code:     typeHex,
      track_type_label:    TYPE_LABELS[this.type_code] || 'unknown',
      confidence:          parseFloat(this.confidence.toFixed(2)),
      energy:              parseFloat(this.energy.toFixed(2)),
      credit_ratio:        parseFloat(this.credit_ratio.toFixed(2)),
      ...polar,
      longitude:           parseFloat(this.lon.toFixed(6)),
      latitude:            parseFloat(this.lat.toFixed(6)),
      altitude_m:          parseFloat(this.alt.toFixed(2)),
      vx_east_ms:          parseFloat(this.vx_east.toFixed(3)),
      vy_north_ms:         parseFloat(this.vy_north.toFixed(3)),
      vz_up_ms:            parseFloat(this.vz_up.toFixed(3)),
      unix_timestamp:      parseFloat((Date.now() / 1000).toFixed(3)),
    };
  }

  /**
   * Serialize to the Track Data module schema (Section 2.6).
   */
  toTrackData(radarLat, radarLon, radarAlt) {
    const polar   = this._getPolar(radarLat, radarLon, radarAlt);
    const typeHex = `0x${this.type_code.toString(16).padStart(2, '0').toUpperCase()}`;
    const horizSpeed = Math.sqrt(this.vx_east ** 2 + this.vy_north ** 2);
    const totalSpeed = Math.sqrt(horizSpeed ** 2 + this.vz_up ** 2);

    return {
      track: {
        track_identification: {
          track_id:          this.track_id,
          track_delete_flag: this.track_delete_flag,
          track_status:      this.track_delete_flag === '0x00' ? 'active' : 'deleted',
        },
        classification: {
          track_type_code:  typeHex,
          track_type_label: TYPE_LABELS[this.type_code] || 'unknown',
          confidence:       parseFloat(this.confidence.toFixed(2)),
          confidence_pct:   `${Math.round(this.confidence * 100)}%`,
        },
        signal_quality: {
          energy:           parseFloat(this.energy.toFixed(2)),
          credit_ratio:     parseFloat(this.credit_ratio.toFixed(2)),
          credit_ratio_pct: `${Math.round(this.credit_ratio * 100)}%`,
        },
        polar_coordinates: {
          ...polar,
          radial_speed_label: polar.radial_speed_ms < -0.1 ? 'approaching'
                            : polar.radial_speed_ms >  0.1 ? 'receding' : 'stationary',
        },
        geodetic_coordinates: {
          longitude:              parseFloat(this.lon.toFixed(6)),
          latitude:               parseFloat(this.lat.toFixed(6)),
          altitude_m:             parseFloat(this.alt.toFixed(2)),
          distance_from_radar_m:  polar.distance_m,
          bearing_from_radar_deg: polar.azimuth_deg,
          altitude_above_radar_m: polar.height_m,
        },
        velocity_enu: {
          vx_east_ms:         parseFloat(this.vx_east.toFixed(3)),
          vy_north_ms:        parseFloat(this.vy_north.toFixed(3)),
          vz_up_ms:           parseFloat(this.vz_up.toFixed(3)),
          total_speed_ms:     parseFloat(totalSpeed.toFixed(3)),
          horizontal_speed_ms:parseFloat(horizSpeed.toFixed(3)),
          vertical_direction: this.vz_up > 0.05 ? 'ascending'
                            : this.vz_up < -0.05 ? 'descending' : 'level',
        },
      },
    };
  }

  /**
   * Serialize to the Track Metadata module schema (Section 2.7).
   */
  toTrackMetadata(radarFrontendId = 1) {
    const now = new Date();
    return {
      track_metadata: {
        track_id:           this.track_id,
        loss_count_cpi:     0,
        loss_reason_code:   0,
        update_time_cpi:    this.track_point_count,
        age_pulses:         this.track_point_count,
        radar_frontend_id:  radarFrontendId,
        track_history: {
          track_point_count:    this.track_point_count,
          envelope_point_count: Math.min(this.track_point_count, 6),
          track_age_pulses:     this.track_point_count,
        },
        utc_timestamp: {
          year:        now.getUTCFullYear(),
          month:       now.getUTCMonth() + 1,
          day:         now.getUTCDate(),
          hour:        now.getUTCHours(),
          minute:      now.getUTCMinutes(),
          second:      now.getUTCSeconds(),
          millisecond: now.getUTCMilliseconds(),
          iso8601:     now.toISOString(),
          unix_timestamp: parseFloat((Date.now() / 1000).toFixed(3)),
        },
      },
    };
  }
}

/**
 * Factory: creates a set of targets around the radar.
 * @param {number} radarLat
 * @param {number} radarLon
 * @param {number} [count=5]  - Total number of targets to generate
 */
function createDefaultTargets(radarLat, radarLon, count = 5) {
  const cosLat = Math.cos(radarLat * Math.PI / 180);
  const bounds = {
    minLat: radarLat - 0.045,
    maxLat: radarLat + 0.045,
    minLon: radarLon - 0.055,
    maxLon: radarLon + 0.055,
  };

  const base = [
    new Target({
      id: 1001, type: TYPE_CODES.DRONE,
      lat: radarLat + 800 / 110540, lon: radarLon,
      alt: 155, speed: 12, confidence: 0.88,
      orbit: { radarLat, radarLon, radius: 800, angle: Math.PI / 2, direction: 1 },
    }),
    new Target({
      id: 1002, type: TYPE_CODES.DRONE,
      lat: radarLat + 1500 / 110540, lon: radarLon,
      alt: 210, speed: 15, confidence: 0.82,
      orbit: { radarLat, radarLon, radius: 1500, angle: 0, direction: 1 },
    }),
    new Target({
      id: 1003, type: TYPE_CODES.DRONE,
      lat: radarLat - 2500 / 110540, lon: radarLon,
      alt: 310, speed: 18, confidence: 0.76,
      orbit: { radarLat, radarLon, radius: 2500, angle: Math.PI, direction: -1 },
    }),
    new Target({
      id: 1004, type: TYPE_CODES.BIRD,
      lat: radarLat + 1000 / 110540,
      lon: radarLon + 1000 / (111320 * cosLat),
      alt: 85, speed: 7, confidence: 0.60,
      linear: { vx: 5, vy: 6, bounds },
    }),
    new Target({
      id: 1005, type: TYPE_CODES.CAR,
      lat: radarLat - 400 / 110540,
      lon: radarLon - 500 / (111320 * cosLat),
      alt: 152, speed: 10, confidence: 0.92,
      linear: { vx: 10, vy: 0.5, bounds },
    }),
  ];

  // If more targets requested, generate random extras
  const extraTypes = [TYPE_CODES.DRONE, TYPE_CODES.BIRD, TYPE_CODES.PERSON, TYPE_CODES.OTHER];
  for (let i = base.length; i < count; i++) {
    const radius = 500 + Math.random() * 3000;
    const angle  = Math.random() * Math.PI * 2;
    base.push(new Target({
      id: 1000 + i + 1,
      type: extraTypes[Math.floor(Math.random() * extraTypes.length)],
      lat: radarLat + (radius * Math.cos(angle)) / 110540,
      lon: radarLon + (radius * Math.sin(angle)) / (111320 * cosLat),
      alt: 50 + Math.random() * 400,
      speed: 5 + Math.random() * 20,
      confidence: 0.5 + Math.random() * 0.45,
      orbit: { radarLat, radarLon, radius, angle, direction: Math.random() > 0.5 ? 1 : -1 },
    }));
  }

  return base.slice(0, count);
}

module.exports = { Target, createDefaultTargets, TYPE_CODES, TYPE_LABELS };
