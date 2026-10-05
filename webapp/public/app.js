'use strict';

/* ═══════════════════════════════════════════════════════════════════════════════
   RDXXB Radar Webapp  –  app.js
   Features: Tab navigation · Live map · Targets table + charts ·
             Settings form · Sim start/stop · Dual MQTT config
 ═══════════════════════════════════════════════════════════════════════════════ */

/* ── Constants ─────────────────────────────────────────────────────────────── */
const MAX_TRAIL_POINTS  = 30;
const CHART_HISTORY     = 50;
const SCAN_CYCLE_SEC    = 3.2;
const SCAN_SPEED_DEG_S  = 360 / SCAN_CYCLE_SEC;
const RADAR_RANGE_M     = 7500;
const INNER_RANGE_M     = 3000;

const TARGET_STYLES = {
  drone:        { symbol: '✈', color: '#ff4444', size: 22 },
  bird:         { symbol: '●', color: '#88cc44', size: 14 },
  car:          { symbol: '■', color: '#4488ff', size: 14 },
  person:       { symbol: '▲', color: '#ff8800', size: 14 },
  vessel:       { symbol: '⬟', color: '#00aaff', size: 16 },
  other:        { symbol: '◆', color: '#aa88ff', size: 14 },
  unknown:      { symbol: '?', color: '#888888', size: 14 },
  false_target: { symbol: '✗', color: '#555555', size: 12 },
};

/* ── State ─────────────────────────────────────────────────────────────────── */
let CONFIG          = null;
let mqttClient      = null;
let map           = null;
let sweepLine     = null;
let sweepAngle    = 0;
let lastSweepTime = performance.now();
let simPollTimer  = null;

const targetMarkers  = {};  // track_id → L.Marker
const targetTrails   = {};  // track_id → L.Polyline
const targetHistory  = {};  // track_id → [[lat, lon], ...]
const targetData     = {};  // track_id → latest target object
const chartHistory   = {};  // track_id → { distance:[], altitude:[], speed:[], vx:[], vy:[], vz:[] }
const targetSources  = new Map(); // topic → Set<track_id> — per-source ownership for multi-source merge

let activeDetailId   = null;
let chartPos         = null;
let chartVel         = null;

/* ── Monitor state ────────────────────────────────────────────────────────── */
/* monitorPanels: Map<topic, { messages:[], paused, autoScroll, count, el }> */
const monitorPanels = new Map();
const MONITOR_MAX   = 150;          // per-panel message cap
const FLASH_MS      = 220;

/* ── Telemetry state ───────────────────────────────────────────────────────── */
/* moduleData: Map<topic, { key, label, icon, data, ts, count }> */
const moduleData = new Map();

/* ── Parser state ─────────────────────────────────────────────────────────── */
let parserSSE         = null;
let parserAutoScroll  = true;
let parserLogFilter   = 'all';
let parserStats       = { packets: 0, ok: 0, errors: 0, targets: 0 };
let parserPollTimer   = null;
let parserModuleData  = {};   // { module_key: { topic, enabled, data, lastTs } }

const PARSER_MODULE_LIST = [
  ['basic_usage',    'Basic Usage',           'radar/rdxxb/parsed/basic'],
  ['frame_metadata', 'Frame Metadata',        'radar/rdxxb/parsed/frame'],
  ['radar_location', 'Radar Location',        'radar/rdxxb/parsed/location'],
  ['radar_config',   'Radar Configuration',   'radar/rdxxb/parsed/config'],
  ['radar_health',   'Radar Health',          'radar/rdxxb/parsed/health'],
  ['scan_header',    'Scan Header',           'radar/rdxxb/parsed/scan'],
  ['track_data',     'Track Data',            'radar/rdxxb/parsed/tracks'],
  ['track_metadata', 'Track Metadata',        'radar/rdxxb/parsed/track-meta'],
];

/* ── Custom Delivery field catalog ────────────────────────────────────────── */
// Format: { path: '<moduleKey>|<dot.path.in.builder.output>', label }
// moduleKey must match a key in simulator BUILDERS; dotPath navigates the return value
const CUSTOM_DELIVERY_CATALOG = [
  {
    group: 'Frame Metadata', icon: '🗂',
    fields: [
      { path: 'frame_metadata|frame_metadata.frame_count',            label: 'Frame Count' },
      { path: 'frame_metadata|frame_metadata.frame_timestamp_utc',    label: 'Timestamp (UTC)' },
      { path: 'frame_metadata|frame_metadata.frame_type',             label: 'Frame Type' },
      { path: 'frame_metadata|frame_metadata.checksum_valid',         label: 'Checksum Valid' },
      { path: 'frame_metadata|frame_metadata.protocol_device',        label: 'Protocol Device' },
      { path: 'frame_metadata|frame_metadata.protocol_major_version', label: 'Protocol Major Version' },
      { path: 'frame_metadata|frame_metadata.protocol_minor_version', label: 'Protocol Minor Version' },
    ],
  },
  {
    group: 'Radar Location & Status', icon: '📍',
    fields: [
      { path: 'radar_location|radar_device.gps.longitude',                       label: 'GPS Longitude' },
      { path: 'radar_location|radar_device.gps.latitude',                        label: 'GPS Latitude' },
      { path: 'radar_location|radar_device.gps.elevation_m',                     label: 'GPS Elevation (m)' },
      { path: 'radar_location|radar_device.gps.heading_angle_deg',               label: 'GPS Heading' },
      { path: 'radar_location|radar_device.gps.satellite_count',                 label: 'Satellite Count' },
      { path: 'radar_location|radar_device.orientation.roll_angle_deg',          label: 'Roll Angle' },
      { path: 'radar_location|radar_device.orientation.pitch_angle_deg',         label: 'Pitch Angle' },
      { path: 'radar_location|radar_device.orientation.north_correction_angle_deg', label: 'North Correction' },
      { path: 'radar_location|radar_device.operational_state.work_mode_label',   label: 'Work Mode' },
      { path: 'radar_location|radar_device.operational_state.fault_label',       label: 'Fault Status' },
      { path: 'radar_location|radar_device.operational_state.scan_mode_label',   label: 'Scan Mode' },
      { path: 'radar_location|radar_device.servo.current_azimuth_deg',           label: 'Servo Azimuth' },
      { path: 'radar_location|radar_device.servo.current_pitch_deg',             label: 'Servo Pitch' },
      { path: 'radar_location|radar_device.servo.current_scan_cycle',            label: 'Scan Cycle' },
      { path: 'radar_location|radar_device.frequency.current_x_band_ghz',        label: 'X-Band Frequency (GHz)' },
      { path: 'radar_location|radar_device.frequency.current_ku_band_ghz',       label: 'Ku-Band Frequency (GHz)' },
    ],
  },
  {
    group: 'Radar Configuration', icon: '⚙',
    fields: [
      { path: 'radar_config|radar_configuration.filters.range_min_m',                      label: 'Min Range (m)' },
      { path: 'radar_config|radar_configuration.filters.range_max_m',                      label: 'Max Range (m)' },
      { path: 'radar_config|radar_configuration.filters.speed_min_ms',                     label: 'Min Speed (m/s)' },
      { path: 'radar_config|radar_configuration.filters.speed_max_ms',                     label: 'Max Speed (m/s)' },
      { path: 'radar_config|radar_configuration.filters.height_max_m',                     label: 'Max Height (m)' },
      { path: 'radar_config|radar_configuration.autonomous_identification.enabled',        label: 'Auto ID Enabled' },
      { path: 'radar_config|radar_configuration.autonomous_identification.max_targets',    label: 'Max Targets (config)' },
      { path: 'radar_config|radar_configuration.silent_zones',                             label: 'Silent Zones (array)' },
    ],
  },
  {
    group: 'Radar Health', icon: '🩺',
    fields: [
      { path: 'radar_health|radar_health.thermals',                              label: 'Temperatures (full)' },
      { path: 'radar_health|radar_health.power',                                 label: 'Power & Currents (full)' },
      { path: 'radar_health|radar_health.system_health.fan_status',              label: 'Fan Status' },
      { path: 'radar_health|radar_health.system_health.memory_status',           label: 'Memory Status' },
      { path: 'radar_health|radar_health.firmware.fpga_version',                 label: 'FPGA Version' },
      { path: 'radar_health|radar_health.firmware.data_processing_version',      label: 'Data Processing Version' },
    ],
  },
  {
    group: 'Scan Header', icon: '🔄',
    fields: [
      { path: 'scan_header|scan_header.search_azimuth_deg',   label: 'Scan Azimuth (°)' },
      { path: 'scan_header|scan_header.search_elevation_deg', label: 'Scan Elevation (°)' },
      { path: 'scan_header|scan_header.target_count',         label: 'Target Count' },
      { path: 'scan_header|scan_header.scan_cycle_count',     label: 'Scan Cycle Count' },
      { path: 'scan_header|scan_header.pulse_group_id',       label: 'Pulse Group ID' },
    ],
  },
  {
    group: 'Track Data', icon: '🎯',
    fields: [
      { path: 'track_data|targets',          label: 'All Targets (full track data)' },
      { path: 'track_data|_meta.frame_count', label: 'Frame Count (meta)' },
    ],
  },
  {
    group: 'Track Metadata', icon: '📋',
    fields: [
      { path: 'track_metadata|targets',           label: 'All Targets (metadata)' },
      { path: 'track_metadata|_meta.frame_count', label: 'Frame Count (meta)' },
    ],
  },
  {
    group: 'Basic Usage (Combined)', icon: '📦',
    fields: [
      { path: 'basic_usage|targets',                          label: 'All Targets (basic combined)' },
      { path: 'basic_usage|radar_location',                   label: 'Radar Location (GPS + orientation)' },
      { path: 'basic_usage|_meta.frame_count',                label: 'Frame Count (basic meta)' },
    ],
  },
];

/* ═══════════════════════════════════════════════════════════════════════════════
   BOOT
 ═══════════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupMobileMenu();
  setupSidebarToggle();
  // Show current host in topbar
  const hostEl = document.getElementById('topbar-host-val');
  if (hostEl) hostEl.textContent = window.location.host;
  setupSimControls();

  document.getElementById('close-info').addEventListener('click', () => {
    document.getElementById('info-panel').style.display = 'none';
  });
  document.getElementById('close-detail').addEventListener('click', closeDetailPanel);

  CONFIG = await fetchConfig();
  initRadarInfo();
  initMap();
  animateSweep();
  connectMQTT();
  populateSettingsForm();
  setupSettingsActions();
  setupParserTab();
  setupMonitorTab();
  setupTelemetryTab();
  pollSimStatus();
  simPollTimer = setInterval(pollSimStatus, 3000);
});

/* ═══════════════════════════════════════════════════════════════════════════════
   TABS
 ═══════════════════════════════════════════════════════════════════════════════ */
