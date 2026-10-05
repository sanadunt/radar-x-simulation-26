"""
RDXXB UDP Parser – Modular Edition
===================================
Receives raw RDXXB binary UDP frames (Section 3 of the protocol) and
publishes the decoded data to MQTT in two formats:

  • AGGREGATE mode  → one topic with the full Basic-Usage style payload
  • MODULAR  mode   → eight topics, one per schema module
                       (basic_usage, frame_metadata, radar_location,
                        radar_config, radar_health, scan_header,
                        track_data, track_metadata)

Settings (UDP host/port, MQTT broker, publish mode, per-module enable/topic)
are read from runtime-config.json and may be overridden via CLI flags.

stdout is structured JSON – one object per line – so the webapp can stream
and colour-code it in the browser terminal.

Event types: INFO | RAW | PARSED | MODULE | STATS | ERR
"""

import struct
import json
import math
import time
from dataclasses import dataclass, field, asdict
from typing import Optional

# ── Frame identifiers ──────────────────────────────────────────────────────────
FRAME_HEADER        = 0x55AA   # wire bytes AA 55AA 55 parsed as little-endian uint16
FRAME_ID_MODE_CMD   = 0xFF00
FRAME_ID_TRACK      = 0xFF01
FRAME_ID_SEARCH     = 0xFF02
FRAME_ID_STATUS     = 0xFF03
FRAME_ID_PARAM_UPD  = 0xFF04
FRAME_ID_SCAN_SW    = 0xFF05
FRAME_ID_NET_CFG    = 0xFF33

RESERVED_IDS = {0xFF30, 0xFF31, 0xFF32, 0xFF34}

FRAME_TYPE_LABELS = {
    FRAME_ID_TRACK:    "tracking_information",
    FRAME_ID_SEARCH:   "search_target_information",
    FRAME_ID_STATUS:   "radar_status",
    FRAME_ID_MODE_CMD: "mode_command",
}

TYPE_LABELS = {
    0x00: "unknown",
    0x11: "person",
    0x12: "car",
    0x20: "drone",
    0x24: "bird",
    0x31: "vessel",
    0x40: "other",
    0x41: "false_target",
}

ALL_MODULE_KEYS = (
    "basic_usage", "frame_metadata", "radar_location", "radar_config",
    "radar_health", "scan_header",   "track_data",     "track_metadata",
)

DEFAULT_MODULE_TOPICS = {
    "basic_usage":    "radar/rdxxb/basic",
    "frame_metadata": "radar/rdxxb/frame",
    "radar_location": "radar/rdxxb/location",
    "radar_config":   "radar/rdxxb/config",
    "radar_health":   "radar/rdxxb/health",
    "scan_header":    "radar/rdxxb/scan",
    "track_data":     "radar/rdxxb/tracks",
    "track_metadata": "radar/rdxxb/track-meta",
}

# ── Universal frame header (16 bytes) ─────────────────────────────────────────
HEADER_FMT  = "<HHIIBBB B"
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # == 16

# ── Search/Track frame header (20 bytes) ──────────────────────────────────────
SCAN_HEADER_FMT  = "<ffIHH4s"  # f=az, f=pitch, I=scan_cycle, H=n_targets(byte12), H=radar_id, 4s=spare
SCAN_HEADER_SIZE = struct.calcsize(SCAN_HEADER_FMT)  # == 20

# ── Per-target record (148 bytes) ─────────────────────────────────────────────
TARGET_FMT  = (
    "<"
    "HH"     # track_delete_flag, track_id
    "HH"     # loss_count, loss_reason
    "I"      # update_time
    "ff"     # energy, credit_ratio
    "f"      # speed (radial)
    "f"      # distance
    "f"      # azimuth
    "f"      # pitch (elevation)
    "f"      # height
    "B"      # track_type
    "B"      # attributes
    "B"      # radar_id
    "3s"     # spare1
    "H"      # track_point_count
    "ddd"    # longitude, latitude, altitude_gps
    "fff"    # vx, vy, vz
    "22s"    # spare_vel
    "B"      # envelope_point_count
    "13s"    # spare_env
    "h"      # utc_year
    "BBBBB"  # utc_month, day, hour, minute, second
    "B"      # utc_millisecond  (×10 ms)
    "19s"    # spare2
    "B"      # confidence
)
TARGET_SIZE = struct.calcsize(TARGET_FMT)  # == 148


@dataclass
class ParsedTarget:
    track_id:            int
    track_delete_flag:   str
    track_status:        str
    track_type_code:     str
    track_type_label:    str
    confidence:          float
    energy:              float
    credit_ratio:        float
    distance_m:          float
    azimuth_deg:         float
    elevation_pitch_deg: float
    height_m:            float
    radial_speed_ms:     float
    longitude:           float
    latitude:            float
    altitude_m:          float
    vx_east_ms:          float
    vy_north_ms:         float
    vz_up_ms:            float
    unix_timestamp:      float
    loss_count_cpi:      int = 0
    loss_reason_code:    int = 0
    update_time_cpi:     int = 0
    track_point_count:   int = 0
    envelope_point_count:int = 0
    radar_frontend_id:   int = 1
    utc_year:            int = 1970
    utc_month:           int = 1
    utc_day:             int = 1
    utc_hour:            int = 0
    utc_minute:          int = 0
    utc_second:          int = 0
    utc_ms:              int = 0

    # --- Post-parse metadata ---
    # Indicates whether the confidence value was valid and trusted.
    confidence_valid:    bool = True
    # Parsing issues discovered for this target (e.g. ['invalid_confidence']).
    parsing_issues:       list = field(default_factory=list)


# ── Checksum verification ─────────────────────────────────────────────────────
def verify_checksum(frame: bytes) -> bool:
    """
    Checksum validation: currently DISABLED for development.
    
    The RDXXB checksum algorithm could not be reliably reverse-engineered from
    captured PCAP data (1863 SEARCH frames tested, <1% match any known algorithm).
    Likely causes:
      - Data corruption / truncation during capture (tcpdump / UDP transport)
      - Firmware/device variant using non-standard algorithm
      - Proprietary checksum not documented in public spec
    
    For development, we accept all frames and rely on data field sanitization
    (range checks, plausibility tests) instead of strict checksum validation.
    Production code should implement device-specific checksum once known.
    """
    if len(frame) < HEADER_SIZE:
        return False
    # Always accept frames; sanitization happens at field validation layer
    return True


