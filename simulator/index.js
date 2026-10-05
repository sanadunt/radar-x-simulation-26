'use strict';

const fs   = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const { createDefaultTargets } = require('./target_gen');

// ─── Load Runtime Config ──────────────────────────────────────────────────────
let cfg;
const runtimePath = process.env.RDXXB_RUNTIME_CONFIG_PATH || path.join(__dirname, '..', 'runtime-config.json');
try {
  cfg = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
} catch (_) {
  const legacy = require('../config');
  cfg = {
    sim_mqtt:  { ...legacy.mqtt.tcp, topic: legacy.mqtt.topics.targets },
    radar:     legacy.radar,
    simulator: legacy.simulator,
  };
}

const simMqtt = cfg.sim_mqtt;

// Resolve enabled modules — fall back to legacy single-topic basic_usage if section absent
const mods = cfg.simulation_modules || {
  basic_usage: { enabled: true, topic: simMqtt.topic || 'radar/rdxxb/basic' },
};

// Custom delivery channels
const customDelivery = cfg.custom_delivery || [];

// ─── MQTT Connection ──────────────────────────────────────────────────────────
const tcpUrl   = `${simMqtt.protocol}://${simMqtt.host}:${simMqtt.port}`;
const clientId = `rdxxb-simulator-${Math.random().toString(16).slice(2, 8)}`;

const mqttOptions = { clientId, clean: true, connectTimeout: 5000, reconnectPeriod: 2000 };
if (simMqtt.username) mqttOptions.username = simMqtt.username;
if (simMqtt.password) mqttOptions.password = simMqtt.password;

// ─── Radar & Target Setup ─────────────────────────────────────────────────────
const { longitude: radarLon, latitude: radarLat, elevation_m: radarAlt } = cfg.radar;
const targets    = createDefaultTargets(radarLat, radarLon, cfg.simulator?.targetCount || 5);
let lastTime     = Date.now();
let frameCount   = 0;
let publishTimer = null;

// ─── Payload Builders (one per schema module) ─────────────────────────────────

function buildBasicUsage() {
  return {
    radar_location: {
      gps: {
        longitude:   cfg.radar.longitude,
        latitude:    cfg.radar.latitude,
        elevation_m: cfg.radar.elevation_m,
      },
      orientation: {
        roll_angle_deg:             cfg.radar.roll_angle_deg,
        pitch_angle_deg:            cfg.radar.pitch_angle_deg,
        north_correction_angle_deg: cfg.radar.north_correction_angle_deg,
      },
    },
    targets: targets.map(t => t.toJSON(radarLat, radarLon, radarAlt)),
    _meta: { frame_count: frameCount, published_at: new Date().toISOString() },
  };
}

function buildFrameMetadata() {
  return {
    frame_metadata: {
      frame_header:           '0x55AA',
      frame_id:               '0xFF02',
      frame_type:             'search_target_information',
      frame_count:            frameCount,
      frame_timestamp_utc:    new Date().toISOString(),
      protocol_id:            1,
      protocol_device:        'RD01',
      protocol_major_version: 2,
      protocol_minor_version: 14,
      checksum_valid:         true,
    },
  };
}

function buildRadarLocation() {
  return {
    radar_device: {
      device_id:    1,
      device_label: 'RDXXB Simulator',
      model_name:   'RD01',
      network:      { ip_address: '127.0.0.1', port: 7000 },
      gps: {
        longitude:               cfg.radar.longitude,
        latitude:                cfg.radar.latitude,
        elevation_m:             cfg.radar.elevation_m,
        heading_angle_deg:       45.0,
        heading_valid:           true,
        satellite_count:         12,
        installed_location_name: 'Simulator',
      },
      orientation: {
        roll_angle_deg:             cfg.radar.roll_angle_deg,
        pitch_angle_deg:            cfg.radar.pitch_angle_deg,
        north_correction_angle_deg: cfg.radar.north_correction_angle_deg,
      },
      operational_state: {
        work_mode:       '0x11', work_mode_label: 'search',
        fault_type:      '0x00', fault_label:     'none',
        servo_mode:      '0x33', servo_mode_label: 'circular_scan',
        scan_mode:       '0x01', scan_mode_label:  'mechanical_scanning',
      },
      servo: {
        current_azimuth_deg: parseFloat(((frameCount * 5) % 360).toFixed(1)),
        current_pitch_deg:   5.1,
        current_scan_cycle:  Math.floor(frameCount / 72),
      },
      frequency: {
        current_code:       10,
        current_x_band_ghz: 9.5,
        current_ku_band_ghz: 16.2,
      },
    },
  };
}

