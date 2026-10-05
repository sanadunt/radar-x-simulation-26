# RDXXB Radar Protocol Iteration & Mapping Documentation

This document provides a comprehensive iteration of the RDXXB Radar UDP Protocol and its mapping to the Modular JSON Schema. This serves as the technical foundation for developing the simulation and data conversion layers.

## 1. Universal UDP Frame Wrapper (16 Bytes)

Every UDP frame starts with this header.

| Offset | Field Name | Type | Size | Description |
| :--- | :--- | :--- | :--- | :--- |
| 0 | `frame_header` | uint16 | 2 | Magic bytes: `0x55AA` |
| 2 | `frame_id` | uint16 | 2 | Frame type (e.g., `0xFF02` for Search) |
| 4 | `frame_count` | uint32 | 4 | Monotonic counter |
| 8 | `content_length` | uint32 | 4 | Size of `frame_content` (n) |
| 12 | `protocol_id` | uint8 | 1 | Radar ID (1-8) |
| 13 | `protocol_major`| uint8 | 1 | Major version (default 2) |
| 14 | `protocol_minor`| uint8 | 1 | Minor version (default 13/14) |
| 15 | `checksum` | uint8 | 1 | Sum of all bytes EXCEPT `frame_header` (LSB) |

---

## 2. Frame Type Content Breakdown

### 2.1 Mode Command Frame (0xFF00) - [Display -> Radar]
Used to set operating modes: Standby (0x00), Search (0x11), Track (0x22), Leveling (0x33).
*   **Search/Standby Fields**: Includes frequency, silent zones, compensations, scan cycle, servo mode, GPS location, and height/speed filters.
*   **Tracking Fields**: Replaces most fields with `track_action` (Enter/Cancel) and `target_count` (fixed at 1).

### 2.2 Status Information Frame (0xFF03) - [Radar -> Display]
Transmitted every 200ms.
*   **Key Fields**: `work_mode`, `cmd_exec_status`, `fault_type`, `frontend1_azimuth/pitch`, `fan_status`, `freq_synth_status`.

### 2.3 Search (0xFF02) & Tracking (0xFF01) Target Frames - [Radar -> Display]
Variable length: Header (20 bytes) + N * Target Record (148 bytes).
*   **Header**: `search_azimuth`, `search_elevation`, `scan_cycle`, `pulse_group_id`, `target_count`.
*   **Tracking Difference**: `target_count` is fixed at 1 for 0xFF01.

---

## 3. Per-Target Record Detail (148 Bytes)

Each target in a Search or Track frame uses this structure.

| Field | Type | Size | Scaling/Notes |
| :--- | :--- | :--- | :--- |
| `track_delete_flag` | uint16 | 2 | 0x00=Active, 0x01=Deleted |
| `track_id` | uint16 | 2 | 0 - 10000 |
| `loss_count` | uint16 | 2 | Consecutive losses |
| `update_time` | uint32 | 4 | Pulse group units |
| `energy` | float | 4 | Signal strength |
| `credit_ratio` | float | 4 | Quality score |
| `speed` | float | 4 | Radial speed (m/s) |
| `distance` | float | 4 | Slant range (m) |
| `azimuth` | float | 4 | 0-360 deg |
| `pitch` | float | 4 | Elevation deg |
| `height` | float | 4 | Meters |
| `track_type` | uint8 | 1 | 0x20=Drone, 0x11=Person, etc. |
| `attributes` | uint8 | 1 | Bit-field |
| `radar_id` | uint8 | 1 | 1-8 |
| `longitude/latitude`| double | 8 | WGS-84 (6 decimals) |
| `altitude_gps` | double | 8 | Meters |
| `vx / vy / vz` | float | 4 | ENU Velocity (m/s) |
| `utc_timestamp` | mixed | 7 | Year(2), Mon(1), Day(1), Hour(1), Min(1), Sec(1) |
| `utc_millisecond` | uint8 | 1 | Value * 10 = actual ms |
| `confidence` | uint8 | 1 | Value * 0.01 = ratio |

---

## 4. JSON Schema Mapping Logic

The protocol is designed to be mapped into the following JSON modules:

1.  **Frame Metadata**: Maps Universal Wrapper + derived fields.
2.  **Radar Location & Status**: Maps 0xFF03 Status Frame + 0xFF00 GPS fields.
3.  **Radar Configuration**: Maps 0xFF00 Mode Command filters and settings.
4.  **Radar Health**: Maps 0xFF03 specific status bits (Fans, Power, Thermals).
5.  **Scan Header**: Maps 0xFF01/0xFF02 Header.
6.  **Track Data**: Maps 148-byte Target Record (Core measurements).
7.  **Track Metadata**: Maps 148-byte Target Record (Age, UTC, ID).

---

## 5. Critical Conversion Rules

1.  **Endianness**: All multi-byte integers/floats are **Little-Endian**.
2.  **Angular Scaling**: Integer angular fields (in commands) use `Value * 0.1` for degrees.
3.  **Speed Scaling**: Integer speed fields use `Value * 0.1` for m/s.
4.  **Time**: `utc_millisecond` (0-99) maps to `0-990ms`.
5.  **Checksum**:
    ```c
    uint8_t checksum = 0;
    for (int i = 2; i < frame_total_size; i++) {
        if (i == 15) continue; // Skip checksum field itself during calculation? 
        // Note: Docs say "all bytes EXCEPT the 2-byte frame_header". 
        // This implies bytes 2 through end.
        checksum += frame_data[i];
    }
    ```
6.  **Coordinate System**: ENU (East-North-Up) for velocity; WGS-84 for geodetic.

## 6. Target Classification Codes (Hex)
*   `0x00`: Unknown
*   `0x11`: Person
*   `0x12`: Car
*   `0x20`: Drone (High Priority)
*   `0x24`: Bird
*   `0x31`: Vessel
*   `0x41`: False Target
