'use strict';

const express        = require('express');
const crypto         = require('crypto');
const path           = require('path');
const fs             = require('fs');
const { spawn, execFileSync } = require('child_process');
const { isSimulatorAutoStartEnabled } = require('./simulator-autostart');

const CONFIG_PATH = process.env.RDXXB_RUNTIME_CONFIG_PATH || path.join(__dirname, '..', 'runtime-config.json');
const authUsername = process.env.WEBAPP_AUTH_USER || '';
const authPassword = process.env.WEBAPP_AUTH_PASSWORD || '';
if (Boolean(authUsername) !== Boolean(authPassword)) {
  throw new Error('Set both WEBAPP_AUTH_USER and WEBAPP_AUTH_PASSWORD, or leave both unset.');
}
if (process.env.NODE_ENV === 'production' && !authUsername) {
  throw new Error('WEBAPP_AUTH_USER and WEBAPP_AUTH_PASSWORD are required when NODE_ENV=production.');
}

// ─── Load / Init Runtime Config ───────────────────────────────────────────────
function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  // Bootstrap from legacy config.js
  const legacy = require('../config');
  const bootstrap = {
    sim_mqtt: {
      protocol: legacy.mqtt?.tcp?.protocol || 'mqtt',
      host:     legacy.mqtt?.tcp?.host     || '127.0.0.1',
      port:     legacy.mqtt?.tcp?.port     || 1883,
      username: legacy.mqtt?.tcp?.username || '',
      password: legacy.mqtt?.tcp?.password || '',
      topic:    legacy.mqtt?.topics?.targets || 'radar/rdxxb/targets',
    },
    display_mqtt: {
      protocol: legacy.mqtt?.ws?.protocol || 'ws',
      host:     legacy.mqtt?.ws?.host     || '127.0.0.1',
      port:     legacy.mqtt?.ws?.port     || 9001,
      username: legacy.mqtt?.ws?.username || '',
      password: legacy.mqtt?.ws?.password || '',
      topic:    legacy.mqtt?.topics?.targets || 'radar/rdxxb/targets',
    },
    radar:     legacy.radar,
    simulator: legacy.simulator,
    webapp:    legacy.webapp,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(bootstrap, null, 2));
  return bootstrap;
}

let runtimeConfig = loadConfig();

// ─── Simulator Child Process ──────────────────────────────────────────────────
let simProcess = null;

function startSimulator() {
  if (simProcess) return { status: 'already_running', pid: simProcess.pid };
  const simPath = path.join(__dirname, '..', 'simulator', 'index.js');
  const childProcess = spawn('node', [simPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  simProcess = childProcess;
  childProcess.stdout.on('data', d => process.stdout.write(`[Sim] ${d}`));
  childProcess.stderr.on('data', d => process.stderr.write(`[Sim ERR] ${d}`));
  childProcess.on('exit', (code) => {
    console.log(`[Sim] Process exited (code ${code})`);
    if (simProcess === childProcess) simProcess = null;
  });
  return { status: 'started', pid: childProcess.pid };
}

function stopSimulator() {
  if (!simProcess) return { status: 'not_running' };
  simProcess.kill('SIGTERM');
  simProcess = null;
  return { status: 'stopped' };
}

function matchesCredential(candidate, expected) {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

function hasValidBasicAuth(header) {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header || '');
  if (!match) return false;
  const credentials = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = credentials.indexOf(':');
  if (separator < 0) return false;
  const userMatches = matchesCredential(credentials.slice(0, separator), authUsername);
  const passwordMatches = matchesCredential(credentials.slice(separator + 1), authPassword);
  return userMatches && passwordMatches;
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
if (authUsername) {
  app.use((req, res, next) => {
    if (hasValidBasicAuth(req.get('authorization'))) return next();
    res.set('WWW-Authenticate', 'Basic realm="RDXXB Dashboard", charset="UTF-8"');
    res.status(401).send('Authentication required');
  });
}

app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).send('Cross-origin request denied');
  }
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== (req.get('host') || '').toLowerCase()) {
        return res.status(403).send('Cross-origin request denied');
      }
    } catch (_) {
      return res.status(403).send('Cross-origin request denied');
    }
  }
  next();
});

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json());

// GET full config (browser reads this on load)
app.get('/api/config', (req, res) => {
  res.json(runtimeConfig);
});

// POST updated config (browser saves settings form)
app.post('/api/config', (req, res) => {
  // Deep merge each top-level key so partial updates don't wipe other fields
  const body = req.body;

  // Track whether sim_mqtt changed so we can restart the simulator if needed
  const prevSimMqtt = JSON.stringify(runtimeConfig.sim_mqtt || {});

  if (body.sim_mqtt)            runtimeConfig.sim_mqtt            = { ...runtimeConfig.sim_mqtt,            ...body.sim_mqtt };
  if (body.display_mqtt)        runtimeConfig.display_mqtt        = { ...runtimeConfig.display_mqtt,        ...body.display_mqtt };
  if (body.radar)               runtimeConfig.radar               = { ...runtimeConfig.radar,               ...body.radar };
  if (body.simulator)           runtimeConfig.simulator           = { ...runtimeConfig.simulator,           ...body.simulator };
  if (body.parser)              runtimeConfig.parser              = { ...runtimeConfig.parser,              ...body.parser };
  if (body.simulation_modules)  runtimeConfig.simulation_modules  = body.simulation_modules;
  if (body.custom_delivery !== undefined) runtimeConfig.custom_delivery = body.custom_delivery;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(runtimeConfig, null, 2));

  // If sim_mqtt changed while simulator is running, restart it so it picks up the new broker
  const simMqttChanged = body.sim_mqtt && (JSON.stringify(runtimeConfig.sim_mqtt) !== prevSimMqtt);
  if (simMqttChanged && simProcess) {
    console.log('[Webapp] sim_mqtt changed — restarting simulator to apply new broker settings');
    stopSimulator();
    setTimeout(() => startSimulator(), 800);   // brief pause so the old process fully exits
  }

  res.json({ ok: true, config: runtimeConfig });
});

