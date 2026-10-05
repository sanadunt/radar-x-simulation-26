'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'webapp', 'server.js');
const ROOT_ENTRY_PATH = path.join(PROJECT_ROOT, 'server.js');

async function getFreePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.listen(0, '127.0.0.1', err => err ? reject(err) : resolve());
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => {
    listener.close(err => err ? reject(err) : resolve());
  });
  return port;
}

function sendPipelinedPostRequests(port, routes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let raw = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('pipelined requests timed out')));
    socket.on('connect', () => {
      const requests = routes.map((route, index) => [
        `POST ${route} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Content-Length: 0',
        `Connection: ${index === routes.length - 1 ? 'close' : 'keep-alive'}`,
        '',
        '',
      ].join('\r\n')).join('');
      socket.write(requests);
    });
    socket.on('data', chunk => { raw += chunk.toString(); });
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        const responses = [];
        while (raw.length) {
          const headerEnd = raw.indexOf('\r\n\r\n');
          assert.notEqual(headerEnd, -1, 'incomplete HTTP response headers');
          const headers = raw.slice(0, headerEnd);
          const status = Number(headers.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
          const contentLength = Number(headers.match(/content-length:\s*(\d+)/i)?.[1]);
          assert.ok(Number.isInteger(status), 'missing HTTP response status');
          assert.ok(Number.isInteger(contentLength), 'missing HTTP response content length');
          const bodyStart = headerEnd + 4;
          assert.ok(raw.length >= bodyStart + contentLength, 'incomplete HTTP response body');
          responses.push({ status, body: JSON.parse(raw.slice(bodyStart, bodyStart + contentLength)) });
          raw = raw.slice(bodyStart + contentLength);
        }
        resolve(responses);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function makeRuntimeConfig(port, autoStart) {
  return {
    sim_mqtt: { protocol: 'mqtt', host: '127.0.0.1', port: 1, username: '', password: '', topic: 'smoke/unused' },
    display_mqtt: { protocol: 'ws', host: '127.0.0.1', port: 1, username: '', password: '', topic: 'smoke/unused' },
    radar: { longitude: 0, latitude: 0, elevation_m: 0, roll_angle_deg: 0, pitch_angle_deg: 0, north_correction_angle_deg: 0 },
    simulator: { autoStart, publishIntervalMs: 60000, targetCount: 1 },
    simulation_modules: { basic_usage: { enabled: false, topic: 'smoke/unused' } },
    parser: { udp_host: '127.0.0.1', udp_port: 20202, mqtt_enabled: false, mqtt_topic: 'smoke/unused' },
    webapp: { port },
  };
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('webapp did not exit after SIGTERM'));
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve();
    }
    child.once('exit', onExit);
  });
}

async function waitForProcessGone(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`simulator process ${pid} did not exit`);
}

async function startServerFixture(autoStart, options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-autostart-test-'));
  const configPort = await getFreePort();
  const port = options.useInjectedPort ? await getFreePort() : configPort;
  const configPath = path.join(tempDir, 'runtime-config.json');
  await fs.writeFile(configPath, JSON.stringify(makeRuntimeConfig(configPort, autoStart), null, 2));

  const environment = {
    ...process.env,
    NODE_ENV: options.nodeEnv || 'test',
    PORT: String(port),
    WEBAPP_AUTH_USER: options.authUser || '',
    WEBAPP_AUTH_PASSWORD: options.authPassword || '',
    RDXXB_RUNTIME_CONFIG_PATH: configPath,
  };
  const server = spawn(process.execPath, [options.serverPath || SERVER_PATH], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fixture = {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    configPath,
    output: '',
    simulatorPids: new Set(),
    launchError: null,
    closed: false,
  };
  const authorization = options.authUser && options.authPassword
    ? `Basic ${Buffer.from(`${options.authUser}:${options.authPassword}`).toString('base64')}`
    : null;
  fixture.fetch = (route, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (authorization) headers.set('authorization', authorization);
    return fetch(`${fixture.baseUrl}${route}`, { ...init, headers });
  };
  server.stdout.on('data', data => { fixture.output += data.toString(); });
  server.stderr.on('data', data => { fixture.output += data.toString(); });
  server.on('error', error => { fixture.launchError = error; });
  fixture.readStatus = async () => {
    const response = await fixture.fetch('/api/simulation/status');
    assert.equal(response.status, 200);
    const status = await response.json();
    if (status.pid) fixture.simulatorPids.add(status.pid);
    return status;
  };
  fixture.close = async () => {
    if (fixture.closed) return;
    fixture.closed = true;
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    for (const pid of fixture.simulatorPids) await waitForProcessGone(pid);
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + (options.startupTimeoutMs || 10000);
  try {
    while (Date.now() < deadline) {
      if (fixture.launchError) throw fixture.launchError;
      if (server.exitCode !== null) throw new Error(`webapp exited ${server.exitCode}: ${fixture.output}`);
      try {
        await fixture.readStatus();
        return fixture;
      } catch (_) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    throw new Error(`webapp did not become ready: ${fixture.output}`);
  } catch (error) {
    await fixture.close().catch(() => {});
    throw error;
  }
}

test('starts through the repository-root server entrypoint', async t => {
  const fixture = await startServerFixture(false, { serverPath: ROOT_ENTRY_PATH });
  t.after(() => fixture.close());

  assert.equal((await fixture.readStatus()).running, false);
});

test('starts the simulator without a browser and persists config updates', async t => {
  const fixture = await startServerFixture(true);
  t.after(() => fixture.close());

  const status = await fixture.readStatus();
  assert.equal(status.running, true);
  assert.ok(status.pid);

  const response = await fetch(`${fixture.baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ simulator: { targetCount: 7 } }),
  });
  assert.equal(response.status, 200);
  const savedConfig = JSON.parse(await fs.readFile(fixture.configPath, 'utf8'));
  assert.equal(savedConfig.simulator.targetCount, 7);
  assert.equal(savedConfig.simulator.autoStart, true);

  fixture.server.kill('SIGTERM');
  await waitForExit(fixture.server);
  await waitForProcessGone(status.pid);
});

