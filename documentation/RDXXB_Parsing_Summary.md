---
title: "RDXXB Parsing — SUPER LENGKAP"
created: 2026-06-09
---

# RDXXB Parsing — SUPER LENGKAP

Dokumen ini merangkum secara lengkap struktur frame RDXXB yang kita temui di capture, cara parser (`parser/parser.py`) memprosesnya, hasil statistik parsing pada sample PCAP (`Target Banyak.pcapng` via `/tmp/targetbanyak_grep.txt`), serta keputusan desain parser (validation, leniency, caching) dan rekomendasi integrasi.

Catatan: file ini dibuat otomatis dari analisis lokal. Paths relevan:
- Parser: `parser/parser.py`
- Runtime config: `runtime-config.json`
- PCAP-derived payloads: `/tmp/targetbanyak_grep.txt`

---

## 1. Tujuan

- Dokumentasi format frame RDXXB (header, scan header, target record)
- Menjelaskan bagaimana parser menafsirkan tiap field (indeks struct)
- Menyajikan hasil analisis statistik pada sample capture
- Menjelaskan kebijakan validasi (lenient vs strict) dan handling special cases (checksum, corrupted fields)
- Menjelaskan modul JSON yang diterbitkan ke MQTT dan contoh payload
- Rekomendasi konfigurasi dan next steps

---

## 2. Ringkasan hasil analisis (sample)

- Total UDP payloads (baris dalam `/tmp/targetbanyak_grep.txt`): **1912**
- Frame length distribution (bytes):
  - 36B: 1835 (hanya header + scan header)
  - 184B: 25
  - 332B: 3
  - 746B: 49 (teridentifikasi sebagai STATUS frames — bukan SEARCH)
- Frames dengan magic/header RDXXB valid: **1912**
- SEARCH/TRACK frames: **1863** (STATUS: 49)
- Frames yang menyatakan ada target tapi tidak membawa payload target (declared but no payload): **1835** (umumnya 36B frames dengan declared target_count sangat besar seperti 63788 tetapi `available_bytes == 0`)
- Frames yang benar-benar memiliki ruang target (max_targets_possible > 0): **28**
- Total target records yang dapat diperiksa: **31**
- Setelah kebijakan lenient (invalid confidence dikonversi menjadi `null` dan dipublish sebagai 0), total targets yang diterbitkan: **31**
- Targets dengan raw `confidence` byte > 100 (invalid): **17** → sekarang ditandai dan `confidence` diset ke `null` (dikirim sebagai `0` untuk kompatibilitas)
- Track type labels observed: semua parsed targets memiliki `track_type_label = "unknown"` (tidak cocok dengan `TYPE_LABELS` mapping saat ini)
- Unique track IDs parsed: **4** (banyak record memakai ID = 0)

---

## 3. RDXXB Frame Layout (yang parser pakai)

Semua decoding mengikuti struktur `parser/parser.py`.

### 3.1 Universal frame header (16 bytes)

Struct format: `HEADER_FMT = "<HHIIBBB B"` (16 bytes)

- bytes 0-1: `frame_header` (uint16 LE) — expected magic `0x55AA`
- bytes 2-3: `frame_id` (uint16) — e.g. `0xFF02` = SEARCH, `0xFF01` = TRACK, `0xFF03` = STATUS
- bytes 4-7: `frame_count` (uint32)
- bytes 8-11: `content_length` (uint32)
- byte 12: `protocol_id` (uint8)
- byte 13: `protocol_major` (uint8)
- byte 14: `protocol_minor` (uint8)
- byte 15: `checksum` (uint8) — parser currently **does not reject** frames by checksum (see §5)

Parser returns header fields as `parsed['header']`.

### 3.2 Scan header (20 bytes)

Struct format: `SCAN_HEADER_FMT = "<ffIHH4s"` (20 bytes)

- float32: `search_azimuth_deg` (deg) — antena azimuth, usually 0–360
- float32: `search_elevation_deg` (deg)
- uint32: `scan_cycle_count`
- uint16: `pulse_group_id`
- uint16: `target_count` (declared)
- 4 bytes spare

Parser maps these into `parsed['scan']` keys: `search_azimuth_deg`, `search_elevation_deg`, `scan_cycle_count`, `pulse_group_id`, `target_count`.