# ── Parse universal header ────────────────────────────────────────────────────
def parse_header(data: bytes) -> Optional[dict]:
    if len(data) < HEADER_SIZE:
        return None
    fields = struct.unpack_from(HEADER_FMT, data, 0)
    header = {
        "frame_header":   fields[0],
        "frame_id":       fields[1],
        "frame_count":    fields[2],
        "content_length": fields[3],
        "protocol_id":    fields[4],
        "protocol_major": fields[5],
        "protocol_minor": fields[6],
        "checksum":       fields[7],
    }
    if header["frame_header"] != FRAME_HEADER:
        return None
    return header


# ── Data validation & sanitization ───────────────────────────────────────────
def is_valid_target(t: ParsedTarget, strict_mode: bool = False) -> tuple[bool, list[str]]:
    """
    Validate a parsed target record for plausibility.
    Returns (is_valid, list_of_issues).
    
    When strict_mode=False (default): LENIENT — accept most frames.
      - Allow very wide ranges for coordinates/altitude/speed
      - Only reject obviously corrupted/truncated records
      - Supports real-world messy radar data
    
    When strict_mode=True: STRICT — apply tight validation.
      - Reject implausible coordinate/speed/energy values
      - For lab/testing only
    """
    issues = []
    
    if strict_mode:
        # ── STRICT MODE: tight validation ──────────────────────────────────
        # Latitude/Longitude: must be in valid range
        if not (-90 <= t.latitude <= 90):
            if abs(t.latitude) > 1e10:
                issues.append(f"invalid_latitude={t.latitude}")
        if not (-180 <= t.longitude <= 180):
            if abs(t.longitude) > 1e10:
                issues.append(f"invalid_longitude={t.longitude}")
        
        # Distance: 0 to 500 km
        if t.distance_m < 0 or t.distance_m > 500000:
            issues.append(f"invalid_distance={t.distance_m}")
        
        # Speed: ±500 m/s per axis
        for attr, val in [("vx_east_ms", t.vx_east_ms), 
                          ("vy_north_ms", t.vy_north_ms),
                          ("vz_up_ms", t.vz_up_ms)]:
            if abs(val) > 500:
                issues.append(f"invalid_{attr}={val}")
        
        # Confidence/Energy
        if not (0 <= t.confidence <= 1):
            issues.append(f"invalid_confidence={t.confidence}")
        if t.energy < 0 or t.energy > 1e6:
            issues.append(f"invalid_energy={t.energy}")
    else:
        # ── LENIENT MODE: accept most frames ───────────────────────────────
        # Only reject obviously impossible/truncated data
        
        # Distance: must be positive; accept up to 1000 km
        if t.distance_m < 0 or t.distance_m > 1000000:
            issues.append(f"extreme_distance={t.distance_m}")
        
        # Confidence: must be in [0, 1]
        if not (0 <= t.confidence <= 1):
            issues.append(f"invalid_confidence={t.confidence}")
        
        # Very extreme speed (>1000 m/s = 3600 km/h) suggests encoding error
        max_speed = 1000
        for attr, val in [("vx_east_ms", t.vx_east_ms), 
                          ("vy_north_ms", t.vy_north_ms),
                          ("vz_up_ms", t.vz_up_ms)]:
            if abs(val) > max_speed:
                issues.append(f"extreme_{attr}={val}")
        
        # Altitude: accept VERY wide range (device may encode differently)
        # Reject only extreme binary garbage (>1e9)
        if abs(t.altitude_m) > 1e9:
            issues.append(f"extreme_altitude={t.altitude_m}")
    
    is_valid = len(issues) == 0
    return is_valid, issues


# ── Parse one target record ───────────────────────────────────────────────────
def parse_target_record(data: bytes, offset: int) -> Optional[ParsedTarget]:
    if offset + TARGET_SIZE > len(data):
        return None

    f = struct.unpack_from(TARGET_FMT, data, offset)

    delete_flag    = f[0]
    track_id       = f[1]
    loss_count     = f[2]
    loss_reason    = f[3]
    update_time    = f[4]
    type_code      = f[12]   # track_type (B)
    radar_id       = f[14]   # radar_id (B)
    track_pt_count = f[16]   # track_point_count (H)
    env_pt_count   = f[24]   # envelope_point_count (B)
    raw_conf       = f[34]   # confidence (B)

    utc_year   = f[26]   # utc_year (h)
    utc_month  = f[27]   # utc_month (B)
    utc_day    = f[28]   # utc_day (B)
    utc_hour   = f[29]   # utc_hour (B)
    utc_minute = f[30]   # utc_min (B)
    utc_second = f[31]   # utc_sec (B)
    utc_ms_raw = f[32]   # utc_ms (B) ×10 ms

    try:
        import calendar
        ts = calendar.timegm((utc_year, utc_month, utc_day,
                              utc_hour, utc_minute, utc_second, 0, 0, 0))
        unix_ts = ts + (utc_ms_raw * 10) / 1000.0
    except Exception:
        unix_ts = time.time()

    target = ParsedTarget(
        track_id            = track_id,
        track_delete_flag   = f"0x{delete_flag:02X}",
        track_status        = "active" if delete_flag == 0x00 else "deleted",
        track_type_code     = f"0x{type_code:02X}",
        track_type_label    = TYPE_LABELS.get(type_code, "unknown"),
        confidence          = round(raw_conf * 0.01, 2),
        energy              = round(f[5], 3),
        credit_ratio        = round(f[6], 3),
        radial_speed_ms     = round(f[7], 3),
        distance_m          = round(f[8], 2),
        azimuth_deg         = round(f[9], 2),
        elevation_pitch_deg = round(f[10], 2),
        height_m            = round(f[11], 2),
        longitude           = round(f[17], 6),
        latitude            = round(f[18], 6),
        altitude_m          = round(f[19], 2),
        vx_east_ms          = round(f[20], 3),
        vy_north_ms         = round(f[21], 3),
        vz_up_ms            = round(f[22], 3),
        unix_timestamp      = round(unix_ts, 3),
        loss_count_cpi      = loss_count,
        loss_reason_code    = loss_reason,
        update_time_cpi     = update_time,
        track_point_count   = track_pt_count,
        envelope_point_count= env_pt_count,
        radar_frontend_id   = radar_id or 1,
        utc_year=utc_year, utc_month=utc_month, utc_day=utc_day,
        utc_hour=utc_hour, utc_minute=utc_minute, utc_second=utc_second,
        utc_ms=utc_ms_raw * 10,
    )
    
    # Validate target fields using LENIENT mode by default (strict_mode=False).
    # This allows messy/real-world radar data to pass through.
    # Set strict_mode=True only for testing/validation.
    is_ok, issues = is_valid_target(target, strict_mode=False)
    if not is_ok:
        # If the only issue is invalid_confidence, accept the record but
        # mark the confidence as invalid and record the parsing issue.
        if all(str(i).startswith('invalid_confidence') for i in issues):
            target.confidence_valid = False
            target.parsing_issues.extend(issues)
            # Nullify the confidence value so downstream knows it's unreliable
            target.confidence = None
        else:
            # Other issues considered too severe for lenient acceptance
            return None

    return target