const TAB_TITLES = { map: 'Map', targets: 'Targets', parser: 'Parser', monitor: 'MQTT Monitor', telemetry: 'Telemetry', simulation: 'Simulation', settings: 'Settings' };

function setupTabs() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tabName}`).classList.add('active');
      // Update topbar title
      const titleEl = document.getElementById('topbar-title');
      if (titleEl) titleEl.textContent = TAB_TITLES[tabName] || tabName;
      if (tabName === 'map' && map) {
        setTimeout(() => map.invalidateSize(), 50);
      }
      if (tabName === 'monitor') {
        if (monitorPanels.size === 0) monitorAutoPopulate();
        else                          renderMonitorPanels();
      }
      if (tabName === 'telemetry') {
        renderTelemetryTab();
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   MOBILE NAV (hamburger toggles #left-nav overlay on mobile)
 ═══════════════════════════════════════════════════════════════════════════════ */
function setupMobileMenu() {
  const hamburger = document.getElementById('hamburger-menu');
  const leftNav   = document.getElementById('left-nav');
  const backdrop  = document.getElementById('nav-backdrop');

  if (!hamburger || !leftNav) return;

  function openNav() {
    leftNav.classList.add('open');
    hamburger.classList.add('active');
    if (backdrop) backdrop.classList.add('active');
  }

  function closeNav() {
    leftNav.classList.remove('open');
    hamburger.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
  }

  hamburger.addEventListener('click', () => {
    leftNav.classList.contains('open') ? closeNav() : openNav();
  });

  if (backdrop) {
    backdrop.addEventListener('click', closeNav);
  }

  // Close nav after selecting a tab on mobile
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.innerWidth <= 640) closeNav();
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SIDEBAR TOGGLE
 ═══════════════════════════════════════════════════════════════════════════════ */
function setupSidebarToggle() {
  const sidebar  = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const backdrop  = document.getElementById('sidebar-backdrop');
  const icon      = toggleBtn.querySelector('.sidebar-toggle-icon');

  const isMobile = () => window.innerWidth <= 640;

  function updateIcon() {
    icon.textContent = sidebar.classList.contains('collapsed') ? '›' : '‹';
  }

  function closeSidebar() {
    sidebar.classList.add('collapsed');
    if (backdrop) backdrop.classList.remove('active');
    updateIcon();
  }

  function openSidebar() {
    sidebar.classList.remove('collapsed');
    if (isMobile() && backdrop) backdrop.classList.add('active');
    updateIcon();
    if (!isMobile() && map) setTimeout(() => map.invalidateSize(), 320);
  }

  // Start collapsed on mobile
  if (isMobile()) {
    sidebar.classList.add('collapsed');
  }
  updateIcon();

  toggleBtn.addEventListener('click', () => {
    if (sidebar.classList.contains('collapsed')) {
      openSidebar();
    } else {
      closeSidebar();
      if (!isMobile() && map) setTimeout(() => map.invalidateSize(), 320);
    }
  });

  // Close sidebar when backdrop is clicked (mobile)
  if (backdrop) {
    backdrop.addEventListener('click', closeSidebar);
  }

  // Re-evaluate on resize
  let prevMobile = isMobile();
  window.addEventListener('resize', () => {
    const nowMobile = isMobile();
    if (nowMobile !== prevMobile) {
      prevMobile = nowMobile;
      closeSidebar();
      if (!nowMobile && map) setTimeout(() => map.invalidateSize(), 320);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CONFIG
 ═══════════════════════════════════════════════════════════════════════════════ */
async function fetchConfig() {
  const res = await fetch('/api/config');
  return res.json();
}

function initRadarInfo() {
  const { latitude, longitude, elevation_m } = CONFIG.radar;
  document.getElementById('radar-lat').textContent = latitude.toFixed(6);
  document.getElementById('radar-lon').textContent = longitude.toFixed(6);
  document.getElementById('radar-alt').textContent = `${elevation_m} m`;
}

/* ── Map Setup ───────────────────────────────────────────────────────────────── */
function initMap() {
  const { latitude, longitude } = CONFIG.radar;

  map = L.map('map', { zoomControl: true, attributionControl: true })
    .setView([latitude, longitude], 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  // Radar marker
  L.marker([latitude, longitude], {
    icon: L.divIcon({
      html: '<div class="radar-icon">📡</div>',
      iconSize: [32, 32], iconAnchor: [16, 16], className: '',
    }),
    zIndexOffset: 2000,
  }).addTo(map)
    .bindTooltip(`RDXXB Radar · ${latitude.toFixed(4)}°, ${longitude.toFixed(4)}° · ${CONFIG.radar.elevation_m} m`);

  // Outer range ring (7 500 m)
  L.circle([latitude, longitude], {
    radius: RADAR_RANGE_M, color: '#00ff88',
    weight: 1, opacity: 0.35, fillOpacity: 0.02, dashArray: '6, 12',
  }).addTo(map);

  // Inner range ring (3 000 m)
  L.circle([latitude, longitude], {
    radius: INNER_RANGE_M, color: '#00ff88',
    weight: 1, opacity: 0.20, fillOpacity: 0, dashArray: '3, 8',
  }).addTo(map);

  // Sweep line (updated in animateSweep)
  sweepLine = L.polyline([[latitude, longitude], [latitude, longitude]], {
    color: '#00ff88', weight: 2, opacity: 0.7,
  }).addTo(map);
}

/* ── Sweep Animation ─────────────────────────────────────────────────────────── */
function animateSweep() {
  function frame(now) {
    const dt    = (now - lastSweepTime) / 1000;
    lastSweepTime = now;
    sweepAngle  = (sweepAngle + SCAN_SPEED_DEG_S * dt) % 360;

    if (map && CONFIG) {
      const { latitude: rLat, longitude: rLon } = CONFIG.radar;
      const rad    = sweepAngle * Math.PI / 180;
      const cosLat = Math.cos(rLat * Math.PI / 180);
      const endLat = rLat + (RADAR_RANGE_M * Math.cos(rad)) / 110540;
      const endLon = rLon + (RADAR_RANGE_M * Math.sin(rad)) / (111320 * cosLat);
      sweepLine.setLatLngs([[rLat, rLon], [endLat, endLon]]);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ── MQTT ───────────────────────────────────────────────────────────────────── */
function connectMQTT(cfgOverride) {
  if (mqttClient) {
    try { mqttClient.end(true); } catch(_) {}
    mqttClient = null;
  }

  const dm = cfgOverride || CONFIG.display_mqtt;
  const url      = `${dm.protocol}://${dm.host}:${dm.port}`;
  const clientId = `rdxxb-webapp-${Math.random().toString(16).slice(2, 8)}`;
  const opts = { clientId, clean: true };
  if (dm.username) opts.username = dm.username;
  if (dm.password) opts.password = dm.password;

  setMqttBadge('connecting', `MQTT…`);
  mqttClient = mqtt.connect(url, opts);

  mqttClient.on('connect', () => {
    setMqttBadge('connected', `● ${dm.host}:${dm.port}`);
    mqttClient.subscribe(dm.topic, (err) => {
      if (err) console.error('[MQTT] Subscribe error:', err.message);
    });
    // Subscribe to ALL module topics so telemetry always receives data
    const allMods = CONFIG?.simulation_modules || {};
    Object.values(allMods).forEach(m => {
      if (m.topic && m.topic !== dm.topic) mqttClient.subscribe(m.topic, () => {});
    });
    // Subscribe to simulator topic for map targets
    const simTopic = CONFIG?.sim_mqtt?.topic;
    if (simTopic && simTopic !== dm.topic) mqttClient.subscribe(simTopic, () => {});
    // Re-subscribe all monitor panel topics (after reconnect)
    monitorPanels.forEach((_, t) => {
      if (t !== dm.topic) mqttClient.subscribe(t, () => {});
    });
  });

  mqttClient.on('message', (topic, message) => {
    // Forward raw to monitor panels (no parsing needed there)
    monitorMessage(topic, message);
    // Parse JSON for map targets + telemetry data store
    try {
      const data = JSON.parse(message.toString());
      // Any topic that carries a targets array feeds the map (multi-source aware)
      if (Array.isArray(data?.targets)) {
        updateTargetsFromSource(topic, data);
      }
      updateModuleData(topic, data);
    } catch (e) {
      console.error('[MQTT] Parse error:', e);
    }
  });

  mqttClient.on('error',     (err) => setMqttBadge('error',        `✗ ${err.message}`));
  mqttClient.on('close',     ()    => setMqttBadge('disconnected', '○ Disconnected'));
  mqttClient.on('reconnect', ()    => setMqttBadge('connecting',   'Reconnecting…'));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   TARGET UPDATES
 ═══════════════════════════════════════════════════════════════════════════════ */
