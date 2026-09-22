const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readInstalledState, packagePathFor } = require('../subapp-manager');

function readManifest(t, lifecycle) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subapp-owner-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = { id: 'fixture', package: '@aily-project/subapp-fixture', namespace: 'FIXTURE', app: {} };
  const packageRoot = packagePathFor(root, entry.package);
  fs.mkdirSync(path.join(packageRoot, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'index.js'), '');
  fs.writeFileSync(path.join(packageRoot, 'ui/index.html'), '');
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: entry.package, version: '1.0.0', main: 'index.js', aily: { uiIndex: 'ui/index.html' },
    ailySubapp: { agent: { protocolVersion: 1, tools: { transport: 'aily-child-rpc', manifest: 'tools.json' } } },
  }));
  fs.writeFileSync(path.join(packageRoot, 'tools.json'), JSON.stringify({
    protocolVersion: 1, transport: 'aily-child-rpc', lifecycle,
    tools: [{ name: 'fixture_status', rpc: { method: 'fixture.status' }, inputSchema: { type: 'object' } }],
  }));
  return readInstalledState(root, entry);
}

test('installed manifest preserves generic owner and final release callbacks with bounded timeout', t => {
  const state = readManifest(t, {
    ownerRelease: { method: 'fixture.owner.release', timeoutMs: 90000, params: { custom: true } },
    sessionRelease: { method: 'fixture.session.release' },
  });
  assert.equal(state.installError, undefined);
  assert.deepEqual(state.config.agent.lifecycle, {
    ownerRelease: { method: 'fixture.owner.release', timeoutMs: 30000, params: { custom: true } },
    sessionRelease: { method: 'fixture.session.release', timeoutMs: 5000 },
  });
});

test('owner-only and legacy manifests remain valid', t => {
  assert.deepEqual(readManifest(t, { ownerRelease: { method: 'fixture.release' } }).config.agent.lifecycle,
    { ownerRelease: { method: 'fixture.release', timeoutMs: 5000 } });
  assert.deepEqual(readManifest(t, { sessionRelease: { method: 'fixture.release' } }).config.agent.lifecycle,
    { sessionRelease: { method: 'fixture.release', timeoutMs: 5000 } });
});

test('process-file owner leases are opt-in, require release, and preserve their protocol', t => {
  const ownerLease = { protocol: 'process-file-v1', method: 'fixture.lease' };
  const state = readManifest(t, { ownerLease, ownerRelease: { method: 'fixture.release' } });
  assert.deepEqual(state.config.agent.lifecycle.ownerLease, { ...ownerLease, timeoutMs: 5000 });
  for (const lifecycle of [{ ownerLease }, { ownerLease: { ...ownerLease, protocol: 'unknown' }, ownerRelease: { method: 'fixture.release' } }]) {
    assert.match(readManifest(t, lifecycle).installError, /lifecycle.ownerLease/);
  }
});

test('invalid optional owner callback is surfaced as an Agent manifest diagnostic', t => {
  for (const ownerRelease of ['invalid', { method: '' }, { method: 'fixture.release', params: [] }]) {
    const state = readManifest(t, { ownerRelease });
    assert.equal(state.installed, true); // UI is independent of Agent configuration.
    assert.equal(state.config.agent, undefined);
    assert.match(state.installError, /lifecycle.ownerRelease/);
  }
});