Note: many frames in the sample declare a `target_count` that is clearly bogus (large integers) but do not include the target payload bytes.

### 3.3 Per-target record (148 bytes)

Struct format in parser: `TARGET_FMT` (148 bytes) — unpacked into a tuple `f`

Key fields extracted by index (as implemented in `parse_target_record`):

- `delete_flag` = f[0] (uint16) — representation as hex string in output
- `track_id` = f[1] (uint16)
- `loss_count` = f[2]
- `loss_reason` = f[3]
- `update_time` = f[4]
- `energy` = f[5] (float)
- `credit_ratio` = f[6] (float)
- `radial_speed` = f[7] (float)
- `distance_m` = f[8] (float)
- `azimuth_deg` = f[9] (float)
- `elevation_pitch_deg` = f[10] (float)
- `height_m` = f[11] (float)
- `track_type` = f[12] (byte) — maps via `TYPE_LABELS` to label (e.g. `0x20`→drone) if known
- `radar_id` = f[14]
- `track_point_count` = f[16]
- geodetic coordinates: `longitude` = f[17], `latitude` = f[18], `altitude_gps` = f[19]
- velocity ENU: `vx_east_ms` = f[20], `vy_north_ms` = f[21], `vz_up_ms` = f[22]
- `envelope_point_count` = f[24]
- UTC timestamp fields: `utc_year` = f[26], `utc_month` = f[27], `utc_day` = f[28], `utc_hour` = f[29], `utc_minute` = f[30], `utc_second` = f[31], `utc_ms_raw` = f[32] (×10 ms)
- `raw_confidence_byte` = f[34] (0–255)

Parser builds `ParsedTarget` with:
- `confidence` = round(raw_confidence_byte * 0.01, 2)  (value 0.00–2.55 possible)
- Normalized floats for vx/vy/vz, lat/lon rounding to suitable precision

If a target record appears truncated (not enough bytes), parser skips it gracefully.

---

## 4. Validation rules implemented

Parser supports two validation modes:

- **LENIENT (default, production)** — accept most frames and only reject *obviously* impossible/truncated data. Rules include:
  - Distance: must be 0 ≤ d ≤ 1,000,000 m (1,000 km)
  - Confidence: must be 0 ≤ c ≤ 1; if outside this range, parser marks `confidence_valid=False` and *accepts* the target but will nullify the `confidence` and record parsing issue. For MQTT output we map null -> `0` (integration requested this)
  - Speed per axis: reject only if abs(v) > 1000 m/s (extreme garbage)
  - Altitude: accept up to ±1e9 m; reject beyond as binary garbage

- **STRICT (testing)** — tight ranges (distance ≤ 500 km, speed ≤ 500 m/s, lat/lon in valid ranges) — used only for debugging/QA

Other rules:
- Checksum validation currently disabled (always returns True) because captured PCAP frames did not match any known checksum algorithm — would lead to heavy false negatives. Parser records `checksum_valid` flag in `frame_metadata` but does not drop frames.

Rationale: real-world radar captures are noisy; strict checksum + strict ranges rejected large portion of frames; field-level sanitization and lenient acceptance yields more usable telemetry while flagging potential corrupt fields.

---

## 5. Parser behavior and architecture

- UDP listener: `listen(parser_cfg, radar_cfg)` binds UDP port (default from `runtime-config.json`) and loops reading packets (socket timeout 2s).
- For STATUS frames (`0xFF03`): parse separately and update `live_radar_cfg` with GPS/device info; these also populate module outputs (even when no targets present).
- For SEARCH/TRACK (`0xFF02` / `0xFF01`): parse header, scan header, then parse up to `to_parse = min(declared_targets, max_targets_possible)` target records.
- Module builders: `split_into_modules()` -> builds these modules:
  - `basic_usage`
  - `frame_metadata`
  - `radar_location`
  - `radar_config`
  - `radar_health`
  - `scan_header`
  - `track_data`
  - `track_metadata`

- MQTT publishing: buffered per module (`pending_modules`) and flushed every `mqtt_publish_interval` seconds (default 1.0s). Parser publishes per-module topics in modular mode.

---

