'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isSimulatorAutoStartEnabled } = require('../simulator-autostart');

test('auto-starts when older runtime config has no autoStart field', () => {
  assert.equal(isSimulatorAutoStartEnabled({ simulator: { targetCount: 5 } }), true);
});

test('honors an explicit autoStart false setting', () => {
  assert.equal(isSimulatorAutoStartEnabled({ simulator: { autoStart: false } }), false);
});

test('allows autoStart to be explicitly enabled', () => {
  assert.equal(isSimulatorAutoStartEnabled({ simulator: { autoStart: true } }), true);
});
