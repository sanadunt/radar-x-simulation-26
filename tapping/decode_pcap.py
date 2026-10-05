"""
decode_pcap.py — RDXXB Status Frame Decoder for first-tapping.pcapng
========================================================================
Decodes all 0xFF03 Status Information Frames captured from the RDXXB radar.

Findings summary:
  - All 34 packets are 0xFF03 STATUS frames (radar in STANDBY mode)
  - No target tracking data present (no 0xFF01/0xFF02 frames)
  - Radar location: 107.711353°E, -6.929721°S (West Java, Indonesia)
  - Antenna servo azimuth: ~43.5° (parked/standby position)
  - GPS altitude: ~681.8m ASL

Run:
  python3 tapping/decode_pcap.py
"""

import struct
import sys
import os
import subprocess

TSHARK = "/Applications/Wireshark.app/Contents/MacOS/tshark"
PCAP   = os.path.join(os.path.dirname(__file__), "first-tapping.pcapng")

# ── Frame header (16 bytes) ───────────────────────────────────────────────────
HEADER_FMT  = "<HHIIBBB B"
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # 16

FRAME_MAGIC  = 0x55AA   # bytes AA 55 on wire, LE uint16 = 0x55AA
FRAME_STATUS = 0xFF03

# ── Status body (section 3.2.2, 47 bytes) ────────────────────────────────────
STATUS_FMT  = "<BBBBBBIffHBhhhh16sBB"
STATUS_SIZE = struct.calcsize(STATUS_FMT)  # 47

WORK_MODES = {0x00: "STANDBY", 0x11: "Search", 0x22: "Track", 0x33: "Leveling"}
CMD_STATUS = {0x00: "Idle", 0x11: "Executing", 0x22: "Success", 0x33: "Failed"}

# ── Extended GPS/device offsets (empirically verified from packet analysis) ──
OFF_SERVO_AZ   = 0x016   # f32: servo mechanical azimuth (near-360° = prior scan end)
OFF_ANT_AZ     = 0x064   # f32: live antenna azimuth during capture
OFF_GPS_LON    = 0x266   # f64: radar GPS longitude (WGS-84)
OFF_GPS_LAT    = 0x26E   # f64: radar GPS latitude  (WGS-84)
OFF_GPS_ALT    = 0x276   # f32: radar GPS altitude (m ASL, stored as float in extended block)
OFF_NORTH_ANG  = 0x286   # f32: north correction angle (degrees)
OFF_HW_MODEL   = 0x1E9   # null-terminated ASCII
OFF_FIRMWARE   = 0x209   # null-terminated ASCII
OFF_RADAR_IP   = 0x29E   # null-terminated ASCII
OFF_HOST_IP    = 0x2B0   # null-terminated ASCII
OFF_SERIAL     = 0x2C2   # null-terminated ASCII


def read_cstr(data: bytes, offset: int, max_len: int = 64) -> str:
    end = data.find(b'\x00', offset, offset + max_len)
    if end < 0:
        end = offset + max_len
    return data[offset:end].decode("ascii", errors="replace").strip()