## 6. New features & choices made (from recent changes)

1. Confidence handling: if raw confidence byte produces value outside [0,1], parser now:
   - sets `ParsedTarget.confidence = None` (internal)
   - sets `ParsedTarget.confidence_valid = False`
   - appends `"invalid_confidence=..."` to `ParsedTarget.parsing_issues`
   - when building `track_data` for MQTT, the `classification.confidence` is set to `0` (integration request), and `classification.confidence_valid` and `classification.parsing_issues` are included so consumers can detect unreliable confidence.

2. Track retention cache:
   - Parser keeps an in-memory `TRACK_STORE` mapping `track_id -> {target, last_seen_ts}`.
   - Default retention `TRACK_RETENTION_S = 30.0` seconds (configurable via `parser.track_retention_s` in `runtime-config.json`).
   - When building module payloads, parser publishes current frame's targets plus cached targets whose `last_seen_ts` ≤ retention. This prevents tracks from disappearing immediately when a frame no longer contains them.
   - Each cached target keeps its original `unix_timestamp` (last seen timestamp), so published timestamp represents the last valid detection.

3. `track_data` module now includes additional classification fields for integration:
   - `classification.confidence_valid` (bool)
   - `classification.parsing_issues` (array)

---

## Field → Modular JSON mapping

Berikut peta ringkas: field yang dihasilkan parser dan modul JSON mana yang menerima data tersebut.

- `basic_usage`:
  - `source` ("udp"), `recv_bytes`, `recv_at` (ISO), `parse_duration_ms`, `parse_result` ("ok"/"partial"/"error"), `raw_hex` (opsional)

- `frame_metadata`:
  - header fields: `frame_header`, `frame_id`, `frame_count`, `content_length`, `protocol_id`, `protocol_major`, `protocol_minor`, `checksum` / `checksum_valid`, `raw_length`, `parse_time`, `parsing_issues` (frame-level)

- `scan_header`:
  - `search_azimuth_deg`, `search_elevation_deg`, `scan_cycle_count`, `pulse_group_id`, `declared_target_count`, `parsed_target_count`, `max_targets_possible`

- `radar_location`:
  - GPS/servo/status info from STATUS or scan: `gps.longitude`, `gps.latitude`, `gps.elevation_m`, `servo.current_azimuth_deg`, `servo.current_pitch_deg`, `device_id`, `device_label`

- `radar_config`:
  - protocol/device config fields (when present in STATUS): `radar_id`, `firmware_version`, `detection_settings`, `protocol_version`

- `radar_health`:
  - telemetry from STATUS: `temperature_c`, `supply_voltage_v`, `system_status_flags`, `error_codes` (if present)

- `track_data` (main per-target payload):
  - `targets` (array) — each element includes:
    - `track_id`, `track_identification.track_delete_flag`, `track_identification.track_status`
    - `classification`: `track_type_code`, `track_type_label`, `confidence` (for MQTT: `0` if null internally), `confidence_pct`, `confidence_valid` (bool), `parsing_issues` (array)
    - `polar_coordinates`: `distance_m`, `azimuth_deg`, `elevation_pitch_deg`, `height_m`
    - `geodetic_coordinates`: `longitude`, `latitude`, `altitude_gps`
    - `velocities`: `vx_east_ms`, `vy_north_ms`, `vz_up_ms`
    - `energy`, `credit_ratio`, `radial_speed`, `track_point_count`, `envelope_point_count`
    - `utc_timestamp` (reconstructed), `last_seen_ts`, `source_frame_count`, `radar_id`

- `track_metadata`:
  - per-frame / per-track summary fields: `frame_count`, `published_at`, `number_of_targets`, `declared_target_count`, `parsed_target_count`, `parsing_issues` (frame-level), `track_retention_s`

Catatan singkat:
- `track_data.targets` selalu berupa array (bisa kosong). Parser menyertakan seluruh target yang berhasil di-parse dari satu frame dalam satu publish.
- Untuk kompatibilitas MQTT, `None`/`null` internal pada `confidence` dikirim sebagai `0`, tetapi field `confidence_valid=false` dan `parsing_issues` tetap disertakan sehingga konsumer dapat membedakan nilai yang valid vs yang di-forced-zero.
- `frame_metadata.parsing_issues` menyimpan masalah tingkat frame (mis-declared counts, truncated payload, checksum_mismatch flag jika terdeteksi).
## 7. Sample modular payloads (representative)

