# RDXXB Radar Simulation & Visualization System

A full-stack simulation and visualization platform for the **RDXXB series radar** (model RD01), implementing the official binary UDP protocol as a JSON-over-MQTT pipeline. Designed for development, integration testing, and operator training without physical hardware.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Installation](#4-installation)
5. [Configuration](#5-configuration)
6. [Port Reference & How to Change Ports](#6-port-reference--how-to-change-ports)
7. [Running the System](#7-running-the-system)
8. [Dashboard & Features](#8-dashboard--features)
9. [MQTT Topics & Data Schemas](#9-mqtt-topics--data-schemas)
10. [Parser Module](#10-parser-module)
11. [Project Structure](#11-project-structure)
12. [API Reference](#12-api-reference)
13. [Troubleshooting](#13-troubleshooting)
11. [API Reference](#11-api-reference)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        RDXXB Simulation System                            │
│                                                                            │
│   ┌─────────────┐   MQTT/TCP    ┌───────────────┐   HTTP / REST          │
│   │  Simulator  │──────────────▶│  Webapp       │◀──────────────── User  │
│   │  (Node.js)  │  1883         │  (Express)    │   :3000                │
│   └─────────────┘               │               │                        │
│                                 │  MQTT/WS      │                        │
│   ┌─────────────┐   UDP         │  :9001        │                        │
│   │   Parser    │──────────────▶│               │──▶ Browser (SPA)       │
│   │  (Python)   │  :20202       └───────────────┘                        │
│   └─────────────┘                                                         │
│                                                                            │
│   MQTT Broker (e.g. Mosquitto) must run externally on :1883 / :9001      │
└──────────────────────────────────────────────────────────────────────────┘
```

The system has three independent processes:

| Component | Technology | Role |
|---|---|---|
| **Simulator** | Node.js | Generates synthetic radar targets and publishes 8 schema modules via MQTT TCP |
| **Webapp** | Node.js + Express | Serves the SPA dashboard; manages simulator/parser child processes; provides REST API |
| **Parser** | Python 3 | Decodes raw RDXXB binary UDP frames into JSON (skeleton — see §9) |

A running **MQTT broker** (Mosquitto or compatible) is required as the message bus.

---

## 2. Architecture

### Data Flow

```
Simulator
  │
  ├─ publishes 8 topics → MQTT Broker (TCP :1883)
  │                            │
  │                            └─ MQTT WebSocket (:9001)
  │                                        │
  └────────────────────────────────────────▼
                               Browser (MQTT.js over WS)
                               subscribes to all 8 topics
                               renders live telemetry & map
```

### Simulation Modules (8 topics)

Each module is independently enable/disable-able and publishes to its own MQTT topic:

| Module Key | Topic | Description |
|---|---|---|
| `basic_usage` | `radar/rdxxb/basic` | Radar GPS + flat target list (primary feed) |
| `frame_metadata` | `radar/rdxxb/frame` | Frame header, protocol version, checksum |
| `radar_location` | `radar/rdxxb/location` | Full device info, GPS, servo, frequency |
| `radar_config` | `radar/rdxxb/config` | Silent zones, filters, autonomous ID |
| `radar_health` | `radar/rdxxb/health` | Temperature, currents, voltages, fan/memory |
| `scan_header` | `radar/rdxxb/scan` | Scan azimuth/elevation, pulse group, target count |
| `track_data` | `radar/rdxxb/tracks` | Deeply nested track objects per target |
| `track_metadata` | `radar/rdxxb/track-meta` | Track age, history, loss count, timestamp |

---

## 3. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 18.x | For simulator + webapp |
| **npm** | ≥ 9.x | Bundled with Node.js |
| **Python** | ≥ 3.9 | For the UDP parser |
| **Mosquitto** | ≥ 2.x | MQTT broker (TCP + WebSocket listeners) |

### Installing Mosquitto

**macOS (Homebrew):**
```bash
brew install mosquitto
```

**Ubuntu / Debian:**
```bash
sudo apt update && sudo apt install mosquitto mosquitto-clients
```

**Windows:**
Download the installer from [mosquitto.org/download](https://mosquitto.org/download/).

### Mosquitto Configuration

The broker must listen on **both TCP (port 1883)** and **WebSocket (port 9001)**. Create or edit `/etc/mosquitto/mosquitto.conf` (or the Homebrew equivalent):

```
# TCP listener for simulator & parser
listener 1883
allow_anonymous true

# WebSocket listener for browser
listener 9001
protocol websockets
allow_anonymous true
```

> **Security note:** `allow_anonymous true` is fine for local development. For any shared or production environment, configure username/password authentication and set `allow_anonymous false`. See `config.js` for adding credentials.

**Start the broker:**
```bash
# macOS (Homebrew service)
brew services start mosquitto

# Linux (systemd)
sudo systemctl enable --now mosquitto

# Manual (any OS)
mosquitto -c /path/to/mosquitto.conf -v
```

---

## 4. Installation

### 4.1 Clone the repository

```bash
git clone <repository-url>
cd radar-x-simulation-26
```

### 4.2 Install Node.js dependencies

The repo uses **npm workspaces** — a single install at the root pulls in all sub-packages:

```bash
npm install
```

This installs:
- Root dev dependencies (`concurrently`)
- `simulator/` — `mqtt@^5`
- `webapp/` — `express@^4`

### 4.3 Set up the Python virtual environment

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r parser/requirements.txt  # if it exists, otherwise no extra deps needed
```

> The parser currently only uses Python standard library (`struct`, `json`, `math`, `time`, `dataclasses`). No pip packages are required unless you wire it to a real MQTT library.

### 4.4 Verify the setup

```bash
# Check Node.js
node --version   # should be ≥ 18

# Check npm workspaces
ls simulator/node_modules webapp/node_modules   # both should exist (or be hoisted to root)

# Check Python
python3 --version   # should be ≥ 3.9

# Check MQTT broker is running
mosquitto_pub -h 127.0.0.1 -p 1883 -t test -m hello && echo "Broker OK"
```

---

## 5. Configuration

Runtime settings are read from server-side **`runtime-config.json`** at the project root. This local file is ignored by Git because it may contain broker credentials. The dashboard fetches configuration from `/api/config` while open and saves changes back to this file; the browser does not own the durable copy. `/api/config` returns the full config, including broker credentials, to dashboard users, so production access must be authenticated and served over HTTPS.

### 5.1 `runtime-config.json` structure

```jsonc
{
  // MQTT connection used by the Simulator (TCP)
  "sim_mqtt": {
    "protocol": "mqtt",     // "mqtt" (plain) or "mqtts" (TLS)
    "host": "127.0.0.1",
    "port": 1883,
    "username": "",
    "password": "",
    "topic": "radar/rdxxb/targets"   // legacy fallback topic
  },

  // MQTT connection used by the Browser (WebSocket)
  "display_mqtt": {
    "protocol": "ws",       // "ws" or "wss" (TLS)
    "host": "127.0.0.1",
    "port": 9001,
    "username": "",
    "password": "",
    "topic": "radar/rdxxb/basic"   // default topic for the Monitor tab
  },

  // Radar installation parameters (WGS-84)
  "radar": {
    "longitude": 107.608234,
    "latitude": -6.897456,
    "elevation_m": 150,
    "roll_angle_deg": 0.5,
    "pitch_angle_deg": 1.2,
    "north_correction_angle_deg": 8.5
  },

  // Simulation behaviour
  "simulator": {
    "autoStart": true,         // start the simulator when the webapp starts
    "publishIntervalMs": 5000, // how often each module publishes (ms)
    "targetCount": 5           // number of synthetic targets to generate
  },

  // Individual module enable/disable + topic mapping
  "simulation_modules": {
    "basic_usage":    { "enabled": true, "topic": "radar/rdxxb/basic" },
    "frame_metadata": { "enabled": true, "topic": "radar/rdxxb/frame" },
    "radar_location": { "enabled": true, "topic": "radar/rdxxb/location" },
    "radar_config":   { "enabled": true, "topic": "radar/rdxxb/config" },
    "radar_health":   { "enabled": true, "topic": "radar/rdxxb/health" },
    "scan_header":    { "enabled": true, "topic": "radar/rdxxb/scan" },
    "track_data":     { "enabled": true, "topic": "radar/rdxxb/tracks" },
    "track_metadata": { "enabled": true, "topic": "radar/rdxxb/track-meta" }
  },

  // UDP Parser settings
  "parser": {
    "udp_host": "0.0.0.0",
    "udp_port": 20202,
    "mqtt_enabled": false,
    "mqtt_topic": "radar/rdxxb/parsed"
  },

  // Webapp HTTP port
  "webapp": {
    "port": 3000
  }
}
```

### 5.2 Editing configuration

You can edit `runtime-config.json` directly or use the **Settings** tab in the dashboard. Dashboard changes are persisted to disk through `/api/config`. `simulator.autoStart` defaults to `true` when omitted, including in older config files. Set it to `false` and restart the webapp to disable automatic startup; this does not stop a simulator that is already running. With `NODE_ENV=production`, the server requires both `WEBAPP_AUTH_USER` and `WEBAPP_AUTH_PASSWORD`.

### 5.3 Connecting to a remote MQTT broker

Change both `sim_mqtt` and `display_mqtt` to point to your broker's IP/hostname. If the browser and Node.js processes live on different machines, ensure the `display_mqtt.host` is reachable from the client's browser (not `127.0.0.1`).

### 5.4 Hostinger deployment

For GitHub deployment, set the application root to the repository root containing `package.json` and `server.js`. Select Express if Hostinger detects it; if the framework is set to “Other”, use `server.js` as the entry file. Start the app with `npm start`; there is no separate frontend build command. Hostinger supports Node.js 18, 20, 22, and 24, and the root package declares Node.js 18 or newer.

The server listens on Hostinger's injected `PORT` and falls back to `runtime-config.json`'s `webapp.port` (`3000`). It binds to `0.0.0.0`; visitors use the assigned domain over HTTPS, not the internal app port. Hostinger supports Express Node.js apps on Business and Cloud plans. See its [GitHub deployment guide](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/) and [environment variable settings](https://www.hostinger.com/support/how-to-add-environment-variables-during-node-js-application-deployment/).

Set these values in Hostinger's environment settings:

```text
NODE_ENV=production
WEBAPP_AUTH_USER=<admin-user>
WEBAPP_AUTH_PASSWORD=<long-random-password>
```

The app refuses production startup without both auth values, protects the dashboard and API with HTTP Basic authentication, and rejects state-changing requests marked `cross-site` by `Sec-Fetch-Site` or carrying an `Origin` host that differs from the request host. Authenticated API clients without browser origin metadata remain supported. Enable HTTPS in Hostinger. The dashboard still receives the full runtime config after authentication, so restrict access to trusted admins. For a public MQTT broker, use `mqtts` for `sim_mqtt` and `wss` for `display_mqtt`, with the broker's TLS ports.

`runtime-config.json` must be writable and stored somewhere that survives redeployment. Set `RDXXB_RUNTIME_CONFIG_PATH` to that file's path if the default project-root file is not persistent.

The simulator is a long-running child of the webapp. It keeps running when the browser closes, but stops when the webapp stops or restarts. Hostinger documents scheduled tasks and resource limits for Web and Cloud plans, but does not guarantee a permanent child process. For a continuously running simulator, use a Hostinger VPS and manage the app with a process manager such as PM2. See Hostinger's [background-process guidance](https://www.hostinger.com/support/which-server-capabilities-are-supported-at-hostinger/) and [VPS Node.js setup](https://www.hostinger.com/support/9553137-how-to-set-up-a-node-js-application-using-hostinger-cloudpanel/).

If the public domain serves Hostinger's generic 403/404 pages instead of the app's Basic Auth challenge or JSON API, the request is not reaching Express. Verify the Node.js deployment succeeded, the domain is assigned to that app, and Hostinger's generated `public_html/.htaccess` routes to the Node.js app. Hostinger recommends redeploying to regenerate an incorrect `.htaccess`; check the [build and runtime logs](https://www.hostinger.com/support/how-to-troubleshoot-a-failed-node-js-deployment-using-build-logs/) before changing code.


---

## 6. Port Reference & How to Change Ports

### 6.1 Port quick-reference

| Service | Default port | Protocol | Where to change |
|---|---|---|---|
| **Dashboard** (webapp) | `3000` | HTTP | `PORT` environment variable, then `runtime-config.json` → `webapp.port` |
| **MQTT broker** TCP | `1883` | TCP | Mosquitto config + `runtime-config.json` → `sim_mqtt.port` |
| **MQTT broker** WebSocket | `9001` | WS | Mosquitto config + `runtime-config.json` → `display_mqtt.port` |
| **UDP Parser** listener | `20202` | UDP | `runtime-config.json` → `parser.udp_port` (or Parser tab UI) |

### 6.2 Changing the webapp HTTP port

Edit **`runtime-config.json`** — restart the webapp to apply:

```jsonc
// runtime-config.json
"webapp": {
  "port": 8080   // ← change to any free port
}
```

Then access the dashboard at `http://localhost:8080`.

### 6.3 Changing the MQTT broker ports

**Step 1** — Edit your Mosquitto config (usually `/etc/mosquitto/mosquitto.conf` on Linux/macOS, or `C:\Program Files\mosquitto\mosquitto.conf` on Windows):

```ini
listener 1884          # TCP port
listener 9002 0.0.0.0  # WebSocket port
protocol websockets
```

**Step 2** — Update both fields in `runtime-config.json`:

```jsonc
"sim_mqtt": {
  "host": "127.0.0.1",
  "port": 1884   // ← match Mosquitto TCP port
},
"display_mqtt": {
  "host": "127.0.0.1",
  "port": 9002   // ← match Mosquitto WebSocket port
}
```

> You can also change these live from the **Settings** tab in the dashboard — saves to disk immediately.

### 6.4 Changing the UDP parser port

Edit `runtime-config.json`:

```jsonc
"parser": {
  "udp_host": "0.0.0.0",
  "udp_port": 20202   // ← change to match your radar's output port
}
```

Or change it directly in the **Parser** tab UI → Save Settings → restart the parser process.

For the **standalone `rdxxb-parser/`**, edit `rdxxb-parser/config.json` instead:

```jsonc
{
  "udp_host": "0.0.0.0",
  "udp_port": 20202
}
```

### 6.5 Environment file

A `.env.example` is provided at the project root as a reference for all configurable values:

```bash
cp .env.example .env
# Edit .env with your values, then update runtime-config.json to match
```

---

## 7. Running the System

### Option A — Start the webapp and simulator

```bash
npm run dev
```

The webapp starts the simulator child process by default. The browser is optional; keep the webapp process running. This does not register an OS startup service. Run the webapp under a service manager if it must start after a machine reboot. Set `simulator.autoStart` to `false` in `runtime-config.json` to disable it on the next webapp start.

### Option B — Run processes separately

> Set `"simulator": { "autoStart": false }` in `runtime-config.json` before starting the webapp. Otherwise the webapp starts the simulator automatically and a separate `npm run simulator` command would create a duplicate.

**Terminal 1 — Webapp (required first):**
```bash
npm run webapp
# or
cd webapp && node server.js
```

Expected output:
```
[Webapp] ✓ http://localhost:3000
[Webapp] Runtime config: /path/to/runtime-config.json
[Webapp] Simulator auto-start disabled by configuration
```

**Terminal 2 — Simulator:**
```bash
npm run simulator
# or
cd simulator && node index.js
```

Expected output:
```
[Simulator] Connecting to MQTT broker at mqtt://127.0.0.1:1883 ...
[Simulator] ✓ Connected (clientId: rdxxb-simulator-xxxxxx)
[Simulator] Active modules:
  • basic_usage → radar/rdxxb/basic
  • frame_metadata → radar/rdxxb/frame
  ...
[Simulator] Publishing every 5000 ms
```

**Terminal 3 (optional) — Python Parser:**
```bash
source .venv/bin/activate
python3 parser/parser.py
```

> The parser can also be started/stopped from the **Parser** tab in the dashboard.

### Option C — Control simulator & parser from the dashboard

The simulator is already running when the webapp starts with the default configuration. Set `simulator.autoStart` to `false` and restart the webapp to use the dashboard's manual Start control.

1. Start the webapp: `npm run webapp`
2. Open `http://localhost:3000` in your browser
3. Navigate to the **Simulation** tab → use **▶ Start** or **■ Stop**
4. Navigate to the **Parser** tab → click **▶ Start**

The webapp manages simulator and parser child processes. The dashboard shows simulator status and controls; parser logs stream to the dashboard.

### Stopping

- **`npm run dev`**: press `Ctrl+C` — both processes shut down gracefully
- **Separate terminals**: press `Ctrl+C` in each terminal
- **Dashboard**: use the **■ Stop** buttons in the Simulation and Parser tabs

---

### Option D — Run the standalone parser (rdxxb-parser/)

The `rdxxb-parser/` folder is a fully self-contained Python parser with its own virtual environment and flat config.

**Setup (first time only):**

```bash
cd rdxxb-parser

# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate
pip install paho-mqtt

# Windows (CMD)
python -m venv .venv
.venv\Scripts\activate
pip install paho-mqtt
```

**Run:**

```bash
# macOS / Linux
./launch.sh

# Windows CMD
launch.bat

# Windows PowerShell
.\launch.ps1
```

**Configure** — edit `rdxxb-parser/config.json` directly (no nesting):

```jsonc
{
  "udp_host": "0.0.0.0",
  "udp_port": 20202,
  "mqtt_enabled": false,
  "mqtt_host": "127.0.0.1",
  "mqtt_port": 1883
}
```

---

### Option E — Build a standalone binary (no Python required on target machine)

Uses PyInstaller to produce a single executable.

**Build on macOS / Linux:**

```bash
# From project root (uses parser/ directory)
cd parser
./build.sh           # output → parser/dist/rdxxb-parser

# Or from standalone folder
cd rdxxb-parser
./build.sh           # output → rdxxb-parser/dist/rdxxb-parser
```

**Build on Windows:**

```bat
cd parser
build.bat            REM output → parser\dist\rdxxb-parser.exe

REM Or standalone
cd rdxxb-parser
build.bat            REM output → rdxxb-parser\dist\rdxxb-parser.exe
```

**Run the binary** (no Python, no venv needed):

```bash
# macOS / Linux
./dist/rdxxb-parser

# Windows
dist\rdxxb-parser.exe
```

The binary reads `runtime-config.json` from the same directory or one level up. For standalone binary, copy `config.json` alongside the executable.

---

## 8. Dashboard & Features

Open **`http://localhost:3000`** in any modern browser.

### Navigation tabs

| Tab | Description |
|---|---|
| 🗺 **Map** | Live Leaflet map centered on the configured radar GPS position. Each target is rendered as a clickable marker with type icon. Sidebar shows active target list. |
| 🎯 **Targets** | Tabular view of all live targets with full field set: ID, type, GPS coords, speed (ENU), distance, azimuth, energy, confidence. |
| 🧩 **Parser** | Start/stop the Python UDP parser; view its real-time stdout log stream via Server-Sent Events. |
| 📟 **Monitor** | Raw MQTT message viewer. Add individual module topics or use **Add All Modules** to subscribe to all 8 at once. Each topic gets its own scrollable window showing timestamped JSON payloads. |
| 📊 **Telemetry** | Parsed telemetry dashboard. One card per enabled module with formatted key-value grids and tables. Cards show ON/OFF badge and can be collapsed. |
| 🛰 **Simulation** | Enable/disable individual simulation modules, enable all, disable all. Start/stop the simulator process. |
| ⚙ **Settings** | Edit all fields of `runtime-config.json` via form UI. Saved changes take effect without restart. |

### Status bar

The top-right status indicators show:
- **MQTT** connection state (broker address when connected)
- **SIM** status (ON / OFF)
- **PARSER** status (ON / OFF)

---

## 9. MQTT Topics & Data Schemas

All payloads are UTF-8 encoded JSON. Below are the top-level shapes for each topic.

### `radar/rdxxb/basic` — Basic Usage

```jsonc
{
  "radar_location": {
    "gps": { "longitude": 107.608234, "latitude": -6.897456, "elevation_m": 150 },
    "orientation": { "roll_angle_deg": 0.5, "pitch_angle_deg": 1.2, "north_correction_angle_deg": 8.5 }
  },
  "targets": [
    {
      "track_id": 1001,
      "track_delete_flag": "0x00",
      "track_status": "active",
      "track_type_code": "0x20",
      "track_type_label": "drone",
      "confidence": 0.75,
      "energy": 3032.26,
      "credit_ratio": 0.80,
      "distance_m": 800.16,
      "azimuth_deg": 310.23,
      "elevation_pitch_deg": 1.14,
      "height_m": 15.97,
      "radial_speed_ms": -0.004,
      "longitude": 107.602708,
      "latitude": -6.892781,
      "altitude_m": 165.97,
      "vx_east_ms": 7.751,
      "vy_north_ms": 9.161,
      "vz_up_ms": -0.192,
      "unix_timestamp": 1777349986.032
    }
    // ...up to targetCount entries
  ],
  "_meta": { "frame_count": 135, "published_at": "2026-04-28T04:19:46.032Z" }
}
```

### `radar/rdxxb/frame` — Frame Metadata

```jsonc
{
  "frame_metadata": {
    "frame_header": "0x55AA",
    "frame_id": "0xFF02",
    "frame_type": "search_target_information",
    "frame_count": 135,
    "frame_timestamp_utc": "2026-04-28T04:19:46.032Z",
    "protocol_id": 1,
    "protocol_device": "RD01",
    "protocol_major_version": 2,
    "protocol_minor_version": 14,
    "checksum_valid": true
  }
}
```

### `radar/rdxxb/location` — Radar Location & Status

```jsonc
{
  "radar_device": {
    "device_id": 1,
    "device_label": "RDXXB Simulator",
    "model_name": "RD01",
    "network": { "ip_address": "127.0.0.1", "port": 7000 },
    "gps": { "longitude": ..., "latitude": ..., "elevation_m": ..., "heading_angle_deg": 45, "satellite_count": 12 },
    "orientation": { "roll_angle_deg": 0.5, "pitch_angle_deg": 1.2, "north_correction_angle_deg": 8.5 },
    "operational_state": { "work_mode": "0x11", "work_mode_label": "search", "fault_label": "none", "scan_mode_label": "mechanical_scanning" },
    "servo": { "current_azimuth_deg": 315, "current_pitch_deg": 5.1, "current_scan_cycle": 1 },
    "frequency": { "current_x_band_ghz": 9.5, "current_ku_band_ghz": 16.2 }
  }
}
```

### `radar/rdxxb/config` — Radar Configuration

```jsonc
{
  "radar_configuration": {
    "silent_zones": [
      { "zone_number": 1, "start_angle_deg": 0, "end_angle_deg": 0, "enabled": false }
    ],
    "filters": {
      "height_min_near_zone_m": 0, "height_min_far_zone_m": 0, "height_max_m": 1000,
      "speed_min_ms": 0, "speed_max_ms": 100,
      "range_min_m": 10, "range_max_m": 10000, "altitude_range_km": 10
    },
    "autonomous_identification": { "enabled": true, "max_targets": 5 }
  }
}
```

### `radar/rdxxb/health` — Radar Health

```jsonc
{
  "radar_health": {
    "thermals": {
      "subarray_temperatures": [{ "index": 1, "temperature_c": 45.45 }, ...],
      "signal_board_temperature_c": 51.75,
      "frequency_synthesizer_temperature_c": 47.62
    },
    "power": {
      "subarray_currents": [{ "index": 1, "current_a": 5.51 }, ...],
      "signal_voltages": [{ "channel": 1, "voltage_v": 12 }, { "channel": 2, "voltage_v": 5 }, { "channel": 3, "voltage_v": 3.3 }]
    },
    "system_health": {
      "fan_status": { "fan1": "normal", "fan2": "normal", "fan3": "normal", "fan4": "normal" },
      "memory_status": { "qdr_initialized": true, "ddr_0_initialized": true, "ddr_1_initialized": true, "pcie_link_ok": true }
    },
    "firmware": { "fpga_version": "v3.21", "data_processing_version": "2.14.05.2025" }
  }
}
```

### `radar/rdxxb/scan` — Scan Header

```jsonc
{
  "scan_header": {
    "search_azimuth_deg": 315,
    "search_elevation_deg": 5.1,
    "scan_cycle_count": 1,
    "pulse_group_id": 135,
    "target_count": 5
  }
}
```

### `radar/rdxxb/tracks` — Track Data

```jsonc
{
  "targets": [
    {
      "track_id": 1001,
      "track": {
        "track_identification": { "track_id": 1001, "track_delete_flag": "0x00", "track_status": "active" },
        "classification": { "track_type_code": "0x20", "track_type_label": "drone", "confidence": 0.75, "confidence_pct": "75%" },
        "signal_quality": { "energy": 3032.26, "credit_ratio": 0.80, "credit_ratio_pct": "80%" },
        "polar_coordinates": { "distance_m": 800.16, "azimuth_deg": 310.23, "elevation_pitch_deg": 1.14, "height_m": 15.97, "radial_speed_ms": -0.004, "radial_speed_label": "stationary" },
        "geodetic_coordinates": { "longitude": 107.602708, "latitude": -6.892781, "altitude_m": 165.97, "distance_from_radar_m": 800.16 },
        "velocity_enu": { "vx_east_ms": 7.751, "vy_north_ms": 9.161, "vz_up_ms": -0.192, "total_speed_ms": 12.002, "horizontal_speed_ms": 12, "vertical_direction": "descending" }
      }
    }
  ],
  "_meta": { "frame_count": 135, "published_at": "2026-04-28T04:19:46.032Z" }
}
```

### `radar/rdxxb/track-meta` — Track Metadata

```jsonc
{
  "targets": [
    {
      "track_metadata": {
        "track_id": 1001,
        "loss_count_cpi": 0,
        "loss_reason_code": 0,
        "update_time_cpi": 135,
        "age_pulses": 135,
        "radar_frontend_id": 1,
        "track_history": { "track_point_count": 135, "envelope_point_count": 6, "track_age_pulses": 135 },
        "utc_timestamp": {
          "year": 2026, "month": 4, "day": 28, "hour": 4, "minute": 19, "second": 46,
          "iso8601": "2026-04-28T04:19:46.032Z",
          "unix_timestamp": 1777349986.032
        }
      }
    }
  ],
  "_meta": { "frame_count": 135, "published_at": "2026-04-28T04:19:46.032Z" }
}
```

### Target Type Codes

| Code | Label |
|---|---|
| `0x00` | unknown |
| `0x11` | person |
| `0x12` | car |
| `0x20` | drone |
| `0x24` | bird |
| `0x31` | vessel |
| `0x40` | other |
| `0x41` | false_target |

---

## 10. Parser Module

**File:** `parser/parser.py`

The parser is a staged skeleton that implements the full RDXXB binary protocol decoding infrastructure without requiring physical hardware.

### What is implemented

- **Frame header parsing** — 16-byte universal header (`0x55AA`, frame ID, count, length, protocol version, checksum)
- **Scan/track header parsing** — 20-byte sub-header (azimuth, elevation, scan cycle, pulse group, target count)
- **Target record decoding** — per-target binary struct including GPS, velocity, type code, signal quality
- **Checksum validation** — byte-sum LSB over frame content
- **JSON output** — converts parsed structs to the same JSON schema as `basic_usage`
- **Target type lookup** — maps `0x20` → `"drone"`, etc.

### What needs wiring for real hardware

1. Replace the stub `listen()` function with a real `socket.socket(AF_INET, SOCK_DGRAM)` listener on `udp_host:udp_port` from `runtime-config.json`
2. Optionally publish parsed frames to MQTT (enable `mqtt_enabled` in config and add `paho-mqtt` to requirements)
3. The webapp's **Parser** tab will show live stdout regardless of transport

### Starting the parser

Via dashboard: **Parser tab → ▶ Start**

Via terminal:
```bash
source .venv/bin/activate
python3 parser/parser.py
```

The webapp streams parser stdout via Server-Sent Events to the dashboard log view.

---

## 11. Project Structure

```
radar-x-simulation-26/
│
├── config.js                    # Legacy config (fallback defaults)
├── package.json                 # Root npm workspace config
├── runtime-config.json          # Active runtime settings (auto-created)
│
├── simulator/
│   ├── index.js                 # Simulator entry point & MQTT publish loop
│   ├── target_gen.js            # Target physics engine (WGS-84, ENU)
│   └── package.json
│
├── webapp/
│   ├── server.js                # Express server, REST API, child process management
│   ├── package.json
│   └── public/
│       ├── index.html           # SPA shell (7 tabs)
│       ├── app.js               # All frontend JS (~1500 lines)
│       └── style.css            # Dashboard styling
│
├── parser/
│   └── parser.py                # RDXXB binary UDP protocol parser (skeleton)
│
└── documentation/
    ├── RDXXB_Radar_Protocol_Documentation_V1.0_EN.md
    ├── RDXXB_Modular_JSON_Schemas_v1_EN.md
    ├── RDXXB_Implementation_Plan.md
    ├── RDXXB_Protocol_Iteration.md
    └── udp_packets_for_testing.txt
```

---

## 12. API Reference

All endpoints are served by the webapp at `http://localhost:3000`.

### Config

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Returns the full `runtime-config.json` as JSON |
| `POST` | `/api/config` | Deep-merges the request body into config; writes to disk |

**Example POST body (partial update):**
```json
{
  "simulator": { "publishIntervalMs": 2000, "targetCount": 8 }
}
```

### Simulation

| Method | Path | Response |
|---|---|---|
| `POST` | `/api/simulation/start` | `{ "status": "started", "pid": 12345 }` |
| `POST` | `/api/simulation/stop` | `{ "status": "stopped" }` |
| `GET` | `/api/simulation/status` | `{ "running": true, "pid": 12345 }` |

### Parser

| Method | Path | Response |
|---|---|---|
| `POST` | `/api/parser/start` | `{ "status": "started", "pid": 12346 }` |
| `POST` | `/api/parser/stop` | `{ "status": "stopped" }` |
| `GET` | `/api/parser/status` | `{ "running": false, "pid": null }` |
| `GET` | `/api/parser/logs` | Server-Sent Events stream of parser stdout lines |

**SSE log stream example:**
```
data: {"type":"INFO","ts":1777349986.0,"msg":"Parser started"}

data: {"type":"ERR","ts":1777349987.0,"msg":"Some warning"}
```

---

## 13. Troubleshooting

### MQTT connection fails in browser

**Symptom:** Status bar shows `MQTT…` indefinitely.

**Checks:**
1. Confirm Mosquitto is running: `mosquitto_pub -h 127.0.0.1 -p 1883 -t test -m ping`
2. Confirm WebSocket port is open: `nc -zv 127.0.0.1 9001`
3. Ensure `mosquitto.conf` has both listeners (TCP 1883 and WebSocket 9001)
4. Check `display_mqtt.host` in `runtime-config.json` — if accessing from another machine, it must be the server's LAN IP, not `127.0.0.1`

### Simulator exits immediately

**Symptom:** `[Sim] Process exited (code 1)` in webapp logs.

**Checks:**
1. Is the MQTT broker running and reachable on port 1883?
2. Run the simulator manually for a full error: `cd simulator && node index.js`
3. Validate the config: `node -e "require('./runtime-config.json')"`

### No data on Telemetry tab

**Symptom:** All cards show "Waiting…" badge.

**Checks:**
1. Is the simulator running? Check the **Simulation** tab status.
2. Are modules enabled? Go to **Simulation** tab → check each module toggle.
3. Are the MQTT topics correct? Compare topics in `runtime-config.json` with what the simulator logs on startup.
4. Open the **Monitor** tab → **Add All Modules** → wait 5–10 seconds for messages.

### Map shows no targets

**Symptom:** Map tab shows "Active Targets 0".

**Checks:**
1. The map tab reads from `basic_usage` data only (topic `radar/rdxxb/basic`).
2. Ensure `basic_usage` module is enabled in `runtime-config.json`.
3. Confirm the `display_mqtt.topic` in config is `radar/rdxxb/basic`.

### Parser tab shows no output

**Symptom:** Log area is blank after clicking Start.

**Explanation:** The parser is currently a skeleton. It will start successfully but produce no output until its UDP `listen()` stub is replaced with a real socket connection to hardware or a test harness.

Use `documentation/udp_packets_for_testing.txt` to send test UDP frames manually.

### Changing `publishIntervalMs` has no effect

The simulator reads config **once at startup**. After changing this setting:
1. Stop the simulator via the **Simulation** tab or `Ctrl+C`
2. Start it again — it will read the new interval

### Port 3000 already in use

Change the webapp port in `runtime-config.json`:
```json
{ "webapp": { "port": 3001 } }
```
Then restart: `npm run webapp`

---

## Documentation

Full protocol and schema documentation is in the [`documentation/`](documentation/) folder:

- [RDXXB Radar Protocol Documentation V1.0](documentation/RDXXB_Radar_Protocol_Documentation_V1.0_EN.md) — Binary frame spec, byte offsets, type codes
- [Modular JSON Schemas](documentation/RDXXB_Modular_JSON_Schemas_v1_EN.md) — JSON schema definitions for all 8 modules
- [Implementation Plan](documentation/RDXXB_Implementation_Plan.md) — Development roadmap
- [Protocol Iteration Notes](documentation/RDXXB_Protocol_Iteration.md) — Changelog and design decisions
- [UDP Test Packets](documentation/udp_packets_for_testing.txt) — Raw hex packets for parser testing