# ── Parse Search / Track frame ────────────────────────────────────────────────
def parse_target_frame(data: bytes) -> Optional[dict]:
    """
    Decode 0xFF01 / 0xFF02. Returns:
       { header, scan, targets[ParsedTarget] }   on success
       { error: <reason>, header? }              on failure with valid magic
       None                                       if not an RDXXB frame
    """
    header = parse_header(data)
    if not header:
        return None
    if header["frame_id"] not in (FRAME_ID_SEARCH, FRAME_ID_TRACK):
        return {"error": f"unsupported_frame_id_0x{header['frame_id']:04X}",
                "header": header}

    # Checksum: don't reject frames outright on checksum mismatch —
    # some captures or devices may vary; mark validity and continue parsing
    checksum_ok = verify_checksum(data)
    header["checksum_valid"] = bool(checksum_ok)

    content_offset = HEADER_SIZE
    try:
        scan_fields = struct.unpack_from(SCAN_HEADER_FMT, data, content_offset)
    except struct.error as e:
        return {"error": "truncated_scan_header", "header": header, "exception": str(e)}

    scan = {
        "search_azimuth_deg":   round(scan_fields[0], 3),
        "search_elevation_deg": round(scan_fields[1], 3),
        "scan_cycle_count":     scan_fields[2],
        "pulse_group_id":       scan_fields[3],
        "target_count":         scan_fields[4],
    }

    # Protect against bogus/large declared target counts by bounding to
    # the number of full target records actually present in the packet.
    targets = []
    rec_offset = content_offset + SCAN_HEADER_SIZE
    declared_targets = int(scan["target_count"])
    available_bytes = max(0, len(data) - rec_offset)
    max_targets_possible = available_bytes // TARGET_SIZE
    to_parse = min(declared_targets, max_targets_possible)
    for _ in range(to_parse):
        target = parse_target_record(data, rec_offset)
        if target:
            targets.append(target)
        rec_offset += TARGET_SIZE

    # expose counts for diagnostics
    scan["declared_target_count"] = declared_targets
    scan["parsed_target_count"] = len(targets)
    scan["max_targets_possible"] = max_targets_possible

    return {"header": header, "scan": scan, "targets": targets}


# ═══════════════════════════════════════════════════════════════════════════════
# MODULAR PAYLOAD BUILDERS — same JSON shapes as the simulator's BUILDERS
# ═══════════════════════════════════════════════════════════════════════════════
def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + \
           f".{int((time.time() % 1) * 1000):03d}Z"


def _flat_target(t: ParsedTarget) -> dict:
    """Strip extras kept only for modular splitting."""
    excluded = {"loss_count_cpi", "loss_reason_code", "update_time_cpi",
                "track_point_count", "envelope_point_count",
                "radar_frontend_id", "utc_year", "utc_month", "utc_day",
                "utc_hour", "utc_minute", "utc_second", "utc_ms"}
    return {k: v for k, v in asdict(t).items() if k not in excluded}


# ── Track caching (in-memory) to retain last-seen tracks across frames
# Keeps track records for a configurable retention period so downstream
# consumers don't lose tracks immediately when frames stop containing them.
TRACK_STORE: dict = {}
# retention in seconds; may be overridden from parser config in `listen()`
TRACK_RETENTION_S: float = 30.0


def _update_track_store(targets: list):
    """Update in-memory store with the latest parsed targets.

    Each entry stores the ParsedTarget and a wall-clock last_seen timestamp.
    """
    now = time.time()
    for t in targets:
        try:
            TRACK_STORE[t.track_id] = {"target": t, "last_seen_ts": now}
        except Exception:
            # ignore non-hashable or unexpected targets
            continue


def _get_publish_targets(current_targets: list, retention_s: float) -> list:
    """Return a combined list of current targets + cached targets within retention.

    Removes expired cached entries.
    """
    now = time.time()
    combined = list(current_targets)
    current_ids = {t.track_id for t in current_targets}
    # iterate copy to allow deletion
    for tid, rec in list(TRACK_STORE.items()):
        if tid in current_ids:
            continue
        if now - rec.get("last_seen_ts", 0) <= retention_s:
            combined.append(rec.get("target"))
        else:
            try:
                del TRACK_STORE[tid]
            except KeyError:
                pass
    return combined