Below is a condensed example of what the parser publishes to the `track_data` module (one RDXXB frame). `targets` is an array — all targets from a single frame are included in the same publish.

`track_data` sample (target with nullified confidence; published confidence mapped to `0`):

```json
{
  "targets": [
    {
      "track_id": 0,
      "track": {
        "track_identification": { "track_id": 0, "track_delete_flag": "0x00", "track_status": "active" },
        "classification": {
          "track_type_code": "0x00",
          "track_type_label": "unknown",
          "confidence": 0,
          "confidence_pct": "0%",
          "confidence_valid": false,
          "parsing_issues": ["invalid_confidence=1.85"]
        },
        "polar_coordinates": { "distance_m": 26.87, "azimuth_deg": 3.08 },
        "geodetic_coordinates": { "longitude": -0.0, "latitude": 1.8985e+102 }
      }
    }
  ],
  "_meta": { "frame_count": 14176, "published_at": "2026-06-05T08:32:43.262Z" }
}
```

`radar_location` sample (from STATUS or scan header):

```json
{
  "radar_device": {
    "device_id": 1,
    "device_label": "RDXXB Live",
    "gps": { "longitude": 107.608234, "latitude": -6.897456, "elevation_m": 150 },
    "servo": { "current_azimuth_deg": 4.0, "current_pitch_deg": 0.0 }
  }
}
```

Notes:
- `track_data.targets` is an array; for frames with multiple parsed targets they appear together in the same message. If the frame contains 5 virtual targets, all 5 are in that publish.

---

## 8. How to run the parser and configuration snippets

Start parser (uses auto-detect `runtime-config.json` unless `--config` supplied):

```bash
cd /path/to/repo
python3 parser/parser.py --config runtime-config.json
```

Example `runtime-config.json` relevant fields:

```json
{
  "parser": {
    "udp_host": "0.0.0.0",
    "udp_port": 8000,
    "publish_mode": "modular",
    "mqtt_enabled": true,
    "mqtt_broker": { "host": "127.0.0.1", "port": 1883 },
    "mqtt_publish_interval": 1.0,
    "track_retention_s": 30
  },
  "radar": { /* gps/orientation defaults used for payloads */ }
}
```

---

## 9. Debugging & validation tips

- To inspect parser runtime events, observe stdout (parser prints structured JSON lines): look for events `RAW`, `PARSED`, `MODULE`, `STATS`, `ERR`.
- If MQTT fails, confirm `paho-mqtt` is installed in the parser environment (`pip install paho-mqtt`) and broker details in `runtime-config.json` are reachable.
- For investigating unknown `track_type` values, enable a small debug snippet to log raw `track_type` bytes (parser already exposes `track_type_code` as hex in `track_data`), collect frequency and map to labels if you have device docs.

---

## 10. Recommendations & next steps

1. Keep lenient parsing enabled in production; it increases usable telemetry despite noisy captures.
2. Deliver sample modular payloads (we already exported 5 examples to the repo) to integrator; they can map fields accordingly.
3. Add small UI-side sanitization: ignore lat/lon with magnitudes > 1e7 (likely corrupted) until device docs are available.
4. Add unit tests for `parse_target_record` and `parse_target_frame` (TODO in repo).
5. If you obtain device firmware/protocol docs, implement checksum verification and strict validation mode for lab testing.

---

## Appendix A — Quick stats (raw)

- total_frames: 1912
- frames_with_valid_header: 1912
- search_or_track_frames: 1863
- status_frames: 49
- frame lengths: {36:1835, 184:25, 332:3, 746:49}
- frames_with_possible_targets: 28
- total_targets_examined: 31
- targets_confidence_invalid_raw: 17

---

If you mau (ingin):
- saya bisa simpan file JSON contoh (N frames) di `documentation/samples/` untuk integrator; sebutkan N.
- saya bisa tambahkan unit tests dan CI step untuk parser.

---

File dibuat otomatis: `documentation/RDXXB_Parsing_Summary_SUPER_LENGKAP.md`