function updateTargetsFromSource(sourceTopic, data) {
  const targets = data.targets || [];
  const newIds  = new Set(targets.map(t => t.track_id));

  // Track ownership per source so multiple sources don't wipe each other
  if (!targetSources.has(sourceTopic)) targetSources.set(sourceTopic, new Set());
  const oldIds = targetSources.get(sourceTopic);

  targets.forEach(target => {
    const id  = target.track_id;
    const lat = target.latitude;
    const lon = target.longitude;
    if (lat == null || lon == null || !map) return;

    // Store latest data
    targetData[id] = target;

    // ── Chart history ──────────────────────────────────────────────────────────
    if (!chartHistory[id]) {
      chartHistory[id] = { distance: [], altitude: [], speed: [], vx: [], vy: [], vz: [] };
    }
    const h = chartHistory[id];
    h.distance.push(+(target.distance_m || 0).toFixed(1));
    h.altitude.push(+(target.altitude_m || 0).toFixed(1));
    h.speed.push(+Math.abs(target.radial_speed_ms || 0).toFixed(2));
    h.vx.push(+(target.vx_east_ms  || 0).toFixed(2));
    h.vy.push(+(target.vy_north_ms || 0).toFixed(2));
    h.vz.push(+(target.vz_up_ms    || 0).toFixed(2));
    if (h.distance.length > CHART_HISTORY) {
      h.distance.shift(); h.altitude.shift(); h.speed.shift();
      h.vx.shift(); h.vy.shift(); h.vz.shift();
    }

    // ── Trail ──────────────────────────────────────────────────────────────────
    if (!targetHistory[id]) targetHistory[id] = [];
    targetHistory[id].push([lat, lon]);
    if (targetHistory[id].length > MAX_TRAIL_POINTS) targetHistory[id].shift();

    const trailColor = getColor(target.track_type_label);
    if (targetTrails[id]) {
      targetTrails[id].setLatLngs(targetHistory[id]);
    } else {
      targetTrails[id] = L.polyline(targetHistory[id], {
        color: trailColor, weight: 1.5, opacity: 0.45, dashArray: '4, 6',
      }).addTo(map);
    }

    // ── Marker ─────────────────────────────────────────────────────────────────
    const icon = buildIcon(target.track_type_label);
    if (targetMarkers[id]) {
      targetMarkers[id].setLatLng([lat, lon]);
      targetMarkers[id].setIcon(icon);
    } else {
      targetMarkers[id] = L.marker([lat, lon], { icon, zIndexOffset: 100 })
        .addTo(map)
        .on('click', () => showTargetDetail(target));
    }

    // Store latest data for click handler
    targetMarkers[id]._radarData = target;

    // Tooltip
    targetMarkers[id].bindTooltip(
      `<b>#${id} ${target.track_type_label.toUpperCase()}</b><br>` +
      `${(target.distance_m || 0).toFixed(0)} m · ${(target.azimuth_deg || 0).toFixed(1)}°<br>` +
      `Alt ${(target.altitude_m || 0).toFixed(0)} m · Conf ${((target.confidence || 0) * 100).toFixed(0)}%`,
      { direction: 'top', offset: [0, -12], className: 'leaflet-tooltip-dark' }
    );
  });

  // ── Remove stale targets from THIS source only ─────────────────────────────
  oldIds.forEach(id => {
    if (!newIds.has(id)) {
      if (targetMarkers[id]) { map.removeLayer(targetMarkers[id]); delete targetMarkers[id]; }
      if (targetTrails[id])  { map.removeLayer(targetTrails[id]);  delete targetTrails[id];  }
      delete targetHistory[id];
      delete targetData[id];
      if (chartHistory[id]) delete chartHistory[id];
    }
  });
  targetSources.set(sourceTopic, newIds);

  // ── Refresh sidebar/table with ALL live targets (all sources merged) ─────────
  const allTargets = Object.values(targetData);
  updateSidebar(allTargets);
  updateTable(allTargets);
}

// Legacy alias kept in case anything still calls updateTargets directly
function updateTargets(data) { updateTargetsFromSource('__legacy__', data); }

/* ── Sidebar Target List ─────────────────────────────────────────────────────── */
function updateSidebar(targets) {
  document.getElementById('target-count').textContent = targets.length;
  document.getElementById('target-list').innerHTML = targets.map(t => `
    <div class="target-item" onclick="centerOnTarget(${t.track_id})">
      <span class="target-type-dot" style="background:${getColor(t.track_type_label)}"></span>
      <span>#${t.track_id} ${t.track_type_label.toUpperCase()}</span>
      <span class="target-dist">${t.distance_m.toFixed(0)} m</span>
    </div>
  `).join('');
}