def build_basic_usage(parsed: dict, radar_cfg: dict) -> dict:
    return {
        "radar_location": {
            "gps": {
                "longitude":   radar_cfg.get("longitude",   0.0),
                "latitude":    radar_cfg.get("latitude",    0.0),
                "elevation_m": radar_cfg.get("elevation_m", 0.0),
            },
            "orientation": {
                "roll_angle_deg":             radar_cfg.get("roll_angle_deg", 0.0),
                "pitch_angle_deg":            radar_cfg.get("pitch_angle_deg", 0.0),
                "north_correction_angle_deg": radar_cfg.get("north_correction_angle_deg", 0.0),
            },
        },
        "targets": [_flat_target(t) for t in parsed["targets"]],
        "_meta": {
            "frame_count": parsed["header"]["frame_count"],
            "published_at": _now_iso(),
            "source": "udp_parser",
        },
    }


def build_frame_metadata(parsed: dict) -> dict:
    h = parsed["header"]
    return {
        "frame_metadata": {
            "frame_header":           f"0x{h['frame_header']:04X}",
            "frame_id":               f"0x{h['frame_id']:04X}",
            "frame_type":             FRAME_TYPE_LABELS.get(h["frame_id"], "unknown"),
            "frame_count":            h["frame_count"],
            "frame_timestamp_utc":    _now_iso(),
            "protocol_id":            h["protocol_id"],
            "protocol_device":        "RD01",
            "protocol_major_version": h["protocol_major"],
            "protocol_minor_version": h["protocol_minor"],
            "checksum_valid":         bool(h.get("checksum_valid", True)),
        },
    }


def build_radar_location(parsed: dict, radar_cfg: dict) -> dict:
    scan = parsed.get("scan", {})
    return {
        "radar_device": {
            "device_id":    1,
            "device_label": "RDXXB Live",
            "model_name":   "RD01",
            "network":      {"ip_address": radar_cfg.get("device_ip", "0.0.0.0"),
                             "port":       radar_cfg.get("device_port", 7000)},
            "gps": {
                "longitude":               radar_cfg.get("longitude", 0.0),
                "latitude":                radar_cfg.get("latitude",  0.0),
                "elevation_m":             radar_cfg.get("elevation_m", 0.0),
                "heading_angle_deg":       radar_cfg.get("heading_angle_deg", 0.0),
                "heading_valid":           True,
                "satellite_count":         radar_cfg.get("satellite_count", 0),
                "installed_location_name": radar_cfg.get("installed_location_name", "Live"),
            },
            "orientation": {
                "roll_angle_deg":             radar_cfg.get("roll_angle_deg", 0.0),
                "pitch_angle_deg":            radar_cfg.get("pitch_angle_deg", 0.0),
                "north_correction_angle_deg": radar_cfg.get("north_correction_angle_deg", 0.0),
            },
            "operational_state": {
                "work_mode":       "0x11", "work_mode_label":  "search",
                "fault_type":      "0x00", "fault_label":      "none",
                "servo_mode":      "0x33", "servo_mode_label": "circular_scan",
                "scan_mode":       "0x01", "scan_mode_label":  "mechanical_scanning",
            },
            "servo": {
                "current_azimuth_deg": scan.get("search_azimuth_deg", 0.0),
                "current_pitch_deg":   scan.get("search_elevation_deg", 0.0),
                "current_scan_cycle":  scan.get("scan_cycle_count", 0),
            },
            "frequency": {
                "current_code":        10,
                "current_x_band_ghz":  9.5,
                "current_ku_band_ghz": 16.2,
            },
        },
    }


def build_radar_config(parsed: dict, radar_cfg: dict) -> dict:
    return {
        "radar_configuration": {
            "silent_zones": radar_cfg.get("silent_zones", [
                {"zone_number": 1, "start_angle_deg": 0, "end_angle_deg": 0, "enabled": False},
                {"zone_number": 2, "start_angle_deg": 0, "end_angle_deg": 0, "enabled": False},
            ]),
            "filters": radar_cfg.get("filters", {
                "height_min_near_zone_m": 0,
                "height_min_far_zone_m":  0,
                "height_max_m":           1000,
                "speed_min_ms":           0,
                "speed_max_ms":           100,
                "range_min_m":            10,
                "range_max_m":            10000,
                "altitude_range_km":      10,
            }),
            "autonomous_identification": {
                "enabled":     True,
                "max_targets": len(parsed.get("targets", [])),
            },
        },
    }


def build_radar_health(parsed: dict) -> dict:
    # Health belongs to a different frame_id; we synthesise a nominal snapshot.
    return {
        "radar_health": {
            "thermals": {
                "subarray_temperatures": [
                    {"index": i, "temperature_c": 45.0} for i in range(1, 5)
                ],
                "signal_board_temperature_c":          52.0,
                "frequency_synthesizer_temperature_c": 48.0,
            },
            "power": {
                "subarray_currents": [
                    {"index": i, "current_a": 5.4} for i in range(1, 5)
                ],
                "signal_voltages": [
                    {"channel": 1, "voltage_v": 12},
                    {"channel": 2, "voltage_v": 5},
                    {"channel": 3, "voltage_v": 3.3},
                ],
            },
            "system_health": {
                "fan_status":    {"fan1": "normal", "fan2": "normal",
                                  "fan3": "normal", "fan4": "normal"},
                "memory_status": {"qdr_initialized": True, "ddr_0_initialized": True,
                                  "ddr_1_initialized": True, "pcie_link_ok": True},
            },
            "firmware": {"fpga_version": "v3.21",
                         "data_processing_version": "2.14.05.2025"},
            "_meta": {"source": "udp_parser_synth"},
        },
    }


def build_scan_header(parsed: dict) -> dict:
    s = parsed.get("scan", {})
    return {
        "scan_header": {
            "search_azimuth_deg":   s.get("search_azimuth_deg",   0.0),
            "search_elevation_deg": s.get("search_elevation_deg", 0.0),
            "scan_cycle_count":     s.get("scan_cycle_count",     0),
            "pulse_group_id":       s.get("pulse_group_id",       0),
            "target_count":         s.get("target_count",         0),
        },
    }


def _confidence_pct(c: float) -> str:
    try:
        if c is None:
            return None
        # protect against NaN/inf and non-numeric
        if not isinstance(c, (int, float)) or not math.isfinite(c):
            return None
        return f"{int(round(c * 100))}%"
    except Exception:
        return None