function buildRadarConfig() {
  return {
    radar_configuration: {
      silent_zones: [
        { zone_number: 1, start_angle_deg: 0, end_angle_deg: 0, enabled: false },
        { zone_number: 2, start_angle_deg: 0, end_angle_deg: 0, enabled: false },
      ],
      filters: {
        height_min_near_zone_m: 0,
        height_min_far_zone_m:  0,
        height_max_m:           1000,
        speed_min_ms:           0,
        speed_max_ms:           100,
        range_min_m:            10,
        range_max_m:            10000,
        altitude_range_km:      10,
      },
      autonomous_identification: {
        enabled:     true,
        max_targets: cfg.simulator?.targetCount || 5,
      },
    },
  };
}

function rnd(base, spread) {
  return parseFloat((base + (Math.random() - 0.5) * spread).toFixed(2));
}

function buildRadarHealth() {
  return {
    radar_health: {
      thermals: {
        subarray_temperatures: [1, 2, 3, 4].map(i => ({ index: i, temperature_c: rnd(45, 3) })),
        signal_board_temperature_c:           rnd(52, 2),
        frequency_synthesizer_temperature_c:  rnd(48.5, 2),
      },
      power: {
        subarray_currents: [1, 2, 3, 4].map(i => ({ index: i, current_a: rnd(5.4, 0.3) })),
        signal_voltages: [
          { channel: 1, voltage_v: 12 },
          { channel: 2, voltage_v: 5 },
          { channel: 3, voltage_v: 3.3 },
        ],
      },
      system_health: {
        fan_status:    { fan1: 'normal', fan2: 'normal', fan3: 'normal', fan4: 'normal' },
        memory_status: { qdr_initialized: true, ddr_0_initialized: true,
                         ddr_1_initialized: true, pcie_link_ok: true },
      },
      firmware: { fpga_version: 'v3.21', data_processing_version: '2.14.05.2025' },
    },
  };
}

function buildScanHeader() {
  return {
    scan_header: {
      search_azimuth_deg:   parseFloat(((frameCount * 5) % 360).toFixed(1)),
      search_elevation_deg: 5.1,
      scan_cycle_count:     Math.floor(frameCount / 72),
      pulse_group_id:       frameCount,
      target_count:         targets.length,
    },
  };
}

function buildTrackData() {
  return {
    targets: targets.map(t => ({
      track_id: t.track_id,
      ...t.toTrackData(radarLat, radarLon, radarAlt),
    })),
    _meta: { frame_count: frameCount, published_at: new Date().toISOString() },
  };
}

function buildTrackMetadata() {
  return {
    targets: targets.map(t => t.toTrackMetadata()),
    _meta: { frame_count: frameCount, published_at: new Date().toISOString() },
  };
}

const BUILDERS = {
  basic_usage:    buildBasicUsage,
  frame_metadata: buildFrameMetadata,
  radar_location: buildRadarLocation,
  radar_config:   buildRadarConfig,
  radar_health:   buildRadarHealth,
  scan_header:    buildScanHeader,
  track_data:     buildTrackData,
  track_metadata: buildTrackMetadata,
};

// ─── Custom Delivery Helpers ──────────────────────────────────────────────────

// Walk a dot-path string inside a nested object, return value or undefined
function getByDotPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// Set a value into a nested object using a dot-path string (creates intermediate objects)
function setByDotPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// Resolve a "moduleKey|dotPath" field reference against a map of built module payloads
// e.g.  "scan_header|scan_header.target_count"  →  number
function resolveField(allModuleData, fieldId) {
  const sep = fieldId.indexOf('|');
  if (sep === -1) return undefined;
  const moduleKey = fieldId.slice(0, sep);
  const dotPath   = fieldId.slice(sep + 1);
  const moduleOut = allModuleData[moduleKey];
  if (moduleOut == null) return undefined;
  return getByDotPath(moduleOut, dotPath);
}