/* ── Map Detail Panel (click marker) ──────────────────────────────────────────── */
function showTargetDetail(t) {
  document.getElementById('info-panel').style.display = 'block';
  document.getElementById('info-content').innerHTML = [
    ['Track ID',    `#${t.track_id}`],
    ['Type',        `<span class="type-label">${t.track_type_label.toUpperCase()}</span>`],
    ['Confidence',  `${(t.confidence * 100).toFixed(0)} %`],
    ['Distance',    `${t.distance_m.toFixed(1)} m`],
    ['Azimuth',     `${t.azimuth_deg.toFixed(1)} °`],
    ['Elevation',   `${t.elevation_pitch_deg.toFixed(2)} °`],
    ['Altitude',    `${t.altitude_m.toFixed(1)} m`],
    ['Radial Speed',`${t.radial_speed_ms.toFixed(2)} m/s`],
    ['Vx East',     `${t.vx_east_ms.toFixed(2)} m/s`],
    ['Vy North',    `${t.vy_north_ms.toFixed(2)} m/s`],
    ['Vz Up',       `${t.vz_up_ms.toFixed(2)} m/s`],
    ['Latitude',    t.latitude.toFixed(6)],
    ['Longitude',   t.longitude.toFixed(6)],
    ['Energy',      t.energy.toFixed(1)],
    ['Credit Ratio',`${(t.credit_ratio * 100).toFixed(0)} %`],
    ['Track Status',t.track_status],
  ].map(([k, v]) => `<div class="info-row"><span>${k}</span><span>${v}</span></div>`).join('');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   TARGETS TABLE
 ═══════════════════════════════════════════════════════════════════════════════ */
function updateTable(targets) {
  const tbody = document.getElementById('target-tbody');
  if (!tbody) return;
  const rows = {};
  tbody.querySelectorAll('tr[data-id]').forEach(r => { rows[r.dataset.id] = r; });

  targets.forEach(t => {
    const id   = t.track_id;
    const conf = (t.confidence * 100).toFixed(0);
    const sig  = Math.min(100, ((t.energy || 0) / 5000) * 100).toFixed(0);
    const color = getColor(t.track_type_label);

    const cellContent = [
      `#${id}`,
      `<span class="type-badge" style="background:${color}">${t.track_type_label.toUpperCase()}</span>`,
      `<div class="mini-bar-wrap"><div class="mini-bar" style="width:${conf}%;background:#00ff88"></div></div><span class="mini-bar-val">${conf}%</span>`,
      `<div class="mini-bar-wrap"><div class="mini-bar" style="width:${sig}%;background:#4488ff"></div></div><span class="mini-bar-val">${sig}%</span>`,
      `${t.distance_m.toFixed(0)}`,
      `${t.azimuth_deg.toFixed(1)}`,
      `${t.elevation_pitch_deg.toFixed(1)}`,
      `${t.altitude_m.toFixed(0)}`,
      `${t.radial_speed_ms.toFixed(2)}`,
      `${t.latitude.toFixed(5)}`,
      `${t.longitude.toFixed(5)}`,
      new Date().toLocaleTimeString(),
    ];

    if (rows[id]) {
      const tds = rows[id].querySelectorAll('td');
      cellContent.forEach((c, i) => { if (tds[i]) tds[i].innerHTML = c; });
    } else {
      const tr = document.createElement('tr');
      tr.dataset.id = id;
      tr.innerHTML = cellContent.map(c => `<td>${c}</td>`).join('');
      tr.addEventListener('click', () => openDetailPanel(id));
      tbody.appendChild(tr);
    }
  });

  // Remove rows for gone targets
  const activeIds = new Set(targets.map(t => String(t.track_id)));
  tbody.querySelectorAll('tr[data-id]').forEach(r => {
    if (!activeIds.has(r.dataset.id)) r.remove();
  });

  // Refresh charts if detail panel is open
  if (activeDetailId !== null && chartHistory[activeDetailId]) {
    refreshDetailCharts(activeDetailId);
  }
}

/* ── Targets Tab Detail Panel (with Chart.js) ──────────────────────────────── */
function openDetailPanel(id) {
  activeDetailId = id;
  const t = targetData[id];
  if (!t) return;

  const panel = document.getElementById('detail-panel');
  panel.classList.add('open');
  document.getElementById('detail-title').textContent = `TARGET #${id} — ${t.track_type_label.toUpperCase()}`;

  document.getElementById('detail-fields').innerHTML = [
    ['Confidence',   `${(t.confidence * 100).toFixed(1)} %`],
    ['Distance',     `${t.distance_m.toFixed(1)} m`],
    ['Azimuth',      `${t.azimuth_deg.toFixed(2)} °`],
    ['Elevation',    `${t.elevation_pitch_deg.toFixed(2)} °`],
    ['Altitude',     `${t.altitude_m.toFixed(1)} m`],
    ['Radial Speed', `${t.radial_speed_ms.toFixed(2)} m/s`],
    ['Vx East',      `${t.vx_east_ms.toFixed(2)} m/s`],
    ['Vy North',     `${t.vy_north_ms.toFixed(2)} m/s`],
    ['Vz Up',        `${t.vz_up_ms.toFixed(2)} m/s`],
    ['Lat / Lon',    `${t.latitude.toFixed(5)}, ${t.longitude.toFixed(5)}`],
    ['Energy',       t.energy.toFixed(1)],
    ['Track Status', t.track_status],
  ].map(([k, v]) => `<div class="detail-row"><span>${k}</span><span>${v}</span></div>`).join('');

  buildDetailCharts(id);
}

function closeDetailPanel() {
  activeDetailId = null;
  document.getElementById('detail-panel').classList.remove('open');
  if (chartPos) { chartPos.destroy(); chartPos = null; }
  if (chartVel) { chartVel.destroy(); chartVel = null; }
}

function buildDetailCharts(id) {
  if (chartPos) { chartPos.destroy(); chartPos = null; }
  if (chartVel) { chartVel.destroy(); chartVel = null; }

  const h = chartHistory[id] || {};
  const labels = h.distance ? h.distance.map((_, i) => i + 1) : [];

  const chartDefaults = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#ccc', boxWidth: 12 } } },
    scales: {
      x: { ticks: { color: '#888', maxTicksLimit: 8 }, grid: { color: '#333' } },
      y: { ticks: { color: '#888' }, grid: { color: '#333' } },
    },
  };

  chartPos = new Chart(document.getElementById('chart-pos'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Distance (m)', data: h.distance || [], borderColor: '#00ff88', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
        { label: 'Altitude (m)', data: h.altitude || [], borderColor: '#4488ff', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: chartDefaults,
  });

  chartVel = new Chart(document.getElementById('chart-vel'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Radial (m/s)', data: h.speed || [], borderColor: '#ff4444', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
        { label: 'Vx East',     data: h.vx    || [], borderColor: '#ffaa00', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
        { label: 'Vy North',    data: h.vy    || [], borderColor: '#aa88ff', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: chartDefaults,
  });
}

function refreshDetailCharts(id) {
  const h = chartHistory[id];
  if (!h || !chartPos || !chartVel) return;
  const labels = h.distance.map((_, i) => i + 1);
  chartPos.data.labels = labels;
  chartPos.data.datasets[0].data = h.distance;
  chartPos.data.datasets[1].data = h.altitude;
  chartPos.update('none');
  chartVel.data.labels = labels;
  chartVel.data.datasets[0].data = h.speed;
  chartVel.data.datasets[1].data = h.vx;
  chartVel.data.datasets[2].data = h.vy;
  chartVel.update('none');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SETTINGS
 ═══════════════════════════════════════════════════════════════════════════════ */
function populateSettingsForm() {
  if (!CONFIG) return;
  const sm = CONFIG.sim_mqtt     || {};
  const dm = CONFIG.display_mqtt || {};
  const r  = CONFIG.radar        || {};
  const s  = CONFIG.simulator    || {};

  // Sim MQTT
  setVal('sim-protocol', sm.protocol || 'mqtt');
  setVal('sim-host',     sm.host     || '');
  setVal('sim-port',     sm.port     || 1883);
  setVal('sim-username', sm.username || '');
  setVal('sim-password', sm.password || '');
  setVal('sim-topic',    sm.topic    || '');
  // Display MQTT
  setVal('disp-protocol', dm.protocol || 'ws');
  setVal('disp-host',     dm.host     || '');
  setVal('disp-port',     dm.port     || 9001);
  setVal('disp-username', dm.username || '');
  setVal('disp-password', dm.password || '');
  setVal('disp-topic',    dm.topic    || '');
  // Radar
  setVal('r-lon',   r.longitude                   || 0);
  setVal('r-lat',   r.latitude                    || 0);
  setVal('r-alt',   r.elevation_m                 || 0);
  setVal('r-roll',  r.roll_angle_deg              || 0);
  setVal('r-pitch', r.pitch_angle_deg             || 0);
  setVal('r-north', r.north_correction_angle_deg  || 0);
  // Simulator (now in Simulation tab)
  setVal('s-interval', s.publishIntervalMs || 500);
  setVal('s-targets',  s.targetCount       || 5);
  // Simulation modules
  const mods = CONFIG.simulation_modules || {};
  const MOD_KEYS = ['basic_usage','frame_metadata','radar_location','radar_config',
                    'radar_health','scan_header','track_data','track_metadata'];
  MOD_KEYS.forEach(key => {
    const m = mods[key] || {};
    const en = document.getElementById(`mod-${key}-enabled`);
    const tp = document.getElementById(`mod-${key}-topic`);
    if (en) en.checked = !!m.enabled;
    if (tp) tp.value   = m.topic || '';
  });
  // Parser
  const p = CONFIG.parser || {};
  setVal('p-host',  p.udp_host   || '0.0.0.0');
  setVal('p-port',  p.udp_port   || 20202);
  const mqttChk = document.getElementById('p-mqtt-enabled');
  if (mqttChk) mqttChk.checked = !!p.mqtt_enabled;
  const broker = p.mqtt_broker || {};
  setVal('p-mqtt-host', broker.host || '127.0.0.1');
  setVal('p-mqtt-port', broker.port || 1883);
  setVal('p-mqtt-user', broker.username || '');
  setVal('p-mqtt-pass', broker.password || '');
  setVal('p-publish-mode',    p.publish_mode    || 'modular');
  setVal('p-aggregate-topic', p.aggregate_topic || 'radar/rdxxb/parsed');
  renderParserModulesTable(p.modules || {});
  // Custom delivery
  renderCustomDeliveryList(CONFIG.custom_delivery || []);
}

function collectSettingsForm() {
  return {
    sim_mqtt: {
      protocol: getVal('sim-protocol'),
      host:     getVal('sim-host'),
      port:     +getVal('sim-port'),
      username: getVal('sim-username'),
      password: getVal('sim-password'),
      topic:    getVal('sim-topic'),
    },
    display_mqtt: {
      protocol: getVal('disp-protocol'),
      host:     getVal('disp-host'),
      port:     +getVal('disp-port'),
      username: getVal('disp-username'),
      password: getVal('disp-password'),
      topic:    getVal('disp-topic'),
    },
    radar: {
      longitude:                  +getVal('r-lon'),
      latitude:                   +getVal('r-lat'),
      elevation_m:                +getVal('r-alt'),
      roll_angle_deg:             +getVal('r-roll'),
      pitch_angle_deg:            +getVal('r-pitch'),
      north_correction_angle_deg: +getVal('r-north'),
    },
    parser: {
      udp_host:        getVal('p-host') || '0.0.0.0',
      udp_port:        +getVal('p-port') || 20202,
      mqtt_enabled:    !!(document.getElementById('p-mqtt-enabled')?.checked),
      mqtt_broker: {
        protocol: 'mqtt',
        host:     getVal('p-mqtt-host') || '127.0.0.1',
        port:     +getVal('p-mqtt-port') || 1883,
        username: getVal('p-mqtt-user') || '',
        password: getVal('p-mqtt-pass') || '',
      },
      publish_mode:    getVal('p-publish-mode')    || 'modular',
      aggregate_topic: getVal('p-aggregate-topic') || 'radar/rdxxb/parsed',
      modules:         collectParserModulesFromTable(),
    },
  };
}

function setupSettingsActions() {
  document.getElementById('btn-save-config').addEventListener('click', saveConfig);
  document.getElementById('btn-apply-disp').addEventListener('click', () => {
    const dm = collectSettingsForm().display_mqtt;
    CONFIG.display_mqtt = dm;
    connectMQTT(dm);
    toast('Dashboard MQTT reconnecting…');
  });
  // Simulation tab buttons
  document.getElementById('btn-save-sim-config').addEventListener('click', saveSimConfig);
  document.getElementById('btn-start-sim').addEventListener('click', startSimulation);
  document.getElementById('btn-stop-sim').addEventListener('click', stopSimulation);
  const MOD_KEYS_ALL = ['basic_usage','frame_metadata','radar_location','radar_config',
                        'radar_health','scan_header','track_data','track_metadata'];
  document.getElementById('btn-enable-all-mods')?.addEventListener('click', () => {
    MOD_KEYS_ALL.forEach(k => { const el = document.getElementById(`mod-${k}-enabled`); if (el) el.checked = true; });
  });
  document.getElementById('btn-disable-all-mods')?.addEventListener('click', () => {
    MOD_KEYS_ALL.forEach(k => { const el = document.getElementById(`mod-${k}-enabled`); if (el) el.checked = false; });
  });
  // Top-bar buttons
  document.getElementById('btn-start-top').addEventListener('click', startSimulation);
  document.getElementById('btn-stop-top').addEventListener('click', stopSimulation);
  // Custom delivery
  setupCustomDelivery();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   MQTT MONITOR
 ═══════════════════════════════════════════════════════════════════════════════ */

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function monitorFormatSize(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`;
}

function monitorFormatTs(d) {
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function monitorPrettyPayload(raw) {
  try   { return JSON.stringify(JSON.parse(raw), null, 2); }
  catch { return raw; }
}

/* ── Add / remove subscription panels ────────────────────────────────────── */
function monitorSubscribe(topic) {
  topic = (topic || '').trim();
  if (!topic || monitorPanels.has(topic)) return;

  const panel = { topic, messages: [], paused: false, autoScroll: true, count: 0, el: null };
  monitorPanels.set(topic, panel);

  if (mqttClient && mqttClient.connected) {
    mqttClient.subscribe(topic, err => {
      if (err) console.error('[Monitor] Subscribe error:', err.message);
    });
  }
  renderMonitorPanels();
}

function monitorUnsubscribe(topic) {
  if (!monitorPanels.has(topic)) return;
  monitorPanels.delete(topic);
  const mainTopic = CONFIG?.display_mqtt?.topic;
  if (topic !== mainTopic && mqttClient && mqttClient.connected) {
    mqttClient.unsubscribe(topic, () => {});
  }
  renderMonitorPanels();
}

function monitorCloseAll() {
  const topics = [...monitorPanels.keys()];
  topics.forEach(monitorUnsubscribe);
}

function monitorAutoPopulate() {
  // Close all existing windows first, then open all module topics
  monitorCloseAll();
  const mainTopic = CONFIG?.display_mqtt?.topic;
  if (mainTopic) monitorSubscribe(mainTopic);
  const mods = CONFIG?.simulation_modules || {};
  Object.values(mods).forEach(m => {
    if (m.topic && m.topic !== mainTopic) monitorSubscribe(m.topic);
  });
  // Also subscribe to enabled custom delivery topics
  const cdChannels = CONFIG?.custom_delivery || [];
  cdChannels.forEach(ch => {
    if (ch.enabled && ch.topic && ch.topic !== mainTopic) monitorSubscribe(ch.topic);
  });
}

/* ── Incoming message dispatch ───────────────────────────────────────────── */
function monitorMessage(topic, raw) {
  const panel = monitorPanels.get(topic);
  if (!panel) return;

  panel.count++;   // Always increment total counter (even when paused)

  if (panel.paused) { updatePanelHeader(panel); return; }

  const payload = raw.toString();
  panel.messages.push({
    ts: monitorFormatTs(new Date()),
    payload,
    size: raw.length,
  });
  if (panel.messages.length > MONITOR_MAX) panel.messages.shift();

  // Only render if tab is visible, otherwise just store
  if (document.getElementById('tab-monitor')?.classList.contains('active')) {
    appendPanelMessage(panel, panel.messages[panel.messages.length - 1]);
    updatePanelHeader(panel);
  }
}

/* ── Rendering: full rebuild ─────────────────────────────────────────────── */
function renderMonitorPanels() {
  const host = document.getElementById('monitor-panels');
  const chip = document.getElementById('monitor-panel-count');
  if (!host) return;

  if (chip) chip.textContent = `${monitorPanels.size} window${monitorPanels.size === 1 ? '' : 's'}`;

  if (monitorPanels.size === 0) {
    host.innerHTML = `
      <div class="monitor-empty-state">
        <div class="monitor-empty-icon">📟</div>
        <div class="monitor-empty-title">No monitor windows open</div>
        <div class="monitor-empty-hint">Add a topic above or click <b>Add All Modules</b> to start watching MQTT traffic.</div>
      </div>`;
    return;
  }

  host.innerHTML = '';
  monitorPanels.forEach(panel => {
    const el = buildPanelElement(panel);
    panel.el = el;
    host.appendChild(el);
    // Replay existing messages
    const body = el.querySelector('.mon-panel-body');
    if (panel.messages.length === 0) {
      body.innerHTML = '<div class="mon-panel-idle">Waiting for messages on this topic…</div>';
    } else {
      body.innerHTML = '';
      panel.messages.forEach(m => body.appendChild(buildMsgElement(m)));
      if (panel.autoScroll) body.scrollTop = body.scrollHeight;
    }
  });
}

/* ── Build one panel DOM node ────────────────────────────────────────────── */
function buildPanelElement(panel) {
  const el = document.createElement('div');
  el.className = 'mon-panel';
  el.dataset.topic = panel.topic;
  el.innerHTML = `
    <div class="mon-panel-head">
      <div class="mon-dots">
        <span class="mon-dot close-dot" title="Close"></span>
        <span class="mon-dot"></span>
        <span class="mon-dot live" title="Live"></span>
      </div>
      <div class="mon-panel-title">${escHtml(panel.topic)}</div>
      <div class="mon-panel-meta">
        <span class="panel-count">0</span> msg
      </div>
      <div class="mon-panel-actions">
        <button class="mon-panel-btn btn-autoscroll ${panel.autoScroll ? 'active' : ''}" title="Auto-scroll to newest">↓</button>
        <button class="mon-panel-btn btn-pause" title="Pause / Resume">⏸</button>
        <button class="mon-panel-btn btn-clear" title="Clear messages">🗑</button>
        <button class="mon-panel-btn close-btn btn-close" title="Close window">✕</button>
      </div>
    </div>
    <div class="mon-panel-body"></div>
  `;

  // Wire actions
  el.querySelector('.btn-close')      .addEventListener('click', () => monitorUnsubscribe(panel.topic));
  el.querySelector('.close-dot')      .addEventListener('click', () => monitorUnsubscribe(panel.topic));
  el.querySelector('.btn-autoscroll') .addEventListener('click', e => {
    panel.autoScroll = !panel.autoScroll;
    e.currentTarget.classList.toggle('active', panel.autoScroll);
    if (panel.autoScroll) {
      const body = el.querySelector('.mon-panel-body');
      body.scrollTop = body.scrollHeight;
    }
  });
  el.querySelector('.btn-pause').addEventListener('click', e => {
    panel.paused = !panel.paused;
    const btn = e.currentTarget;
    btn.textContent = panel.paused ? '▶' : '⏸';
    btn.classList.toggle('active', panel.paused);
    btn.title = panel.paused ? 'Resume' : 'Pause';
    el.querySelector('.mon-dot.live')?.classList.toggle('live', !panel.paused);
  });
  el.querySelector('.btn-clear').addEventListener('click', () => {
    panel.messages.length = 0;
    panel.count = 0;
    const body = el.querySelector('.mon-panel-body');
    body.innerHTML = '<div class="mon-panel-idle">Cleared. Waiting for new messages…</div>';
    updatePanelHeader(panel);
  });

  return el;
}

/* ── Build one message DOM node ──────────────────────────────────────────── */
function buildMsgElement(msg) {
  const row = document.createElement('div');
  row.className = 'mon-msg';
  const preview = msg.payload.length > 160 ? msg.payload.slice(0, 160) + '…' : msg.payload;
  row.innerHTML = `
    <div class="mon-msg-hdr">
      <span class="mon-msg-arrow">▶</span>
      <span class="mon-msg-ts">${escHtml(msg.ts)}</span>
      <span class="mon-msg-size">${escHtml(monitorFormatSize(msg.size))}</span>
      <span class="mon-msg-preview">${escHtml(preview)}</span>
    </div>
    <pre class="mon-msg-body"></pre>
  `;
  const hdr = row.querySelector('.mon-msg-hdr');
  const body = row.querySelector('.mon-msg-body');
  hdr.addEventListener('click', () => {
    const willOpen = !row.classList.contains('open');
    if (willOpen && !body.textContent) body.textContent = monitorPrettyPayload(msg.payload);
    row.classList.toggle('open');
  });
  return row;
}

/* ── Append one message to an existing panel (streaming) ─────────────────── */
function appendPanelMessage(panel, msg) {
  if (!panel.el) return;
  const body = panel.el.querySelector('.mon-panel-body');
  if (!body) return;
  const idle = body.querySelector('.mon-panel-idle');
  if (idle) body.innerHTML = '';

  body.appendChild(buildMsgElement(msg));

  // Trim from top to match the cap
  while (body.children.length > MONITOR_MAX) body.removeChild(body.firstChild);

  if (panel.autoScroll) body.scrollTop = body.scrollHeight;

  // Brief green border flash
  panel.el.classList.add('flash');
  clearTimeout(panel._flashTimer);
  panel._flashTimer = setTimeout(() => panel.el?.classList.remove('flash'), FLASH_MS);
}

/* ── Update the message counter in a panel header ────────────────────────── */
function updatePanelHeader(panel) {
  if (!panel.el) return;
  const c = panel.el.querySelector('.panel-count');
  if (c) c.textContent = panel.count.toLocaleString();
}

/* ── Tab wiring ──────────────────────────────────────────────────────────── */
function setupMonitorTab() {
  const input = document.getElementById('monitor-topic-input');

  document.getElementById('btn-monitor-sub')?.addEventListener('click', () => {
    if (input?.value.trim()) { monitorSubscribe(input.value.trim()); input.value = ''; }
  });

  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-monitor-sub')?.click();
  });

  document.getElementById('btn-monitor-add-all')?.addEventListener('click', monitorAutoPopulate);
  document.getElementById('btn-monitor-close-all')?.addEventListener('click', monitorCloseAll);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   TELEMETRY TAB  —  live latest parsed data per module topic
 ═══════════════════════════════════════════════════════════════════════════════ */

const MODULE_META = {
  basic_usage:    { label: 'Basic Usage',              icon: '📡', desc: 'Targets + radar location' },
  frame_metadata: { label: 'Frame Metadata',           icon: '🗂',  desc: 'Protocol framing info' },
  radar_location: { label: 'Radar Location & Status',  icon: '📍', desc: 'GPS, orientation, state' },
  radar_config:   { label: 'Radar Configuration',      icon: '⚙️', desc: 'Filters & silent zones' },
  radar_health:   { label: 'Radar Health',             icon: '🩺', desc: 'Thermals, power, firmware' },
  scan_header:    { label: 'Scan Header',              icon: '🔄', desc: 'Sweep angle, scan cycle' },
  track_data:     { label: 'Track Data',               icon: '🎯', desc: 'Per-target track records' },
  track_metadata: { label: 'Track Metadata',           icon: '🏷',  desc: 'Track age & timestamps' },
};

function setupTelemetryTab() {
  // Nothing to wire up — rendering happens in renderTelemetryTab()
}

function updateModuleData(topic, data) {
  const mods = CONFIG?.simulation_modules || {};
  let matchKey = null;
  for (const [key, mod] of Object.entries(mods)) {
    if (mod.topic === topic) { matchKey = key; break; }
  }
  if (!matchKey) return;

  let entry = moduleData.get(topic);
  if (!entry) {
    const meta = MODULE_META[matchKey] || { label: matchKey, icon: '📦', desc: '' };
    entry = { key: matchKey, label: meta.label, icon: meta.icon, data: null, ts: null, count: 0 };
    moduleData.set(topic, entry);
  }
  entry.data  = data;
  entry.ts    = new Date();
  entry.count++;

  if (document.getElementById('tab-telemetry')?.classList.contains('active')) {
    updateTelemetryCard(topic, entry);
  }
}

function renderTelemetryTab() {
  const wrap = document.getElementById('telemetry-cards');
  if (!wrap) return;
  const mods = CONFIG?.simulation_modules || {};
  const allMods = Object.entries(mods);

  wrap.innerHTML = '';
  if (allMods.length === 0) {
    wrap.innerHTML = '<div class="telem-empty">No modules configured.</div>';
    return;
  }
  // Always show all 8 modules — enabled or not
  for (const [key, mod] of allMods) {
    const meta  = MODULE_META[key] || { label: key, icon: '📦', desc: '' };
    const entry = moduleData.get(mod.topic);
    wrap.appendChild(buildTelemetryCard(key, mod.topic, meta, entry, mod.enabled));
  }
}

function buildTelemetryCard(key, topic, meta, entry, enabled) {
  const el = document.createElement('div');
  el.className   = 'telem-card';
  el.dataset.topic = topic;
  if (!enabled) el.classList.add('telem-card-disabled');

  const hasData  = entry?.data != null;
  const tsStr    = entry?.ts ? entry.ts.toTimeString().slice(0, 8) : '—';
  const countStr = entry?.count?.toLocaleString() ?? '0';

  el.innerHTML = `
    <div class="telem-card-head">
      <span class="telem-card-icon">${meta.icon}</span>
      <div class="telem-card-meta">
        <div class="telem-card-title">${escHtml(meta.label)}</div>
        <div class="telem-card-topic">${escHtml(topic)}</div>
      </div>
      <div class="telem-card-stats">
        <span class="telem-mod-badge ${enabled ? 'telem-mod-on' : 'telem-mod-off'}">${enabled ? 'ON' : 'OFF'}</span>
        <span class="telem-stat ${hasData ? 'telem-live' : 'telem-idle'}">${hasData ? '● LIVE' : '○ Waiting'}</span>
        <span class="telem-count">${countStr} frames</span>
        <span class="telem-ts">${tsStr}</span>
        <button class="telem-toggle-btn" title="Collapse">▼</button>
      </div>
    </div>
    <div class="telem-card-body">
      ${hasData ? renderTelemetryPayload(key, entry.data) : '<div class="telem-no-data">No data received yet…</div>'}
    </div>`;

  // Wire collapse/expand toggle
  const toggleBtn = el.querySelector('.telem-toggle-btn');
  const cardBody  = el.querySelector('.telem-card-body');
  toggleBtn.addEventListener('click', () => {
    const isOpen = cardBody.style.display !== 'none';
    cardBody.style.display = isOpen ? 'none' : '';
    toggleBtn.textContent  = isOpen ? '▶' : '▼';
    toggleBtn.title        = isOpen ? 'Expand' : 'Collapse';
  });

  return el;
}

function updateTelemetryCard(topic, entry) {
  const el = document.querySelector(`.telem-card[data-topic="${CSS.escape(topic)}"]`);
  if (!el) { renderTelemetryTab(); return; }

  const statEl  = el.querySelector('.telem-stat');
  if (statEl)  { statEl.className = 'telem-stat telem-live'; statEl.textContent = '● LIVE'; }
  const countEl = el.querySelector('.telem-count');
  if (countEl) countEl.textContent = `${entry.count.toLocaleString()} frames`;
  const tsEl    = el.querySelector('.telem-ts');
  if (tsEl)    tsEl.textContent = entry.ts.toTimeString().slice(0, 8);

  const body = el.querySelector('.telem-card-body');
  if (body) body.innerHTML = renderTelemetryPayload(entry.key, entry.data);

  el.classList.add('telem-flash');
  setTimeout(() => el.classList.remove('telem-flash'), 300);
}

/* ── Module-specific renderers ───────────────────────────────────────────────── */
function renderTelemetryPayload(key, data) {
  switch (key) {
    case 'basic_usage':    return tmplBasicUsage(data);
    case 'frame_metadata': return tmplFrameMetadata(data);
    case 'radar_location': return tmplRadarLocation(data);
    case 'radar_config':   return tmplRadarConfig(data);
    case 'radar_health':   return tmplRadarHealth(data);
    case 'scan_header':    return tmplScanHeader(data);
    case 'track_data':     return tmplTrackData(data);
    case 'track_metadata': return tmplTrackMetadata(data);
    default:
      return `<pre class="telem-json">${escHtml(JSON.stringify(data, null, 2))}</pre>`;
  }
}

function kvRow(label, value) {
  return `<div class="telem-kv"><span>${escHtml(label)}</span><b>${escHtml(String(value ?? '—'))}</b></div>`;
}

function tmplBasicUsage(d) {
  const gps  = d.radar_location?.gps || {};
  const ori  = d.radar_location?.orientation || {};
  const tgts = d.targets || [];
  return `
    <div class="telem-kv-grid">
      ${kvRow('Radar Lat', gps.latitude?.toFixed(6) ?? '—')}
      ${kvRow('Radar Lon', gps.longitude?.toFixed(6) ?? '—')}
      ${kvRow('Elevation', (gps.elevation_m ?? '—') + ' m')}
      ${kvRow('Roll', (ori.roll_angle_deg ?? '—') + ' °')}
      ${kvRow('Pitch', (ori.pitch_angle_deg ?? '—') + ' °')}
      ${kvRow('N-Correction', (ori.north_correction_angle_deg ?? '—') + ' °')}
      ${kvRow('Targets', tgts.length)}
      ${kvRow('Frame', d._meta?.frame_count ?? '—')}
    </div>
    <table class="telem-table">
      <thead><tr><th>ID</th><th>Type</th><th>Dist (m)</th><th>Az (°)</th><th>Alt (m)</th><th>Spd (m/s)</th></tr></thead>
      <tbody>${tgts.map(t => `<tr>
        <td>#${t.track_id}</td>
        <td>${escHtml(t.track_type_label || t.type_label || t.type_code || '?')}</td>
        <td>${t.distance_m?.toFixed(1) ?? '—'}</td>
        <td>${t.azimuth_deg?.toFixed(1) ?? '—'}</td>
        <td>${(t.altitude_m ?? t.geodetic?.altitude_m)?.toFixed(1) ?? '—'}</td>
        <td>${t.radial_speed_ms?.toFixed(2) ?? '—'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

function tmplFrameMetadata(d) {
  const f = d.frame_metadata || {};
  return `<div class="telem-kv-grid">
    ${kvRow('Frame ID', f.frame_id)}
    ${kvRow('Type', f.frame_type)}
    ${kvRow('Count', f.frame_count)}
    ${kvRow('Protocol', `v${f.protocol_major_version ?? '?'}.${f.protocol_minor_version ?? '?'}`)}
    ${kvRow('Device', f.protocol_device)}
    ${kvRow('Checksum', f.checksum_valid ? '✓ Valid' : '✗ Invalid')}
    ${kvRow('Timestamp', f.frame_timestamp_utc ?? '—')}
  </div>`;
}

function tmplRadarLocation(d) {
  const rd  = d.radar_device || {};
  const gps = rd.gps || {};
  const ori = rd.orientation || {};
  const ops = rd.operational_state || {};
  const srv = rd.servo || {};
  return `<div class="telem-kv-grid">
    ${kvRow('Device ID', rd.device_id)}
    ${kvRow('Label', rd.device_label)}
    ${kvRow('Model', rd.model_name)}
    ${kvRow('IP', rd.network?.ip_address)}
    ${kvRow('Lat', gps.latitude?.toFixed(6))}
    ${kvRow('Lon', gps.longitude?.toFixed(6))}
    ${kvRow('Elevation', (gps.elevation_m ?? '—') + ' m')}
    ${kvRow('Heading', (gps.heading_angle_deg ?? '—') + ' °')}
    ${kvRow('Satellites', gps.satellite_count)}
    ${kvRow('Roll', (ori.roll_angle_deg ?? '—') + ' °')}
    ${kvRow('Pitch', (ori.pitch_angle_deg ?? '—') + ' °')}
    ${kvRow('Work Mode', ops.work_mode_label)}
    ${kvRow('Scan Mode', ops.scan_mode_label)}
    ${kvRow('Fault', ops.fault_label)}
    ${kvRow('Az Current', (srv.current_azimuth_deg ?? '—') + ' °')}
    ${kvRow('Scan Cycle', srv.current_scan_cycle)}
  </div>`;
}

function tmplRadarHealth(d) {
  const h    = d.radar_health || {};
  const tArr = h.thermals?.subarray_temperatures || [];
  const vArr = h.power?.signal_voltages || [];
  const iArr = h.power?.subarray_currents || [];
  return `<div class="telem-kv-grid">
    ${kvRow('Signal Board', (h.thermals?.signal_board_temperature_c?.toFixed(1) ?? '—') + ' °C')}
    ${kvRow('Freq Synth', (h.thermals?.frequency_synthesizer_temperature_c?.toFixed(1) ?? '—') + ' °C')}
    ${tArr.map(t => kvRow(`Subarray ${t.index} Temp`, t.temperature_c?.toFixed(1) + ' °C')).join('')}
    ${iArr.map(i => kvRow(`Subarray ${i.index} Current`, i.current_a?.toFixed(2) + ' A')).join('')}
    ${vArr.map(v => kvRow(`V Ch${v.channel}`, v.voltage_v + ' V')).join('')}
    ${kvRow('PCIe Link', h.system_health?.memory_status?.pcie_link_ok ? '✓ OK' : '✗')}
    ${kvRow('FPGA', h.firmware?.fpga_version)}
    ${kvRow('DSP', h.firmware?.data_processing_version)}
  </div>`;
}

function tmplScanHeader(d) {
  const s = d.scan_header || {};
  return `<div class="telem-kv-grid">
    ${kvRow('Azimuth', (s.search_azimuth_deg?.toFixed(1) ?? '—') + ' °')}
    ${kvRow('Elevation', (s.search_elevation_deg?.toFixed(1) ?? '—') + ' °')}
    ${kvRow('Scan Cycle', s.scan_cycle_count)}
    ${kvRow('Pulse Group', s.pulse_group_id)}
    ${kvRow('Target Count', s.target_count)}
  </div>`;
}

function tmplTrackData(d) {
  const tgts = d.targets || [];
  return `<table class="telem-table">
    <thead><tr><th>ID</th><th>Type</th><th>Conf %</th><th>Energy</th><th>Dist (m)</th><th>Az (°)</th><th>Alt (m)</th><th>Speed (m/s)</th></tr></thead>
    <tbody>${tgts.map(t => {
      const tr  = t.track || {};
      const cls = tr.classification || {};
      const sq  = tr.signal_quality || {};
      const pc  = tr.polar_coordinates || {};
      const gc  = tr.geodetic_coordinates || {};
      const v   = tr.velocity_enu || {};
      return `<tr>
        <td>#${t.track_id ?? tr.track_identification?.track_id ?? '—'}</td>
        <td>${escHtml(cls.track_type_label || '?')}</td>
        <td>${cls.confidence_pct ?? (cls.confidence != null ? Math.round(cls.confidence * 100) + '%' : '—')}</td>
        <td>${sq.energy?.toFixed(0) ?? '—'}</td>
        <td>${pc.distance_m?.toFixed(1) ?? '—'}</td>
        <td>${pc.azimuth_deg?.toFixed(1) ?? '—'}</td>
        <td>${gc.altitude_m?.toFixed(1) ?? '—'}</td>
        <td>${v.total_speed_ms?.toFixed(2) ?? '—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function tmplTrackMetadata(d) {
  const tgts = d.targets || [];
  return `<table class="telem-table">
    <thead><tr><th>ID</th><th>Age (pulses)</th><th>Points</th><th>Loss</th><th>Frontend</th><th>Last Seen (UTC)</th></tr></thead>
    <tbody>${tgts.map(t => {
      const m  = t.track_metadata || {};
      const th = m.track_history || {};
      const ts = m.utc_timestamp || {};
      return `<tr>
        <td>#${m.track_id ?? '—'}</td>
        <td>${m.age_pulses ?? '—'}</td>
        <td>${th.track_point_count ?? '—'}</td>
        <td>${m.loss_count_cpi ?? '—'}</td>
        <td>${m.radar_frontend_id ?? '—'}</td>
        <td>${escHtml(ts.iso8601 || '—')}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function tmplRadarConfig(d) {
  const c    = d.radar_configuration || {};
  const f    = c.filters || {};
  const ai   = c.autonomous_identification || {};
  const zns  = c.silent_zones || [];
  return `<div class="telem-kv-grid">
    ${kvRow('Auto-ID', ai.enabled ? '✓ Enabled' : '✗ Disabled')}
    ${kvRow('Max Targets', ai.max_targets)}
    ${kvRow('Range Min', (f.range_min_m ?? '—') + ' m')}
    ${kvRow('Range Max', (f.range_max_m ?? '—') + ' m')}
    ${kvRow('Speed Min', (f.speed_min_ms ?? '—') + ' m/s')}
    ${kvRow('Speed Max', (f.speed_max_ms ?? '—') + ' m/s')}
    ${kvRow('Height Max', (f.height_max_m ?? '—') + ' m')}
    ${kvRow('Height Min Near', (f.height_min_near_zone_m ?? '—') + ' m')}
    ${kvRow('Height Min Far', (f.height_min_far_zone_m ?? '—') + ' m')}
    ${kvRow('Altitude Range', (f.altitude_range_km ?? '—') + ' km')}
  </div>
  ${zns.length ? `<table class="telem-table">
    <thead><tr><th>Zone</th><th>Start (°)</th><th>End (°)</th><th>State</th></tr></thead>
    <tbody>${zns.map(z => `<tr>
      <td>#${z.zone_number}</td>
      <td>${z.start_angle_deg}</td>
      <td>${z.end_angle_deg}</td>
      <td>${z.enabled ? '✓ Active' : '—'}</td>
    </tr>`).join('')}</tbody>
  </table>` : ''}`;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SETTINGS FORM
 ═══════════════════════════════════════════════════════════════════════════════ */
async function saveConfig() {
  const body = collectSettingsForm();
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    CONFIG = data.config;
    toast('✓ Configuration saved. MQTT changes will auto-restart the simulator.');
  } catch (e) {
    toast(`✗ Save failed: ${e.message}`, true);
  }
}

function collectSimulationForm() {
  const MOD_KEYS = ['basic_usage','frame_metadata','radar_location','radar_config',
                    'radar_health','scan_header','track_data','track_metadata'];
  const modules = {};
  MOD_KEYS.forEach(key => {
    const en = document.getElementById(`mod-${key}-enabled`);
    const tp = document.getElementById(`mod-${key}-topic`);
    modules[key] = { enabled: en ? en.checked : false, topic: tp ? tp.value : '' };
  });
  return {
    simulator: {
      publishIntervalMs: +getVal('s-interval'),
      targetCount:       +getVal('s-targets'),
    },
    simulation_modules: modules,
    custom_delivery: collectCustomDelivery(),
  };
}

async function saveSimConfig() {
  const body = collectSimulationForm();
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    CONFIG = data.config;
    toast('✓ Simulation config saved. Restart to apply.', false, 'simulation-toast');
  } catch (e) {
    toast(`✗ Save failed: ${e.message}`, true, 'simulation-toast');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SIMULATION CONTROL
 ═══════════════════════════════════════════════════════════════════════════════ */
async function startSimulation() {
  try {
    const r = await fetch('/api/simulation/start', { method: 'POST' });
    const d = await r.json();
    if (d.status === 'started') toast(`▶ Simulation started (PID ${d.pid})`);
    else if (d.status === 'already_running') toast(`Already running (PID ${d.pid})`);
    pollSimStatus();
  } catch (e) { toast(`✗ Start failed: ${e.message}`, true); }
}

async function stopSimulation() {
  try {
    const r = await fetch('/api/simulation/stop', { method: 'POST' });
    const d = await r.json();
    toast(d.status === 'stopped' ? '■ Simulation stopped' : 'Not running');
    pollSimStatus();
  } catch (e) { toast(`✗ Stop failed: ${e.message}`, true); }
}

async function pollSimStatus() {
  try {
    const r = await fetch('/api/simulation/status');
    const d = await r.json();
    const running = d.running;
    setSimBadge(running);
    const startTopBtn = document.getElementById('btn-start-top');
    const stopTopBtn  = document.getElementById('btn-stop-top');
    if (startTopBtn) { startTopBtn.disabled = running;  }
    if (stopTopBtn)  { stopTopBtn.disabled  = !running; }
    const startSimBtn = document.getElementById('btn-start-sim');
    const stopSimBtn  = document.getElementById('btn-stop-sim');
    if (startSimBtn) { startSimBtn.disabled = running;  }
    if (stopSimBtn)  { stopSimBtn.disabled  = !running; }
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════════════════════
   HELPERS
 ═══════════════════════════════════════════════════════════════════════════════ */
function centerOnTarget(id) {
  if (targetMarkers[id]) {
    // Switch to map tab first
    document.querySelector('[data-tab="map"]').click();
    setTimeout(() => map.setView(targetMarkers[id].getLatLng(), 16), 60);
  }
}

function buildIcon(typeLabel) {
  const style = TARGET_STYLES[typeLabel] || TARGET_STYLES['unknown'];
  return L.divIcon({
    html: `<div class="target-icon" style="font-size:${style.size}px;color:${style.color}">${style.symbol}</div>`,
    iconSize:   [style.size + 6, style.size + 6],
    iconAnchor: [(style.size + 6) / 2, (style.size + 6) / 2],
    className: '',
  });
}

function getColor(typeLabel) {
  return (TARGET_STYLES[typeLabel] || TARGET_STYLES['unknown']).color;
}

function setMqttBadge(state, message) {
  const el = document.getElementById('mqtt-badge');
  if (!el) return;
  el.className = `status-badge status-${state}`;
  el.textContent = message;
}

function setSimBadge(running) {
  const el = document.getElementById('sim-badge');
  if (!el) return;
  el.className = `status-badge ${running ? 'status-connected' : 'status-stopped'}`;
  el.textContent = running ? '● SIM ON' : '● SIM OFF';
}

function toast(msg, isError = false, toastId = 'settings-toast') {
  const el = document.getElementById(toastId);
  if (!el) return;
  el.textContent = msg;
  el.className   = `toast ${isError ? 'toast-error' : 'toast-ok'} show`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3500);
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

/* ─ Sim control buttons ─────────────────────────────────────────────────────── */
function setupSimControls() {
  // wired in setupSettingsActions after CONFIG loads — placeholder here
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PARSER TAB
 ═══════════════════════════════════════════════════════════════════════════════ */
function setupParserTab() {
  document.getElementById('btn-start-parser').addEventListener('click', startParserProc);
  document.getElementById('btn-stop-parser').addEventListener('click',  stopParserProc);
  document.getElementById('btn-check-parser').addEventListener('click', checkParserStatus);
  document.getElementById('btn-force-kill-parser').addEventListener('click', forceKillParser);
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    document.getElementById('parser-log').innerHTML = '';
  });
  document.getElementById('btn-save-parser').addEventListener('click', saveParserConfig);

  const chk = document.getElementById('chk-autoscroll');
  if (chk) chk.addEventListener('change', () => { parserAutoScroll = chk.checked; });

  const flt = document.getElementById('p-log-filter');
  if (flt) flt.addEventListener('change', () => {
    parserLogFilter = flt.value;
    document.getElementById('parser-log')
      .setAttribute('data-filter', parserLogFilter);
  });

  // Build empty module preview grid + table rows so the UI is ready before SSE
  renderParserPreviewGrid();

  connectParserSSE();
  pollParserStatus();
  parserPollTimer = setInterval(pollParserStatus, 3000);
}

/* ── Render module enable/topic table ────────────────────────────────────── */
function renderParserModulesTable(modulesCfg) {
  const tbody = document.getElementById('p-modules-tbody');
  if (!tbody) return;
  tbody.innerHTML = PARSER_MODULE_LIST.map(([key, label, def]) => {
    const m = modulesCfg[key] || {};
    const enabled = m.enabled !== false;
    const topic   = m.topic || def;
    return `<tr>
      <td><label class="toggle-label"><input type="checkbox" id="pm-${key}-en" ${enabled ? 'checked' : ''}/></label></td>
      <td><span class="module-key">${label}</span><br><small class="module-key-mono">${key}</small></td>
      <td><input type="text" id="pm-${key}-topic" value="${topic}" /></td>
    </tr>`;
  }).join('');
}

function collectParserModulesFromTable() {
  const out = {};
  PARSER_MODULE_LIST.forEach(([key, , def]) => {
    const en = document.getElementById(`pm-${key}-en`);
    const tp = document.getElementById(`pm-${key}-topic`);
    out[key] = {
      enabled: !!(en && en.checked),
      topic:   (tp && tp.value.trim()) || def,
    };
  });
  return out;
}

/* ── Render empty module preview cards ───────────────────────────────────── */
function renderParserPreviewGrid() {
  const grid = document.getElementById('p-modules-preview-grid');
  if (!grid) return;
  grid.innerHTML = PARSER_MODULE_LIST.map(([key, label, def]) => `
    <div class="parser-preview-card" id="pp-${key}" data-enabled="true">
      <div class="parser-preview-head">
        <span class="parser-preview-title">${label}</span>
        <span class="parser-preview-badge" id="pp-${key}-badge">idle</span>
      </div>
      <div class="parser-preview-topic" id="pp-${key}-topic">${def}</div>
      <div class="parser-preview-body" id="pp-${key}-body">
        <div class="parser-preview-empty">Waiting for data…</div>
      </div>
    </div>`).join('');
}

/* ── Update one preview card from a MODULE event ─────────────────────────── */
function updateModulePreview(key, payload, topic, enabled) {
  parserModuleData[key] = { topic, enabled, data: payload, ts: Date.now() };
  const card  = document.getElementById(`pp-${key}`);
  if (!card) return;
  card.setAttribute('data-enabled', enabled ? 'true' : 'false');

  const badge = document.getElementById(`pp-${key}-badge`);
  if (badge) {
    badge.textContent = enabled ? '● LIVE' : '○ DISABLED';
    badge.className = 'parser-preview-badge ' + (enabled ? 'badge-live' : 'badge-disabled');
  }

  const topicEl = document.getElementById(`pp-${key}-topic`);
  if (topicEl) topicEl.textContent = topic || '—';

  const body = document.getElementById(`pp-${key}-body`);
  if (!body) return;

  // Use the same telemetry templates so previews look like the Telemetry tab
  try {
    body.innerHTML = renderTelemetryPayload(key, payload);
  } catch (e) {
    body.innerHTML = `<pre class="telem-json">${escHtml(JSON.stringify(payload, null, 2)).slice(0, 1200)}</pre>`;
  }

  // Update data summary table
  updateDataSummaryTable();
}

/* ── Update parsed data summary table ──────────────────────────────────── */
function updateDataSummaryTable() {
  const tbody = document.getElementById('p-data-tbody');
  if (!tbody) return;

  const rows = [];
  for (const [key, info] of Object.entries(parserModuleData)) {
    if (!info.data) continue;
    
    const fieldNames = Object.keys(info.data)
      .filter(k => !k.startsWith('_'))
      .slice(0, 8);  // limit to first 8 fields
    
    const sampleVals = fieldNames
      .map(f => {
        const val = info.data[f];
        if (val === null || val === undefined) return 'null';
        if (typeof val === 'object') return JSON.stringify(val).slice(0, 40);
        return String(val).slice(0, 40);
      })
      .join(', ');
    
    const label = PARSER_MODULE_LIST.find(m => m[0] === key)?.[1] || key;
    rows.push({ key, label, fields: fieldNames.length, fieldList: fieldNames.join(', '), samples: sampleVals });
  }

  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3" style="text-align:center; color:#888;">Waiting for parsed data…</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.label}</td>
      <td title="${r.fieldList}">${r.fields} fields</td>
      <td>${r.samples || '—'}</td>
    </tr>
  `).join('');
}

/* ── SSE connection ──────────────────────────────────────────────────────────── */
function connectParserSSE() {
  if (parserSSE) parserSSE.close();
  parserSSE = new EventSource('/api/parser/logs');
  parserSSE.onmessage = (evt) => appendLogLine(evt.data);
  parserSSE.onerror   = () => {};  // reconnect is automatic via browser
}

/* ── Append a JSON log line to the terminal ─────────────────────────────────── */
function appendLogLine(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch (_) {
    obj = { type: 'INFO', msg: raw };
  }

  const log  = document.getElementById('parser-log');
  if (!log) return;

  const line = document.createElement('div');
  line.className = `log-line log-${obj.type?.toLowerCase() || 'info'}`;

  const tsStr = obj.ts ? new Date(obj.ts * 1000).toISOString().slice(11, 23) : '';
  let body = '';

  switch (obj.type) {
    case 'RAW':
      body = `[RAW]  ${tsStr} ${obj.src || ''} (${obj.size}b) ${obj.hex || ''}`;
      break;
    case 'PARSED':
      body = `[PARSED] ${tsStr} ${obj.src || ''} targets=${obj.targets ?? '?'} `
           + JSON.stringify(obj.data || {}).slice(0, 160) + '…';
      const meta = document.getElementById('p-preview-meta');
      if (meta) meta.textContent = `last frame: ${tsStr} · targets=${obj.targets ?? 0}`;
      break;
    case 'MODULE':
      body = `[MOD]  ${tsStr} ${obj.key} ${obj.enabled ? '✓' : '✗'} → ${obj.topic}`;
      if (obj.key && obj.data) {
        updateModulePreview(obj.key, obj.data, obj.topic, !!obj.enabled);
      }
      break;
    case 'STATS':
      body = `[STATS] ${tsStr} packets=${obj.packets} ok=${obj.packets - (obj.errors||0)} `
           + `err=${obj.errors} targets=${obj.targets}`;
      parserStats.packets  = obj.packets  || 0;
      parserStats.errors   = obj.errors   || 0;
      parserStats.targets  = obj.targets  || 0;
      parserStats.ok       = parserStats.packets - parserStats.errors;
      updateParserStats();
      break;
    case 'ERR':
      body = `[ERR]  ${tsStr} ${obj.src ? obj.src + ' ' : ''}${obj.msg || ''}`;
      parserStats.errors++;
      updateParserStats();
      break;
    case 'INFO':
    default:
      body = `[INFO] ${tsStr} ${obj.msg || raw}`;
  }

  line.textContent = body;
  log.appendChild(line);

  // Trim to last 2000 lines
  while (log.children.length > 2000) log.removeChild(log.firstChild);

  // Auto-scroll
  if (parserAutoScroll) log.scrollTop = log.scrollHeight;
}

/* ── Update stat badges ──────────────────────────────────────────────────────── */
function updateParserStats() {
  const s = parserStats;
  const $ = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  $('stat-packets', s.packets);
  $('stat-ok',      s.ok);
  $('stat-err',     s.errors);
  $('stat-tgt',     s.targets);
}

/* ── Start / stop parser process ────────────────────────────────────────────── */
async function startParserProc() {
  try {
    const r = await fetch('/api/parser/start', { method: 'POST' });
    const d = await r.json();
    if (d.status === 'started') toast(`▶ Parser started (PID ${d.pid})`);
    else if (d.status === 'already_running') toast(`Parser already running (PID ${d.pid})`);
    pollParserStatus();
  } catch (e) { toast(`✗ Parser start failed: ${e.message}`, true); }
}

async function stopParserProc() {
  try {
    const r = await fetch('/api/parser/stop', { method: 'POST' });
    const d = await r.json();
    toast(d.status === 'stopped' ? '■ Parser stopped' : 'Parser not running');
    pollParserStatus();
  } catch (e) { toast(`✗ Parser stop failed: ${e.message}`, true); }
}

async function checkParserStatus() {
  try {
    const r = await fetch('/api/parser/status');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    console.log('[Parser] Status:', d);
    if (d.running) {
      toast(`✓ Parser running (PID ${d.pid})`, false);
    } else {
      // Check port to see what's blocking
      fetch('/api/parser/port-check').then(r => r.json()).then(p => {
        if (p.in_use) {
          toast(`⚠ Parser stopped — port 8000 in use by ${p.process || 'unknown'} (use Force Stop)`, false);
        } else {
          toast(`⚠ Parser not running — port 8000 is free`, false);
        }
      }).catch(_ => toast('⚠ Parser stopped', false));
    }
    pollParserStatus();
  } catch (e) { 
    console.error('[Parser] Status check error:', e);
    toast(`✗ Status check failed: ${e.message}`, true); 
  }
}

async function forceKillParser() {
  if (!confirm('Force kill any process on port 8000? This will terminate any radar parsing.')) return;
  try {
    const r = await fetch('/api/parser/force-kill', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    toast('⚡ Port 8000 cleared — checking status...', false);
    await new Promise(r => setTimeout(r, 1500));
    checkParserStatus();  // Re-check status after clearing
  } catch (e) { toast(`✗ Force kill failed: ${e.message}`, true); }
}

async function pollParserStatus() {
  try {
    const r = await fetch('/api/parser/status');
    const d = await r.json();
    setParserBadge(d.running);
    const startBtn = document.getElementById('btn-start-parser');
    const stopBtn  = document.getElementById('btn-stop-parser');
    if (startBtn) startBtn.disabled = d.running;
    if (stopBtn)  stopBtn.disabled  = !d.running;
  } catch (_) {}
}

function setParserBadge(running) {
  const el = document.getElementById('parser-badge');
  if (!el) return;
  el.className  = `status-badge ${running ? 'status-connected' : 'status-stopped'}`;
  el.textContent = running ? '● PARSER ON' : '● PARSER OFF';
}

/* ── Save parser config to server ───────────────────────────────────────────── */
async function saveParserConfig() {
  const payload = {
    parser: {
      udp_host:        getVal('p-host') || '0.0.0.0',
      udp_port:        +getVal('p-port') || 20202,
      mqtt_enabled:    !!(document.getElementById('p-mqtt-enabled')?.checked),
      mqtt_broker: {
        protocol: 'mqtt',
        host:     getVal('p-mqtt-host') || '127.0.0.1',
        port:     +getVal('p-mqtt-port') || 1883,
        username: getVal('p-mqtt-user') || '',
        password: getVal('p-mqtt-pass') || '',
      },
      publish_mode:    getVal('p-publish-mode')    || 'modular',
      aggregate_topic: getVal('p-aggregate-topic') || 'radar/rdxxb/parsed',
      modules:         collectParserModulesFromTable(),
    },
  };
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (d.ok) {
      CONFIG = d.config;
      toast('Parser config saved — restart parser to apply');
    } else {
      toast('Save failed', true);
    }
  } catch (e) { toast(`Save error: ${e.message}`, true); }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CUSTOM DELIVERY CHANNELS
 ═══════════════════════════════════════════════════════════════════════════════ */

let _cdIdCounter = Date.now();
function cdUniqueId() { return `cd_${++_cdIdCounter}`; }

/* ── Render the full list of channels from a config array ──────────────────── */
function renderCustomDeliveryList(channels) {
  const list = document.getElementById('custom-delivery-list');
  if (!list) return;
  list.innerHTML = '';
  if (channels.length === 0) {
    list.innerHTML = `<p class="cd-empty-hint">No custom channels yet. Click <b>+ Add Channel</b> to create one.</p>`;
    return;
  }
  channels.forEach(ch => list.appendChild(buildChannelCard(ch)));
}

/* ── Build a single channel card DOM element ───────────────────────────────── */
function buildChannelCard(ch) {
  const id    = ch.id || cdUniqueId();
  const card  = document.createElement('div');
  card.className = 'cd-card';
  card.dataset.cdId = id;

  // Build field-group checkboxes
  const groupsHtml = CUSTOM_DELIVERY_CATALOG.map(group => {
    const fieldsHtml = group.fields.map(f => {
      const checked = (ch.fields || []).includes(f.path) ? 'checked' : '';
      return `<label class="cd-field-label">
        <input type="checkbox" class="cd-field-chk" value="${f.path}" ${checked}>
        <span>${f.label}</span>
      </label>`;
    }).join('');
    return `<div class="cd-group">
      <div class="cd-group-title">${group.icon} ${group.group}</div>
      <div class="cd-fields-grid">${fieldsHtml}</div>
    </div>`;
  }).join('');

  card.innerHTML = `
    <div class="cd-card-header">
      <label class="mod-toggle-wrap cd-enable-wrap">
        <input type="checkbox" class="cd-enabled-chk mod-toggle-input" ${ch.enabled ? 'checked' : ''}>
        <span class="mod-toggle"></span>
      </label>
      <input type="text" class="cd-name-input" placeholder="Channel name" value="${escHtml(ch.name || '')}">
      <div class="cd-topic-row">
        <span class="cd-topic-label">Topic</span>
        <input type="text" class="cd-topic-input" placeholder="radar/custom/channel" value="${escHtml(ch.topic || '')}">
      </div>
      <button class="btn btn-danger btn-sm cd-delete-btn" title="Delete channel">✕</button>
    </div>
    <details class="cd-fields-details">
      <summary class="cd-fields-summary">
        <span class="cd-field-count">${(ch.fields || []).length} field(s) selected</span>
        — click to expand
      </summary>
      <div class="cd-fields-body">${groupsHtml}</div>
    </details>`;

  // Update field count badge when checkboxes change
  card.querySelectorAll('.cd-field-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      const count = card.querySelectorAll('.cd-field-chk:checked').length;
      const badge = card.querySelector('.cd-field-count');
      if (badge) badge.textContent = `${count} field(s) selected`;
    });
  });

  // Delete button
  card.querySelector('.cd-delete-btn').addEventListener('click', () => card.remove());

  return card;
}

/* ── Collect current state of all channel cards from the DOM ───────────────── */
function collectCustomDelivery() {
  const list = document.getElementById('custom-delivery-list');
  if (!list) return [];
  return Array.from(list.querySelectorAll('.cd-card')).map(card => {
    const id      = card.dataset.cdId;
    const name    = card.querySelector('.cd-name-input')?.value.trim() || id;
    const topic   = card.querySelector('.cd-topic-input')?.value.trim() || '';
    const enabled = !!(card.querySelector('.cd-enabled-chk')?.checked);
    const fields  = Array.from(card.querySelectorAll('.cd-field-chk:checked')).map(c => c.value);
    return { id, name, topic, enabled, fields };
  });
}

/* ── Add a new blank channel card ──────────────────────────────────────────── */
function addCustomDeliveryChannel() {
  const list = document.getElementById('custom-delivery-list');
  if (!list) return;
  // Remove empty hint if present
  const hint = list.querySelector('.cd-empty-hint');
  if (hint) hint.remove();
  const ch = { id: cdUniqueId(), name: '', topic: '', enabled: true, fields: [] };
  list.appendChild(buildChannelCard(ch));
}

/* ── Tiny HTML-escape helper ────────────────────────────────────────────────── */
// (escHtml is defined in the Monitor section above)

/* ── Wire up Add Channel button (called once from setupSettingsActions) ─────── */
function setupCustomDelivery() {
  const btn = document.getElementById('btn-add-custom-channel');
  if (btn) btn.addEventListener('click', addCustomDeliveryChannel);
}