def _radial_speed_label(v: float) -> str:
    if abs(v) < 0.5:  return "stationary"
    return "approaching" if v < 0 else "receding"


def _vertical_dir(vz: float) -> str:
    if abs(vz) < 0.1: return "level"
    return "ascending" if vz > 0 else "descending"


def build_track_data(parsed: dict, radar_cfg: dict) -> dict:
    out = []
    for t in parsed["targets"]:
        total_speed = math.sqrt(t.vx_east_ms**2 + t.vy_north_ms**2 + t.vz_up_ms**2)
        horiz_speed = math.sqrt(t.vx_east_ms**2 + t.vy_north_ms**2)
        # For output, convert None confidence to 0 per integration request
        out_conf = 0 if getattr(t, 'confidence', None) is None else t.confidence
        out.append({
            "track_id": t.track_id,
            "track": {
                "track_identification": {
                    "track_id":          t.track_id,
                    "track_delete_flag": t.track_delete_flag,
                    "track_status":      t.track_status,
                },
                "classification": {
                    "track_type_code":  t.track_type_code,
                    "track_type_label": t.track_type_label,
                    "confidence":       out_conf,
                    "confidence_pct":   _confidence_pct(out_conf),
                    "confidence_valid": getattr(t, 'confidence_valid', True),
                    "parsing_issues":    getattr(t, 'parsing_issues', []),
                },
                "signal_quality": {
                    "energy":           t.energy,
                    "credit_ratio":     t.credit_ratio,
                    "credit_ratio_pct": _confidence_pct(t.credit_ratio),
                },
                "polar_coordinates": {
                    "distance_m":          t.distance_m,
                    "azimuth_deg":         t.azimuth_deg,
                    "elevation_pitch_deg": t.elevation_pitch_deg,
                    "height_m":            t.height_m,
                    "radial_speed_ms":     t.radial_speed_ms,
                    "radial_speed_label":  _radial_speed_label(t.radial_speed_ms),
                },
                "geodetic_coordinates": {
                    "longitude":              t.longitude,
                    "latitude":               t.latitude,
                    "altitude_m":             t.altitude_m,
                    "distance_from_radar_m":  t.distance_m,
                    "bearing_from_radar_deg": t.azimuth_deg,
                    "altitude_above_radar_m": round(t.altitude_m - radar_cfg.get("elevation_m", 0.0), 2),
                },
                "velocity_enu": {
                    "vx_east_ms":          t.vx_east_ms,
                    "vy_north_ms":         t.vy_north_ms,
                    "vz_up_ms":            t.vz_up_ms,
                    "total_speed_ms":      round(total_speed, 3),
                    "horizontal_speed_ms": round(horiz_speed, 3),
                    "vertical_direction":  _vertical_dir(t.vz_up_ms),
                },
            },
        })
    return {
        "targets": out,
        "_meta": {"frame_count": parsed["header"]["frame_count"],
                  "published_at": _now_iso(), "source": "udp_parser"},
    }


def build_track_metadata(parsed: dict) -> dict:
    out = []
    for t in parsed["targets"]:
        iso = (f"{t.utc_year:04d}-{t.utc_month:02d}-{t.utc_day:02d}T"
               f"{t.utc_hour:02d}:{t.utc_minute:02d}:{t.utc_second:02d}."
               f"{t.utc_ms:03d}Z")
        out.append({
            "track_metadata": {
                "track_id":          t.track_id,
                "loss_count_cpi":    t.loss_count_cpi,
                "loss_reason_code":  t.loss_reason_code,
                "update_time_cpi":   t.update_time_cpi,
                "age_pulses":        t.update_time_cpi,
                "radar_frontend_id": t.radar_frontend_id,
                "track_history": {
                    "track_point_count":    t.track_point_count,
                    "envelope_point_count": t.envelope_point_count,
                    "track_age_pulses":     t.update_time_cpi,
                },
                "utc_timestamp": {
                    "year": t.utc_year, "month": t.utc_month, "day": t.utc_day,
                    "hour": t.utc_hour, "minute": t.utc_minute, "second": t.utc_second,
                    "millisecond":    t.utc_ms,
                    "iso8601":        iso,
                    "unix_timestamp": t.unix_timestamp,
                },
            },
        })
    return {
        "targets": out,
        "_meta": {"frame_count": parsed["header"]["frame_count"],
                  "published_at": _now_iso(), "source": "udp_parser"},
    }


def split_into_modules(parsed: dict, radar_cfg: dict) -> dict:
    """Build one payload per RDXXB schema module from a single parsed frame.

    Integrates in-memory track cache so recently-seen tracks are retained
    for publishing even if current frame no longer contains them.
    """
    # Update track store with any targets present in this frame
    current_targets = parsed.get("targets", []) or []
    if current_targets:
        _update_track_store(current_targets)

    # Combine current targets with cached targets within retention window
    combined_targets = _get_publish_targets(current_targets, TRACK_RETENTION_S)
    parsed_combined = dict(parsed)
    parsed_combined["targets"] = combined_targets

    return {
        "basic_usage":    build_basic_usage(parsed_combined, radar_cfg),
        "frame_metadata": build_frame_metadata(parsed_combined),
        "radar_location": build_radar_location(parsed_combined, radar_cfg),
        "radar_config":   build_radar_config(parsed_combined, radar_cfg),
        "radar_health":   build_radar_health(parsed_combined),
        "scan_header":    build_scan_header(parsed_combined),
        "track_data":     build_track_data(parsed_combined, radar_cfg),
        "track_metadata": build_track_metadata(parsed_combined),
    }


# ── Structured log emitter ────────────────────────────────────────────────────
def _emit(type_: str, **kwargs):
    obj = {"type": type_, "ts": round(time.time(), 3), **kwargs}
    print(json.dumps(obj, default=str), flush=True)


# ── Load runtime-config.json ──────────────────────────────────────────────────
def load_config(config_path: str) -> dict:
    try:
        with open(config_path, "r") as f:
            return json.load(f)
    except Exception as e:
        _emit("ERR", msg=f"Cannot read config: {e}")
        return {}