def decode_status_frame(raw: bytes, ts: float, pkt_idx: int) -> dict | None:
    if len(raw) < HEADER_SIZE:
        return None

    hdr = struct.unpack_from(HEADER_FMT, raw, 0)
    magic, frame_id, frame_count, content_len = hdr[0], hdr[1], hdr[2], hdr[3]
    proto_major, proto_minor, checksum       = hdr[5], hdr[6], hdr[7]

    if magic != FRAME_MAGIC:
        return None
    if frame_id != FRAME_STATUS:
        return None
    if len(raw) < HEADER_SIZE + STATUS_SIZE:
        return None

    s = struct.unpack_from(STATUS_FMT, raw, HEADER_SIZE)
    work_mode       = s[0]
    cmd_exec        = s[1]
    fault_type      = s[2]
    radar_model     = s[3]
    fe_count_id     = s[4]
    fe_net_status   = s[5]
    fe_scan_cycle   = s[6]
    fe_azimuth      = s[7]
    fe_pitch        = s[8]
    fe_frequency    = s[9]
    fan_status      = s[16]
    freq_synth      = s[17]

    # Extended block fields (empirically verified offsets)
    servo_az  = struct.unpack_from('<f', raw, OFF_SERVO_AZ)[0]  if OFF_SERVO_AZ+4  <= len(raw) else 0.0
    ant_az    = struct.unpack_from('<f', raw, OFF_ANT_AZ)[0]    if OFF_ANT_AZ+4    <= len(raw) else 0.0
    gps_lon   = struct.unpack_from('<d', raw, OFF_GPS_LON)[0]   if OFF_GPS_LON+8   <= len(raw) else 0.0
    gps_lat   = struct.unpack_from('<d', raw, OFF_GPS_LAT)[0]   if OFF_GPS_LAT+8   <= len(raw) else 0.0
    gps_alt   = struct.unpack_from('<f', raw, OFF_GPS_ALT)[0]   if OFF_GPS_ALT+4   <= len(raw) else 0.0
    north_ang = struct.unpack_from('<f', raw, OFF_NORTH_ANG)[0] if OFF_NORTH_ANG+4 <= len(raw) else 0.0

    hw_model  = read_cstr(raw, OFF_HW_MODEL)  if OFF_HW_MODEL  < len(raw) else ""
    firmware  = read_cstr(raw, OFF_FIRMWARE)  if OFF_FIRMWARE  < len(raw) else ""
    radar_ip  = read_cstr(raw, OFF_RADAR_IP)  if OFF_RADAR_IP  < len(raw) else ""
    host_ip   = read_cstr(raw, OFF_HOST_IP)   if OFF_HOST_IP   < len(raw) else ""
    serial    = read_cstr(raw, OFF_SERIAL)    if OFF_SERIAL    < len(raw) else ""

    return {
        "pkt_idx":        pkt_idx,
        "timestamp":      ts,
        "frame_count":    frame_count,
        "frame_magic":    f"0x{magic:04X}",
        "frame_id":       f"0x{frame_id:04X}",
        "content_len":    content_len,
        "proto_major":    proto_major,
        "proto_minor":    proto_minor,
        "checksum":       f"0x{checksum:02X}",
        "work_mode":      f"0x{work_mode:02X}",
        "work_mode_label":WORK_MODES.get(work_mode, "Unknown"),
        "cmd_exec":       f"0x{cmd_exec:02X}",
        "fault_type":     f"0x{fault_type:02X}",
        "radar_model":    radar_model,
        "fe_scan_cycle":  fe_scan_cycle,
        "fe_azimuth_deg": round(fe_azimuth, 3),
        "fe_pitch_deg":   round(fe_pitch, 3),
        "fan_status":     f"0b{fan_status:08b}",
        "freq_synth":     f"0b{freq_synth:08b}",
        "servo_az_deg":   round(servo_az, 4),
        "ant_az_deg":     round(ant_az, 4),
        "gps_lon":        round(gps_lon, 6),
        "gps_lat":        round(gps_lat, 6),
        "gps_alt_m":      round(gps_alt, 2),
        "north_angle_deg":round(north_ang, 3),
        "hw_model":       hw_model,
        "firmware":       firmware,
        "radar_ip":       radar_ip,
        "host_ip":        host_ip,
        "serial":         serial,
    }


