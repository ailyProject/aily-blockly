import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSimulatorLiveOptions, checkLiveMeasurements } from './fixtures/simulator-live-scenarios.mjs';
import { collectFirmwareReports } from './fixtures/simulator-evidence.mjs';

test('real-model mode is opt-in and credentials require their own host region', () => {
  assert.equal(readSimulatorLiveOptions({}), null);
  assert.throws(() => readSimulatorLiveOptions({ SIMULATOR_PRODUCT_LIVE_AUTH_FILE: 'unused', SIMULATOR_PRODUCT_LIVE_MODEL: 'auto-max' }), /matching host config/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-live-options-'));
  try {
    fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ access_token: 'test-only', refresh_token: 'do-not-copy' }));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ region: 'test', regions: { test: { enabled: true, api_server: 'http://127.0.0.1:1' } } }));
    const env = { SIMULATOR_PRODUCT_LIVE_AUTH_FILE: path.join(root, 'auth.json'),
      SIMULATOR_PRODUCT_LIVE_CONFIG_FILE: path.join(root, 'config.json'), SIMULATOR_PRODUCT_LIVE_MODEL: 'chosen-model' };
    const options = readSimulatorLiveOptions(env);
    assert.equal(options.model, 'chosen-model'); assert.equal(options.region, 'test');
    assert.equal(options.refresh_token, undefined); assert.equal(options.refreshToken, undefined);
    assert.equal(options.caseName, 'all');
    assert.equal(readSimulatorLiveOptions({ ...env, SIMULATOR_PRODUCT_LIVE_CASE: 'negative' }).caseName, 'negative');
    assert.throws(() => readSimulatorLiveOptions({ ...env, SIMULATOR_PRODUCT_LIVE_CASE: 'unknown' }), /Unknown live test case/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function report() {
  return { kind: 'aily-firmware-debug-report', resultScope: 'supplied-firmware-snapshot', outcome: 'passed',
    cleanup: { closed: true, resources: { executionUnits: 0 } },
    steps: [1000, 2000, 500].map((hz, index) => ({ op: 'signal.measure', measurement: {
      source: 'ledc', modelDerived: true, physicalTimingVerified: false,
      completeCycles: 20,
      startTimeNs: 5000000, endTimeNs: 45000000,
      metrics: { frequencyHz: { mean: hz }, dutyCycle: { mean: [0.25, 0.5, 0.25][index] } },
      assertions: [{ metric: 'frequencyHz', passed: true, expected: { min: hz - 1, max: hz + 1 } },
        { metric: 'dutyCycle', passed: true, expected: { min: [0.24, 0.49, 0.24][index], max: [0.26, 0.51, 0.26][index] } }],
    } })) };
}

test('acceptance reads actual tool evidence once; a model narrative cannot substitute for it', () => {
  const value = report();
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Everything passed' }] },
    { role: 'toolResult', details: { data: { result: value } }, content: [{ type: 'text', text: JSON.stringify({ result: value }) }] }];
  assert.deepEqual(collectFirmwareReports(messages), [value]);
  checkLiveMeasurements([value]);
  assert.throws(() => checkLiveMeasurements([]), /actually execute/);
  for (const mutation of [r => r.steps.pop(), r => r.cleanup.resources.executionUnits++,
    r => r.steps[0].measurement.endTimeNs -= 5_000_000,
    r => r.steps[0].measurement.assertions[0].expected.max = 5000,
    r => r.steps[0].measurement.physicalTimingVerified = true]) {
    const changed = report(); mutation(changed); assert.throws(() => checkLiveMeasurements([changed]));
  }
});

test('negative acceptance requires an actual failed assertion without relaxed expectations', () => {
  const value = { ...report(), steps: [], outcome: 'failed', error: { code: 'ASSERTION_FAILED', details: { measurement: {
    ...report().steps[0].measurement,
    metrics: { frequencyHz: { mean: 1000 } }, assertions: [{ metric: 'frequencyHz', passed: false, expected: { min: 1199, max: 1201 } }],
  } } } };
  checkLiveMeasurements([value], true);
  assert.throws(() => checkLiveMeasurements([value, report()], true), /manufacture a pass/);
  value.error.details.measurement.assertions[0].expected = { min: 900, max: 1100 };
  assert.throws(() => checkLiveMeasurements([value], true));
});
