# RDXXB Radar Simulation & Visualization Plan

This plan outlines the architecture for a Node.js-based radar simulator and web visualization system, using MQTT for telemetry and staging a Python-based UDP parser.

## 1. Reliability Assessment
**YES, this is highly reliable.** 
- **Node.js** handles high-frequency event loops (like target movement updates) efficiently.
- **MQTT** provides the "glue" that allows the simulator and webapp to run independently, even on different machines.
- **Leaflet.js** is a lightweight, battle-tested library for rendering geographical overlays.
- **Python** is the industry standard for binary data manipulation (UDP Parser), which we will stage for future integration.

## 2. Project Structure
```text
radar-x-simulation-26/
├── simulator/           # Node.js Target Simulator
│   ├── index.js         # Main entry point
│   ├── target_gen.js    # Movement & Math logic (Circular/Linear)
│   └── package.json
├── webapp/              # Web Dashboard
│   ├── public/
│   │   ├── index.html   # Leaflet Map + MQTT.js Client
│   │   └── style.css
│   └── server.js        # Static file server (Express)
├── parser/              # Staged UDP Parser
│   ├── parser.py        # Python skeleton for binary parsing
│   └── README.md
└── docker-compose.yml   # Optional: Spin up local Mosquitto broker
```

## 3. Implementation Modules

### Module A: Radar Simulator (Node.js)
- **Physics Engine**: Calculate new WGS-84 coordinates based on speed, heading, and time delta.
- **JSON Generator**: Format target data into the "Basic Usage" schema (Target ID, Type, GPS, Speed, etc.).
- **MQTT Publisher**: Send JSON messages to a topic (e.g., `radar/targets`) every 200ms-500ms.

### Module B: Web Dashboard (Node.js/HTML)
- **Map View**: Centered on the Radar location (e.g., Bandung, Indonesia as per documentation).
- **MQTT Client (In-Browser)**: Use `mqtt.js` over WebSockets to receive real-time updates.
- **Overlay Layer**: 
    - Render Radar "Sweep" (azimuth visualization).
    - Render Targets as icons (Drone, Bird, Person).
    - Maintain "Ghost" trails for track history.

### Module C: UDP Parser (Python - Staged)
- **Binary Decoding**: Using `struct.unpack` to parse the 16-byte header and 148-byte target records.
- **Checksum Verification**: Logic to validate frame integrity.
- **JSON Converter**: Bridge between binary UDP and the internal JSON representation.

## 4. Communication Flow
1. **Simulator** (Node.js) -> `Publishes JSON` -> **MQTT Broker**.
2. **MQTT Broker** -> `Forwards JSON` -> **Web Dashboard** (Browser).
3. (Future) **Radar Hardware** -> `UDP Binary` -> **UDP Parser** (Python) -> `Publishes JSON` -> **MQTT Broker**.

---
## 5. Proposed Timeline
1.  **Phase 1**: Initialize project and setup a local/public MQTT broker.
2.  **Phase 2**: Build the Node.js Simulator with a single drone circling the radar.
3.  **Phase 3**: Build the Web Interface with Leaflet.js to show the drone moving.
4.  **Phase 4**: Add support for multiple targets and classification types.
5.  **Phase 5**: Implement the Python UDP Parser skeleton.