// Simulation control
app.post('/api/simulation/start',  (req, res) => res.json(startSimulator()));
app.post('/api/simulation/stop',   (req, res) => res.json(stopSimulator()));
app.get('/api/simulation/status',  (req, res) => res.json({
  running: simProcess !== null,
  pid:     simProcess?.pid || null,
}));

// ─── Parser Child Process ─────────────────────────────────────────────────────
let parserProcess    = null;
const parserClients  = new Set();   // SSE response objects
const parserLogBuf   = [];          // last 500 lines for late-joining clients
const LOG_BUF_MAX    = 500;

function broadcastParserLine(line) {
  parserLogBuf.push(line);
  if (parserLogBuf.length > LOG_BUF_MAX) parserLogBuf.shift();
  const payload = `data: ${line}\n\n`;
  for (const client of parserClients) {
    client.write(payload);
  }
}

function startParser() {
  if (parserProcess) return { status: 'already_running', pid: parserProcess.pid };
  const parserPath = path.join(__dirname, '..', 'parser', 'parser.py');
  // Prefer the workspace .venv interpreter so paho-mqtt etc. are available
  const venvPy = path.join(__dirname, '..', '.venv', 'bin', 'python3');
  const pyBin  = fs.existsSync(venvPy) ? venvPy : 'python3';
  // -u = unbuffered Python stdout so lines arrive in real-time
  parserProcess = spawn(pyBin, ['-u', parserPath, '--config', CONFIG_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  function handleData(chunk) {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) broadcastParserLine(trimmed);
    }
  }

  parserProcess.stdout.on('data', handleData);
  parserProcess.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) broadcastParserLine(
        JSON.stringify({ type: 'ERR', ts: Date.now() / 1000, msg: trimmed })
      );
    }
  });

  parserProcess.on('exit', (code) => {
    console.log(`[Parser] Process exited (code ${code})`);
    broadcastParserLine(
      JSON.stringify({ type: 'INFO', ts: Date.now() / 1000,
                       msg: `Parser process exited (code ${code})` })
    );
    parserProcess = null;
  });

  return { status: 'started', pid: parserProcess.pid };
}

function stopParser() {
  if (!parserProcess) return { status: 'not_running' };
  parserProcess.kill('SIGTERM');
  parserProcess = null;
  return { status: 'stopped' };
}

// Parser REST endpoints
app.post('/api/parser/start',  (req, res) => res.json(startParser()));
app.post('/api/parser/stop',   (req, res) => res.json(stopParser()));
app.get('/api/parser/status',  (req, res) => res.json({
  running: parserProcess !== null,
  pid:     parserProcess?.pid || null,
  timestamp: new Date().toISOString(),
}));

function findPidsOnPort(port) {
  const output = execFileSync('lsof', ['-t', '-i', `:${port}`], { encoding: 'utf8' });
  return [...new Set(output.trim().split(/\s+/).filter(Boolean))];
}

// Check what process (if any) is using parser port
app.get('/api/parser/port-check', (req, res) => {
  const port = runtimeConfig.parser?.udp_port || 8000;
  
  try {
    const output = execFileSync('lsof', ['-i', `:${port}`], { encoding: 'utf8' });
    const lines = output.split('\n').filter(l => l.trim());
    if (lines.length > 1) {
      // First line is header, second line has the process
      const parts = lines[1].split(/\s+/);
      res.json({ in_use: true, process: parts[0], pid: parts[1], port });
    } else {
      res.json({ in_use: false, port });
    }
  } catch (_) {
    // lsof not found or no process on port
    res.json({ in_use: false, port });
  }
});

// Force kill any process using the parser port (read from config)
app.post('/api/parser/force-kill', (req, res) => {
  const port = runtimeConfig.parser?.udp_port || 8000;

  try {
    if (parserProcess) {
      parserProcess.kill('SIGKILL');
      parserProcess = null;
    }

    try {
      for (const pid of findPidsOnPort(port)) {
        const numericPid = Number(pid);
        if (!Number.isSafeInteger(numericPid) || numericPid <= 0 || numericPid === process.pid) continue;
        try {
          process.kill(numericPid, 'SIGKILL');
        } catch (_) {}
      }
    } catch (_) {}

    setTimeout(() => {
      res.json({ status: 'force_killed', message: `Port ${port} and parser processes cleared` });
    }, 500);
  } catch (err) {
    console.error('[Parser] Force kill error:', err.message);
    stopParser();
    res.json({ status: 'force_killed', message: 'Cleanup attempted (may have errors)', error: err.message });
  }
});

// SSE log stream
app.get('/api/parser/logs', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // disable nginx buffering if present
  res.flushHeaders();

  // Send buffered history so the client sees previous lines immediately
  for (const line of parserLogBuf) {
    res.write(`data: ${line}\n\n`);
  }

  parserClients.add(res);

  // Keep-alive ping every 15 s
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(ping);
    parserClients.delete(res);
  });
});

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || runtimeConfig.webapp?.port || 3000);
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`[Webapp] ✓ http://localhost:${PORT}`);
  console.log(`[Webapp] Runtime config: ${CONFIG_PATH}`);
  if (isSimulatorAutoStartEnabled(runtimeConfig)) {
    const result = startSimulator();
    console.log(`[Webapp] Simulator auto-started (PID ${result.pid})`);
  } else {
    console.log('[Webapp] Simulator auto-start disabled by configuration');
  }
});

function shutdown() {
  stopSimulator();
  stopParser();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