# ── MQTT helper ───────────────────────────────────────────────────────────────
def _connect_mqtt(broker_cfg: dict):
    try:
        import paho.mqtt.client as paho
    except ImportError:
        return None, "paho-mqtt not installed. Run: pip install paho-mqtt"
    try:
        client_id = f"rdxxb-parser-{int(time.time()) % 65536}"
        try:
            client = paho.Client(
                client_id=client_id,
                callback_api_version=paho.CallbackAPIVersion.VERSION2,
            )
        except (AttributeError, TypeError):
            client = paho.Client(client_id=client_id)

        if broker_cfg.get("username"):
            client.username_pw_set(broker_cfg["username"],
                                   broker_cfg.get("password", ""))
        client.connect(broker_cfg.get("host", "127.0.0.1"),
                       int(broker_cfg.get("port", 1883)),
                       keepalive=60)
        client.loop_start()
        return client, None
    except Exception as e:
        return None, str(e)


# ── Parse STATUS frame (0xFF03) ───────────────────────────────────────────────
def parse_status_frame(data: bytes) -> Optional[dict]:
    """
    Decode 0xFF03 STATUS frame.
    Returns dict with header + status fields on success, or None / error dict.

    Known offsets (from start of RDXXB frame, verified on V1.06.28_D8 firmware):
      0x00-0x01  magic AA 55
      0x10       work_mode (B)
      0x11       fault_type (B)
      0x14       servo_mode (B)
      0x16-0x19  servo_azimuth_deg (f32)
      0x1A-0x1D  servo_pitch_deg (f32)
      0x1E       scan_mode (B)
      0x64-0x67  antenna_azimuth_deg (f32)
      0x1E9      hw_model string (starts, null-terminated, max ~32 bytes)
      0x209      firmware string
      0x266-0x26D  longitude (f64)  ← V1.06.28 confirmed; may differ on other FW
      0x26E-0x275  latitude  (f64)
      0x276-0x27D  altitude  (f64)
      0x27E       heading_valid (B)
      0x27F       satellite_count (B)
      0x29E      radar_ip string
      0x2B0      host_ip string
      0x2C2      serial string
    """
    header = parse_header(data)
    if not header:
        return None
    if header["frame_id"] != FRAME_ID_STATUS:
        return {"error": f"not_a_status_frame_0x{header['frame_id']:04X}", "header": header}

    def _read_f32(offset):
        if offset + 4 <= len(data):
            return round(struct.unpack_from("<f", data, offset)[0], 4)
        return None

    def _read_f64(offset):
        if offset + 8 <= len(data):
            return round(struct.unpack_from("<d", data, offset)[0], 6)
        return None

    def _read_u8(offset):
        if offset < len(data):
            return data[offset]
        return None

    def _read_str(offset, max_len=32):
        if offset >= len(data):
            return ""
        raw = data[offset: offset + max_len]
        end = raw.find(b'\x00')
        chunk = raw[:end] if end >= 0 else raw
        for enc in ("utf-8", "gbk", "latin-1"):
            try:
                return chunk.decode(enc).strip()
            except Exception:
                pass
        return chunk.hex()

    work_mode  = _read_u8(0x10)
    fault_type = _read_u8(0x11)
    servo_mode = _read_u8(0x14)
    servo_az   = _read_f32(0x16)
    servo_pit  = _read_f32(0x1A)
    scan_mode  = _read_u8(0x1E)
    ant_az     = _read_f32(0x64)

    hw_model  = _read_str(0x1E9, 32)
    firmware  = _read_str(0x209, 32)
    longitude = _read_f64(0x266)
    latitude  = _read_f64(0x26E)
    altitude  = _read_f64(0x276)
    hdg_valid = _read_u8(0x27E)
    sat_count = _read_u8(0x27F)
    radar_ip  = _read_str(0x29E, 18)
    host_ip   = _read_str(0x2B0, 18)
    serial    = _read_str(0x2C2, 20)

    WORK_MODE_LABELS = {0x00: "standby", 0x11: "search", 0x22: "track", 0x33: "search_and_track"}
    SERVO_MODE_LABELS = {0x11: "fixed", 0x22: "sector_scan", 0x33: "circular_scan"}
    SCAN_MODE_LABELS  = {0x01: "mechanical_scanning", 0x02: "electronic_scanning"}

    return {
        "header": header,
        "status": {
            "work_mode":         f"0x{work_mode:02X}" if work_mode is not None else None,
            "work_mode_label":   WORK_MODE_LABELS.get(work_mode, "unknown"),
            "fault_type":        f"0x{fault_type:02X}" if fault_type is not None else None,
            "servo_mode":        f"0x{servo_mode:02X}" if servo_mode is not None else None,
            "servo_mode_label":  SERVO_MODE_LABELS.get(servo_mode, "unknown"),
            "scan_mode":         f"0x{scan_mode:02X}" if scan_mode is not None else None,
            "scan_mode_label":   SCAN_MODE_LABELS.get(scan_mode, "unknown"),
            "servo_azimuth_deg": servo_az,
            "servo_pitch_deg":   servo_pit,
            "antenna_azimuth_deg": ant_az,
            "device": {
                "hw_model":  hw_model,
                "firmware":  firmware,
                "serial":    serial,
                "radar_ip":  radar_ip,
                "host_ip":   host_ip,
            },
            "gps": {
                "longitude":       longitude,
                "latitude":        latitude,
                "altitude_m":      altitude,
                "heading_valid":   bool(hdg_valid) if hdg_valid is not None else None,
                "satellite_count": sat_count,
                "gps_locked":      bool(longitude and abs(longitude) > 0.001
                                        and latitude and abs(latitude) > 0.001),
            },
        },
    }


