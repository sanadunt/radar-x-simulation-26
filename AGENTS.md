# Repository Guidelines

## Project Overview

RDXXB Radar Simulation & Visualization provides a hardware-free simulator and dashboard for radar development, integration testing, and training. A Node.js simulator publishes synthetic radar JSON over MQTT; Python parsers decode RDXXB UDP frames; an Express webapp serves the dashboard and controls runtime processes. The MQTT broker is external.

## Architecture & Data Flow

- `simulator/index.js` builds and publishes enabled schema modules over MQTT/TCP. `simulator/target_gen.js` generates moving targets and coordinate data.
- `parser/parser.py` is the webapp-integrated UDP parser. It emits structured logs and can publish parsed modules to MQTT. `webapp/server.js` serves the SPA and REST control/config APIs, starts or stops simulator/parser child processes, and streams parser output over SSE.
- `webapp/public/app.js` loads settings from the webapp, connects to MQTT over WebSocket, and renders map, target, monitor, and telemetry views.
- `rdxxb-parser/` is a separate standalone parser with its own `config.json`, virtual environment, launchers, and build scripts. Its configuration and parsing behavior differ from `parser/`; do not assume the implementations are interchangeable.

## Key Directories

- `simulator/` — MQTT simulator and target generation.
- `webapp/` — Express server; `webapp/public/` contains the plain-JavaScript SPA, HTML, and CSS.
- `parser/` — primary UDP parser, integrated with the dashboard and root runtime config.
- `rdxxb-parser/` — standalone parser distribution and its independent config.
- `documentation/` — protocol/schema references, implementation notes, packet examples, and capture analyses.
- `tapping/` — packet captures, recording samples, operation logs, and a capture decoder; these are analysis assets, not an automated test suite.

## Development Commands

Run from the repository root unless noted:

```sh
npm install
test -f runtime-config.json || cp runtime-config.example.json runtime-config.json  # first run only; preserve existing local settings
npm run dev                         # starts webapp; simulator autostarts by default
npm start                           # production/Hostinger entry point
npm run simulator                   # manual publisher; set simulator.autoStart=false first
npm test                            # run Node server lifecycle tests
python3 parser/parser.py            # run the primary UDP parser
python3 parser/parser.py --self-test
python3 rdxxb-parser/parser.py --self-test
(cd parser && ./build.sh)           # optional PyInstaller binary
(cd rdxxb-parser && ./build.sh)     # optional standalone binary
```

`npm run webapp` is equivalent to `npm run dev`. The webapp starts its simulator child on launch unless `simulator.autoStart` is `false`; `PORT` overrides the config port. Production requires `NODE_ENV=production` plus `WEBAPP_AUTH_USER` and `WEBAPP_AUTH_PASSWORD`. This is process-level startup, not an OS service. On Hostinger Web/Cloud, verify support for a continuously running child; use a VPS for an always-on simulator. Run an external MQTT broker with TCP and WebSocket listeners matching `runtime-config.json` before exercising live MQTT flows. The parser launcher/build scripts also have Windows `.bat` variants.

There is no aggregate Node build command. The parser `build.sh` scripts package binaries with PyInstaller; they are not application builds.

## Code Conventions & Common Patterns

- Node code uses CommonJS (`require`/`module.exports`), `'use strict'`, semicolons, and camelCase. Follow the surrounding file style; no formatter or linter is configured.
- The web server uses Express handlers and `child_process.spawn`; MQTT and child-process lifecycles use event callbacks. Keep process output/logging and SSE behavior consistent with `webapp/server.js`.
- The browser is a plain-JavaScript SPA with shared state in `webapp/public/app.js`, not a component framework. Follow its existing MQTT subscription and render/update paths when adding dashboard behavior.
- Python parsing uses `struct`, dataclasses, and JSON-line logging. The primary parser accepts runtime configuration; the standalone parser has its own config and validation rules.
- Runtime settings come from root `runtime-config.json`; `config.js` supplies legacy bootstrap defaults. `RDXXB_RUNTIME_CONFIG_PATH` overrides the config location. The server reads `PORT`, `NODE_ENV`, and web auth variables directly; `.env.example` is not automatically loaded.
- No dependency-injection framework is present. Use the existing config and module boundaries rather than introducing a second configuration or state-management layer.

## Important Files

- `package.json`, `package-lock.json` — npm workspaces and the available root commands.
- `runtime-config.json` — ignored local settings. Never commit or disclose its credentials; use `runtime-config.example.json` as the safe template.
- `config.js` — legacy defaults used when the runtime config must be bootstrapped.
- `simulator/index.js`, `simulator/target_gen.js` — simulator entry point and target model.
- `webapp/server.js`, `webapp/public/index.html`, `webapp/public/app.js`, `webapp/public/style.css` — dashboard server and SPA.
- `parser/parser.py`, `rdxxb-parser/parser.py` — distinct parser implementations.
- `documentation/RDXXB_Radar_Protocol_Documentation_V1.0_EN.md`, `documentation/RDXXB_Modular_JSON_Schemas_v1_EN.md` — protocol and payload references.

The README is an operator guide; its primary parser description may be stale. Check `package.json`, `runtime-config.json`, and current source when they disagree; use protocol documentation for wire-format details.

## Runtime/Tooling Preferences

Use Node.js with npm workspaces and the npm lockfile; Python 3 is required for parser work. The project does not use Bun, TypeScript, or a frontend build framework. MQTT is not bundled: configure a broker separately. The primary parser launch scripts create/reuse a root `.venv`; the standalone parser keeps its environment under `rdxxb-parser/.venv`.

## Testing & QA

`npm test` covers server autostart, manual simulator controls, config persistence, platform port precedence, and production authentication. No lint, type-check, coverage, or CI suite is configured. The two Python `--self-test` options check binary structure sizes; they are smoke checks, not end-to-end parser tests.

For a runtime smoke check, configure the MQTT broker and run `npm run dev`; the simulator starts as a webapp child by default. Confirm its process/status and MQTT messages in the Monitor/Telemetry views. To run `npm run simulator` separately, set `simulator.autoStart` to `false` first. For parser changes, use `documentation/udp_packets_for_testing.txt` with the configured UDP listener and verify parser output through the dashboard SSE log and, when enabled, MQTT. Packet captures and `.dat` files are sample/analysis data, not assertions or fixtures managed by a test runner.