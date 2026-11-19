import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverChildAppCapabilities } from '../../src/app/services/integrations/automation/subapp-capability-recovery.ts';

function fixture(overrides = {}) {
  const calls = [];
  return { calls, manager: {
    state: { installRoot: '/fixture/managed', apps: [{ id: 'catalog-debugger', toolId: 'debugger',
      packageName: '@aily-project/subapp-debugger', installedVersion: '1.2.3', installed: true,
      installPath: '/fixture/managed/debugger' }] },
    refresh: async force => { calls.push(['refresh', force]); },
    repair: async id => { calls.push(['repair', id]); return { ok: true, version: '1.2.3' }; }, ...overrides,
  } };
}

test('host refresh returns the manager-selected install root without installing or starting a subapp', async () => {
  const { manager, calls } = fixture();
  const result = await recoverChildAppCapabilities(manager, { action: 'refresh', toolId: 'debugger' });
  assert.equal(result.ok, true);
  assert.equal(result.installRoot, manager.state.installRoot);
  assert.deepEqual(calls, [['refresh', false]]);
});

test('host repair resolves a catalog ID and delegates only explicit managed repair', async () => {
  const { manager, calls } = fixture();
  const result = await recoverChildAppCapabilities(manager, { action: 'repair', toolId: 'debugger' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['refresh', false], ['repair', 'catalog-debugger']]);
});

test('host recovery rejects guessed targets and preserves structured busy errors', async () => {
  const { manager, calls } = fixture({ repair: async () => ({ ok: false, code: 'SUBAPP_REPAIR_BUSY', error: 'running' }) });
  assert.equal((await recoverChildAppCapabilities(manager, { action: 'repair', toolId: 'unknown' })).code, 'SUBAPP_RECOVERY_TARGET_UNKNOWN');
  assert.equal((await recoverChildAppCapabilities(manager, { action: 'repair', toolId: 'debugger' })).code, 'SUBAPP_REPAIR_BUSY');
  assert.ok(calls.every(call => call[0] === 'refresh'));
});