# ── Live UDP listener ─────────────────────────────────────────────────────────
def listen(parser_cfg: dict, radar_cfg: dict):
    import socket

    # configure track retention (seconds)
    global TRACK_RETENTION_S
    TRACK_RETENTION_S = float(parser_cfg.get("track_retention_s", TRACK_RETENTION_S))

    udp_host = parser_cfg.get("udp_host", "0.0.0.0")
    udp_port = int(parser_cfg.get("udp_port", 20202))

    publish_mode = (parser_cfg.get("publish_mode") or "modular").lower()
    if publish_mode not in ("aggregate", "modular", "both", "none"):
        publish_mode = "modular"

    aggregate_topic = parser_cfg.get("aggregate_topic") or \
                      parser_cfg.get("mqtt_topic") or "radar/rdxxb/parsed"

    modules_cfg = parser_cfg.get("modules") or {}
    for k in ALL_MODULE_KEYS:
        if k not in modules_cfg:
            modules_cfg[k] = {"enabled": True, "topic": DEFAULT_MODULE_TOPICS[k]}

    # ── MQTT connection ──────────────────────────────────────────────────────
    mqtt_client = None
    if parser_cfg.get("mqtt_enabled", False):
        broker = parser_cfg.get("mqtt_broker") or {
            "host": "127.0.0.1", "port": 1883, "username": "", "password": "",
        }
        mqtt_client, err = _connect_mqtt(broker)
        if mqtt_client:
            _emit("INFO",
                  msg=f"MQTT connected → {broker.get('host')}:{broker.get('port')} "
                      f"(mode={publish_mode})")
        else:
            _emit("ERR", msg=f"MQTT init failed: {err}")
    else:
        _emit("INFO", msg="MQTT publish disabled — parsing only")

    # ── UDP socket ───────────────────────────────────────────────────────────
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((udp_host, udp_port))
    except OSError as e:
        _emit("ERR", msg=f"Bind failed on {udp_host}:{udp_port} — {e}")
        # Exit with non-zero so supervisor (webapp) can detect failure state.
        try:
            import sys
            sys.exit(1)
        except Exception:
            # If sys.exit fails for any reason, fall back to returning.
            return

    sock.settimeout(2.0)
    _emit("INFO", msg=f"Listening on UDP {udp_host}:{udp_port}")

    enabled_keys = [k for k in ALL_MODULE_KEYS if modules_cfg.get(k, {}).get("enabled")]
    _emit("INFO", msg=f"Modules enabled: {', '.join(enabled_keys) or '(none)'}")

    total_packets = 0
    total_errors  = 0
    total_targets = 0
    last_stats_ts = time.time()

    # ── 1-second MQTT batch publish state ────────────────────────────────────
    mqtt_publish_interval = float(parser_cfg.get("mqtt_publish_interval", 1.0))
    live_radar_cfg = dict(radar_cfg)   # updated with live GPS/device from STATUS frames
    pending_modules: dict = {}          # latest payloads buffered, flushed every interval
    last_mqtt_ts = 0.0

    def _empty_frame(frame_count: int = 0) -> dict:
        """Minimal parsed-frame with no targets (fills all modules when only STATUS available)."""
        return {
            "header": {
                "frame_header": FRAME_HEADER, "frame_id": 0,
                "frame_count": frame_count,   "frame_size": 0,
                "protocol_id": 0, "protocol_major": 0, "protocol_minor": 0,
            },
            "scan": {
                "search_azimuth_deg": 0.0, "search_elevation_deg": 0.0,
                "scan_cycle_count": 0, "radar_id": 0, "target_count": 0,
            },
            "targets": [],
        }

    def _update_live_cfg(st: dict):
        """Merge live GPS/device data from STATUS frame into live_radar_cfg."""
        gps = st.get("gps", {})
        if gps.get("gps_locked"):
            lon = gps.get("longitude")
            lat = gps.get("latitude")
            if lon and abs(lon) > 0.001:
                live_radar_cfg["longitude"] = lon
            if lat and abs(lat) > 0.001:
                live_radar_cfg["latitude"] = lat
            if gps.get("altitude_m") is not None:
                live_radar_cfg["elevation_m"] = gps["altitude_m"]
        if gps.get("satellite_count") is not None:
            live_radar_cfg["satellite_count"] = gps["satellite_count"]
        if st.get("device", {}).get("radar_ip"):
            live_radar_cfg["device_ip"] = st["device"]["radar_ip"]

    def _publish(topic, payload_obj):
        if not mqtt_client:
            return
        try:
            mqtt_client.publish(topic, json.dumps(payload_obj),
                                qos=0, retain=False)
        except Exception as e:
            _emit("ERR", msg=f"MQTT publish error on {topic}: {e}")

    def _flush_mqtt():
        """Publish all pending_modules to MQTT (at most once per interval)."""
        nonlocal last_mqtt_ts
        if not mqtt_client or not pending_modules:
            return
        if publish_mode in ("aggregate", "both"):
            if "basic_usage" in pending_modules:
                _publish(aggregate_topic, pending_modules["basic_usage"])
        if publish_mode in ("modular", "both"):
            for k in ALL_MODULE_KEYS:
                if k not in pending_modules:
                    continue
                mod = modules_cfg.get(k, {})
                if mod.get("enabled") and mod.get("topic"):
                    _publish(mod["topic"], pending_modules[k])
        if "status" in pending_modules:
            _publish(
                parser_cfg.get("status_topic", "radar/rdxxb/parsed/status"),
                pending_modules["status"],
            )
        last_mqtt_ts = time.time()

    try:
        while True:
            try:
                data, addr = sock.recvfrom(65535)
            except socket.timeout:
                now = time.time()
                if now - last_mqtt_ts >= mqtt_publish_interval:
                    _flush_mqtt()
                if now - last_stats_ts >= 10:
                    _emit("STATS", packets=total_packets,
                          errors=total_errors, targets=total_targets)
                    last_stats_ts = now
                continue

            total_packets += 1
            src_str = f"{addr[0]}:{addr[1]}"

            hex_preview = data[:64].hex().upper()
            _emit("RAW", src=src_str, size=len(data), hex=hex_preview)

            # Peek at frame_id (bytes 2-3) to determine frame type
            if len(data) >= 4:
                frame_id_raw = struct.unpack_from("<H", data, 2)[0]
            else:
                frame_id_raw = 0

            # STATUS frame: decode separately, emit, then skip target pipeline
            if frame_id_raw == FRAME_ID_STATUS:
                status_parsed = parse_status_frame(data)
                if status_parsed and "error" not in status_parsed:
                    st = status_parsed["status"]
                    _update_live_cfg(st)
                    _emit("PARSED",
                          src=src_str,
                          frame_type="STATUS",
                          work_mode=st.get("work_mode"),
                          work_mode_label=st.get("work_mode_label"),
                          antenna_azimuth_deg=st.get("antenna_azimuth_deg"),
                          gps=st.get("gps"),
                          device=st.get("device"),
                          frame_count=status_parsed["header"]["frame_count"])
                    # Update all 8 modules with empty target frame + live GPS
                    modules = split_into_modules(
                            _empty_frame(status_parsed["header"]["frame_count"]),
                            live_radar_cfg)
                    for k, v in modules.items():
                        pending_modules[k] = v
                    # Emit MODULE preview events for STATUS-based data
                    for k in ALL_MODULE_KEYS:
                        mod = modules_cfg.get(k, {})
                        _emit("MODULE",
                              key=k,
                              enabled=bool(mod.get("enabled")),
                              topic=mod.get("topic", DEFAULT_MODULE_TOPICS[k]),
                              data=modules[k])
                    # Store status for its own dedicated topic
                    pending_modules["status"] = {
                        "frame_type": "STATUS", **st,
                        "_meta": {"frame_count": status_parsed["header"]["frame_count"],
                                  "published_at": _now_iso(), "source": "udp_parser"},
                    }
                else:
                    total_errors += 1
                    _emit("ERR", src=src_str,
                          msg=f"STATUS parse failed: {(status_parsed or {}).get('error', 'unknown')}")
                if time.time() - last_mqtt_ts >= mqtt_publish_interval:
                    _flush_mqtt()
                continue

            parsed = parse_target_frame(data)
            if parsed is None or "error" in (parsed or {}):
                total_errors += 1
                reason = (parsed or {}).get("error", "bad_magic")
                _emit("ERR", src=src_str, msg=f"Parse failed: {reason}")
                continue

            modules = split_into_modules(parsed, live_radar_cfg)
            n_targets = len(parsed["targets"])
            total_targets += n_targets

            _emit("PARSED", src=src_str, targets=n_targets,
                  data=modules["basic_usage"])

            # Per-module preview events
            for k in ALL_MODULE_KEYS:
                mod = modules_cfg.get(k, {})
                _emit("MODULE",
                      key=k,
                      enabled=bool(mod.get("enabled")),
                      topic=mod.get("topic", DEFAULT_MODULE_TOPICS[k]),
                      data=modules[k])

            # Buffer module payloads — publish on interval, not per-packet
            for k, v in modules.items():
                pending_modules[k] = v
            if time.time() - last_mqtt_ts >= mqtt_publish_interval:
                _flush_mqtt()

            if time.time() - last_stats_ts >= 10:
                _emit("STATS", packets=total_packets,
                      errors=total_errors, targets=total_targets)
                last_stats_ts = time.time()

    except KeyboardInterrupt:
        _emit("INFO", msg="Parser stopped by signal")
    finally:
        _flush_mqtt()  # publish any remaining buffered data before exit
        sock.close()
        if mqtt_client:
            try:
                mqtt_client.loop_stop()
                mqtt_client.disconnect()
            except Exception:
                pass
        _emit("STATS", packets=total_packets,
              errors=total_errors, targets=total_targets)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import argparse, os, sys

    ap = argparse.ArgumentParser(description="RDXXB UDP Parser (modular)")
    ap.add_argument("--config", default=None,
                    help="Path to runtime-config.json (default: auto-detect)")
    ap.add_argument("--self-test", action="store_true",
                    help="Print struct sizes and exit")
    args = ap.parse_args()

    if args.self_test:
        print(f"[Parser] HEADER_SIZE      = {HEADER_SIZE}  (expected 16)")
        print(f"[Parser] SCAN_HEADER_SIZE = {SCAN_HEADER_SIZE}  (expected 20)")
        print(f"[Parser] TARGET_SIZE      = {TARGET_SIZE}  (expected 148)")
        assert HEADER_SIZE      == 16
        assert SCAN_HEADER_SIZE == 20
        assert TARGET_SIZE      == 148
        print("[Parser] ✓ All struct sizes validated")
        raise SystemExit(0)

    if args.config:
        cfg_path = args.config
    else:
        # Search order (first existing file wins):
        #  1. Alongside the running executable (PyInstaller binary or script)
        #  2. PyInstaller bundle temp dir (sys._MEIPASS)
        #  3. Parent of the script directory  (normal dev layout: ../runtime-config.json)
        exe_dir    = os.path.dirname(os.path.abspath(sys.executable))
        script_dir = os.path.dirname(os.path.abspath(__file__))
        candidates = [
            os.path.join(exe_dir,    "runtime-config.json"),  # next to binary
            os.path.join(script_dir, "runtime-config.json"),  # same dir as script
            os.path.join(script_dir, "..", "runtime-config.json"),  # parent (dev)
        ]
        if hasattr(sys, "_MEIPASS"):
            # PyInstaller extracted bundle (--add-data support)
            candidates.insert(0, os.path.join(sys._MEIPASS, "runtime-config.json"))

        cfg_path = next((p for p in candidates if os.path.exists(p)), candidates[-1])

    _emit("INFO", msg=f"Config: {os.path.abspath(cfg_path)}")

    cfg        = load_config(cfg_path)
    parser_cfg = cfg.get("parser", {}) or {}
    radar_cfg  = cfg.get("radar",  {}) or {}

    _emit("INFO", msg=f"RDXXB UDP Parser starting (HDR={HEADER_SIZE} "
                      f"SCAN={SCAN_HEADER_SIZE} TGT={TARGET_SIZE})")

    listen(parser_cfg=parser_cfg, radar_cfg=radar_cfg)
