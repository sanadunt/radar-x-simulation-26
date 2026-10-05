/**
 * RDXXB Radar Simulation - Central Configuration
 * Edit this file to point to your MQTT broker.
 */
module.exports = {
  mqtt: {
    // TCP connection (used by Node.js simulator)
    tcp: {
      protocol: 'mqtt',  // 'mqtt' | 'mqtts' for TLS
      host: '127.0.0.1',
      port: 1883,
      username: '',
      password: '',
    },
    // WebSocket connection (used by the browser webapp)
    ws: {
      protocol: 'ws',    // 'ws' | 'wss' for TLS
      host: '127.0.0.1',
      port: 9001,
      username: '',
      password: '',
    },
    topics: {
      targets: 'radar/rdxxb/targets',  // Main target data (Basic Usage JSON)
      status:  'radar/rdxxb/status',   // Radar health/status
    },
    clientIdPrefix: 'rdxxb-',
  },

  // Radar installation GPS & orientation (from protocol documentation)
  radar: {
    longitude: 107.608234,
    latitude: -6.897456,
    elevation_m: 150.0,
    roll_angle_deg: 0.5,
    pitch_angle_deg: 1.2,
    north_correction_angle_deg: 8.5,
  },

  simulator: {
    publishIntervalMs: 500,   // How often to publish target updates
    targetCount: 5,           // Number of simulated targets
  },

  webapp: {
    port: 6666,
  },
};