test('honors autoStart false while keeping manual start available', async t => {
  const fixture = await startServerFixture(false);
  t.after(() => fixture.close());

  assert.equal((await fixture.readStatus()).running, false);
  const response = await fetch(`${fixture.baseUrl}/api/simulation/start`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await fixture.readStatus()).running, true);
});

test('keeps a replacement simulator tracked after the previous child exits', async t => {
  const fixture = await startServerFixture(true);
  t.after(async () => {
    for (const pid of fixture.simulatorPids) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    await fixture.close();
  });

  const previous = await fixture.readStatus();
  const responses = await sendPipelinedPostRequests(Number(new URL(fixture.baseUrl).port), [
    '/api/simulation/stop',
    '/api/simulation/start',
  ]);
  const [stopped, replacement] = responses;
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(stopped.body.status, 'stopped');
  assert.equal(replacement.body.status, 'started');
  assert.notEqual(replacement.body.pid, previous.pid);
  fixture.simulatorPids.add(replacement.body.pid);
  const replacementPid = replacement.body.pid;

  await waitForProcessGone(previous.pid);
  await new Promise(resolve => setTimeout(resolve, 100));
  const current = await fixture.readStatus();
  assert.equal(current.running, true);
  assert.equal(current.pid, replacementPid);

  const replacementStop = await fixture.fetch('/api/simulation/stop', { method: 'POST' });
  assert.equal((await replacementStop.json()).status, 'stopped');
  await waitForProcessGone(replacementPid);
});

test('uses the platform PORT before the runtime-config port', async t => {
  const fixture = await startServerFixture(false, { useInjectedPort: true, startupTimeoutMs: 1500 });
  t.after(() => fixture.close());
  assert.equal((await fixture.readStatus()).running, false);
});

