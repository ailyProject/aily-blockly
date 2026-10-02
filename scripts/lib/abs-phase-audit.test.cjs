const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installAbsPhaseAudit } = require('./abs-phase-audit.cjs');

test('separates replay observations from stage timings and bounds retained observations', () => {
  let now = 100, captures = 0;
  class Channel { constructor() { this.port1 = new EventTarget(); this.port1.start = () => { throw Error('must not start port'); }; } }
  const replay = { steps: [{ kind: 'script', label: 'C:/private/project/lib-example/generator.js', source: 'private source' }] };
  const noop = () => {};
  const component = { blocklyService: { prepareProjectCode: noop, assertWorkspaceSharedChange: noop, getProjectDocument: noop,
    captureDeclarativeBlockDefinitions: () => ({ assertCurrent: noop, withSynchronousRead: noop }),
    captureNativeReplay: () => { captures++; return replay; } }, _projectService: { prepareSave: noop, publishPreparedSaveOutputs: noop } };
  const window = { MessageChannel: Channel, ng: { getComponent: () => component }, crypto: { subtle: { digest: noop } },
    Blockly: { serialization: { workspaces: { load: noop }, blocks: { appendInternal: noop } }, renderManagement: { triggerQueuedRenders: noop } },
    auditPhases: { host: {}, native: [] } };
  vm.runInNewContext(`(${installAbsPhaseAudit.toString()})()`, { window, document: { querySelector() {} }, performance: { now: () => now }, URL });
  assert.equal(component.blocklyService.captureNativeReplay(), replay);
  assert.equal(captures, 1);
  const audit = window.auditPhases, channel = new window.MessageChannel();
  const emit = data => { const event = new Event('message'); event.data = data; channel.port1.dispatchEvent(event); };
  now = 110; emit({ phase: 'replay', elapsedMs: 2 });
  now = 111; emit({ phase: 'replay', elapsedMs: 3, replay: { step: 0, event: 'step-start' } });
  window.auditPhases = { host: {}, native: [] };
  for (let i = 0; i < 1100; i++) emit({ phase: 'replay', elapsedMs: 4, replay: { step: 0, event: 'step-end' } });
  const record = audit.native[0];
  assert.equal(record.phases.length, 1); assert.equal(record.phases[0].receivedMs, 10);
  assert.equal(record.replay[0].realmMs, 3); assert.equal(record.replay[0].receivedMs, 11);
  assert.equal(record.replay.length, 1024); assert.equal(record.replayDropped, 77);
  assert.equal(audit.replaySteps[0].label, 'lib-example/generator.js');
  assert.equal(JSON.stringify(audit).includes('private'), false);
  assert.equal(window.auditPhases.native.length, 0);
});
