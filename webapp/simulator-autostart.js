'use strict';

function isSimulatorAutoStartEnabled(config) {
  return config?.simulator?.autoStart !== false;
}

module.exports = { isSimulatorAutoStartEnabled };