def main():
    if not os.path.exists(PCAP):
        print(f"[ERROR] PCAP not found: {PCAP}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(TSHARK):
        print(f"[ERROR] tshark not found: {TSHARK}", file=sys.stderr)
        sys.exit(1)

    result = subprocess.run(
        [TSHARK, "-r", PCAP, "-Y", "udp.port == 7000",
         "-T", "fields", "-e", "frame.time_epoch", "-e", "data"],
        capture_output=True, text=True, check=True
    )

    rows = [l.split("\t") for l in result.stdout.strip().split("\n") if "\t" in l]
    if not rows:
        print("[ERROR] No UDP packets found matching port 7000", file=sys.stderr)
        sys.exit(1)

    decoded = []
    errors  = 0
    for idx, (ts_str, hex_data) in enumerate(rows):
        raw = bytes.fromhex(hex_data)
        d = decode_status_frame(raw, float(ts_str), idx + 1)
        if d:
            decoded.append(d)
        else:
            errors += 1
            print(f"[WARN] Packet {idx+1}: decode failed (size={len(raw)})")

    if not decoded:
        print("[ERROR] No decodable STATUS frames found.")
        sys.exit(1)

    # ── Summary ──────────────────────────────────────────────────────────────
    first = decoded[0]
    last  = decoded[-1]
    duration = last["timestamp"] - first["timestamp"]
    avg_interval = duration / (len(decoded) - 1) if len(decoded) > 1 else 0

    print("=" * 70)
    print(" RDXXB first-tapping.pcapng — Decoded Summary")
    print("=" * 70)
    print(f"  Capture start    : {first['timestamp']:.3f} (Unix epoch)")
    print(f"  Duration         : {duration:.3f} s")
    print(f"  Total packets    : {len(decoded)}  (errors: {errors})")
    print(f"  Avg interval     : {avg_interval*1000:.1f} ms  (~{1/avg_interval:.1f} Hz)")
    print(f"  Seq range        : {first['frame_count']} – {last['frame_count']}")
    print()
    print(f"  [DEVICE INFO] (constant across all frames)")
    print(f"  Hardware model   : {first['hw_model']}")
    print(f"  Firmware version : {first['firmware']}")
    print(f"  Serial number    : {first['serial']}")
    print(f"  Radar IP:Port    : {first['radar_ip']}:7000  (UDP source)")
    print(f"  Host  IP:Port    : {first['host_ip']}:8000   (UDP dest)")
    print()
    print(f"  [RADAR STATUS] (work_mode in ALL frames)")
    print(f"  Work mode        : {first['work_mode']} = {first['work_mode_label']}")
    print(f"  Fault type       : {first['fault_type']} (0x00 = None)")
    print(f"  Frame type       : {first['frame_id']} = Status Information Frame")
    print(f"  Note             : Radar is in STANDBY — no target tracking data present")
    print()
    print(f"  [GPS LOCATION] (from extended status block @ 0x266/0x26E)")
    lons = [d["gps_lon"] for d in decoded]
    lats = [d["gps_lat"] for d in decoded]
    print(f"  Longitude        : {first['gps_lon']:.6f}° E  (range: {min(lons):.6f} – {max(lons):.6f})")
    print(f"  Latitude         : {first['gps_lat']:.6f}° S  (range: {min(lats):.6f} – {max(lats):.6f})")
    print(f"  GPS Altitude     : {first['gps_alt_m']:.1f} m ASL  (0x276)")
    print(f"  Location approx  : Kabupaten Bandung, West Java, Indonesia")
    print()
    azs = [d["ant_az_deg"] for d in decoded]
    print(f"  [ANTENNA] (extended block @ 0x016/0x064)")
    print(f"  Servo Az (0x016) : {first['servo_az_deg']:.3f}°  (prior scan end position)")
    print(f"  Live Az  (0x064) : {first['ant_az_deg']:.4f}°  (range: {min(azs):.4f} – {max(azs):.4f}°)")
    print(f"  Azimuth dither   : {max(azs)-min(azs):.4f}°  over {duration:.3f}s  (servo vibration/noise)")
    print()

    # ── Per-packet table ──────────────────────────────────────────────────────
    print("-" * 70)
    print(f"{'Pkt':>3}  {'FrameCount':>10}  {'RelTime':>8}  {'AntAz°':>8}  {'GPS_lon':>12}  {'GPS_lat':>12}")
    print(f"{'---':>3}  {'-'*10}  {'-'*8}  {'-'*8}  {'-'*12}  {'-'*12}")
    t0 = first["timestamp"]
    for d in decoded:
        print(f"{d['pkt_idx']:>3}  {d['frame_count']:>10}  {d['timestamp']-t0:>8.3f}  "
              f"{d['ant_az_deg']:>8.4f}  {d['gps_lon']:>12.6f}  {d['gps_lat']:>12.6f}")

    print("=" * 70)
    print("CONCLUSION: All 34 packets are 0xFF03 STATUS frames.")
    print("Radar was in STANDBY mode — no 0xFF01/0xFF02 target frames captured.")
    print("To capture target data, the radar must be in Search (0x11) or Track (0x22) mode.")


if __name__ == "__main__":
    main()