// Build the payload for one custom delivery rule
function buildCustomPayload(allModuleData, rule) {
  const result = {};
  for (const fieldId of (rule.fields || [])) {
    const sep = fieldId.indexOf('|');
    if (sep === -1) continue;
    const dotPath = fieldId.slice(sep + 1);
    const value   = resolveField(allModuleData, fieldId);
    if (value !== undefined) {
      setByDotPath(result, dotPath, value);
    }
  }
  return result;
}

// ─── Connect ──────────────────────────────────────────────────────────────────
console.log(`[Simulator] Connecting to MQTT broker at ${tcpUrl} ...`);
const client = mqtt.connect(tcpUrl, mqttOptions);

client.on('connect', () => {
  console.log(`[Simulator] ✓ Connected (clientId: ${clientId})`);
  const active = Object.entries(mods)
    .filter(([, v]) => v.enabled)
    .map(([k, v]) => `  • ${k} → ${v.topic}`)
    .join('\n');
  console.log(`[Simulator] Active modules:\n${active || '  (none enabled)'}`);

  const activeCd = customDelivery.filter(r => r.enabled);
  if (activeCd.length > 0) {
    const cdLog = activeCd.map(r => `  • [CD] ${r.name || r.id} → ${r.topic} (${(r.fields || []).length} fields)`).join('\n');
    console.log(`[Simulator] Custom delivery channels:\n${cdLog}`);
  }

  console.log(`[Simulator] Publishing every ${cfg.simulator?.publishIntervalMs || 500} ms`);
  publishTimer = setInterval(publishAll, cfg.simulator?.publishIntervalMs || 500);
});

client.on('error',     err => console.error(`[Simulator] ✗ MQTT error: ${err.message}`));
client.on('reconnect', ()  => console.log('[Simulator] Reconnecting ...'));
client.on('close', () => {
  console.log('[Simulator] Connection closed.');
  if (publishTimer) { clearInterval(publishTimer); publishTimer = null; }
});

// ─── Publish Loop ─────────────────────────────────────────────────────────────
function publishAll() {
  const now = Date.now();
  const dt  = (now - lastTime) / 1000;
  lastTime  = now;
  frameCount++;

  // Advance physics
  targets.forEach(t => t.update(dt));

  // Publish each enabled module to its own topic
  for (const [key, mod] of Object.entries(mods)) {
    if (!mod.enabled || !mod.topic) continue;
    const builder = BUILDERS[key];
    if (!builder) continue;
    const payload = JSON.stringify(builder());
    client.publish(mod.topic, payload, { qos: 0, retain: false }, err => {
      if (err) console.error(`[Simulator] Publish error on ${mod.topic}: ${err.message}`);
    });
  }

  // Build all module outputs once for custom delivery resolution
  const allModuleData = {};
  for (const [key, builder] of Object.entries(BUILDERS)) {
    allModuleData[key] = builder();
  }

  // Publish custom delivery channels
  for (const rule of customDelivery) {
    if (!rule.enabled || !rule.topic) continue;
    if (!rule.fields || rule.fields.length === 0) continue;
    const payload = JSON.stringify(buildCustomPayload(allModuleData, rule));
    client.publish(rule.topic, payload, { qos: 0, retain: false }, err => {
      if (err) console.error(`[Simulator] Custom delivery error on ${rule.topic}: ${err.message}`);
    });
  }

  if (frameCount % 20 === 0) {
    const ids = targets.map(t => `#${t.track_id}`).join(', ');
    console.log(`[Simulator] Frame ${frameCount} | Targets: ${ids}`);
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[Simulator] Shutting down ...');
  clearInterval(publishTimer);
  client.end(true, {}, () => {
    console.log('[Simulator] Disconnected. Goodbye.');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