test('requires both admin credentials in production', async () => {
  let fixture;
  try {
    fixture = await startServerFixture(false, { nodeEnv: 'production', startupTimeoutMs: 1500 });
  } catch (error) {
    assert.match(error.message, /WEBAPP_AUTH_USER/);
    assert.match(error.message, /WEBAPP_AUTH_PASSWORD/);
    return;
  }
  await fixture.close();
  assert.fail('production server started without admin credentials');
});

test('protects dashboard and config API with HTTP Basic auth', async t => {
  const fixture = await startServerFixture(false, {
    nodeEnv: 'production',
    authUser: 'ops',
    authPassword: 'test-only-password',
  });
  t.after(() => fixture.close());

  const unauthenticated = await fetch(`${fixture.baseUrl}/api/config`);
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), /^Basic /);

  const invalidAuth = await fetch(`${fixture.baseUrl}/api/config`, {
    headers: { authorization: `Basic ${Buffer.from('ops:wrong').toString('base64')}` },
  });
  assert.equal(invalidAuth.status, 401);

  const crossOriginSave = await fixture.fetch('/api/config', {
    method: 'POST',
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ simulator: { targetCount: 12 } }),
  });
  assert.equal(crossOriginSave.status, 403);

  const sameOriginSave = await fixture.fetch('/api/config', {
    method: 'POST',
    headers: { origin: fixture.baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ simulator: { targetCount: 8 } }),
  });
  assert.equal(sameOriginSave.status, 200);

  const apiClientSave = await fixture.fetch('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ simulator: { targetCount: 9 } }),
  });
  assert.equal(apiClientSave.status, 200);
  assert.equal(JSON.parse(await fs.readFile(fixture.configPath, 'utf8')).simulator.targetCount, 9);
  const configResponse = await fixture.fetch('/api/config');
  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await configResponse.json()).webapp.port > 0, true);

  const dashboardResponse = await fixture.fetch('/');
  assert.equal(dashboardResponse.status, 200);

  const unauthenticatedSave = await fetch(`${fixture.baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ simulator: { targetCount: 99 } }),
  });
  assert.equal(unauthenticatedSave.status, 401);
});

test('does not execute shell syntax from configured parser port checks', async t => {
  if (process.platform === 'win32') return t.skip('parser port tools are POSIX-specific');
  const fixture = await startServerFixture(false, {
    nodeEnv: 'production',
    authUser: 'ops',
    authPassword: 'test-only-password',
  });
  t.after(() => fixture.close());

  const markerPath = path.join(path.dirname(fixture.configPath), 'port-check-executed');
  const portUpdate = await fixture.fetch('/api/config', {
    method: 'POST',
    headers: { origin: fixture.baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ parser: { udp_port: `1; touch ${markerPath}; #` } }),
  });
  assert.equal(portUpdate.status, 200);
  assert.equal((await fixture.fetch('/api/parser/port-check')).status, 200);
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });
});

test('does not execute shell syntax from configured parser force-kill port', async t => {
  if (process.platform === 'win32') return t.skip('parser port tools are POSIX-specific');
  const fixture = await startServerFixture(false, {
    nodeEnv: 'production',
    authUser: 'ops',
    authPassword: 'test-only-password',
  });
  t.after(() => fixture.close());

  const markerPath = path.join(path.dirname(fixture.configPath), 'force-kill-executed');
  const portUpdate = await fixture.fetch('/api/config', {
    method: 'POST',
    headers: { origin: fixture.baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ parser: { udp_port: `1; touch ${markerPath}; #` } }),
  });
  assert.equal(portUpdate.status, 200);
  const forceKill = await fixture.fetch('/api/parser/force-kill', {
    method: 'POST',
    headers: { origin: fixture.baseUrl },
  });
  assert.equal(forceKill.status, 200);
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });
});
