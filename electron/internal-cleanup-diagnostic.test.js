'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInternalCleanupDiagnostic, emitInternalCleanupDiagnostic } = require('./internal-cleanup-diagnostic');
const { SubappBrowserExecutionHost } = require('./subapp-browser-execution-host');
const decode = text => JSON.parse(text.slice('AILY_INTERNAL_CLEANUP_V1 '.length));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(callbacks, detach) {
  const host = new SubappBrowserExecutionHost(), window = { destroyed: false, isDestroyed() { return this.destroyed; }, async destroy() { this.destroyed = true; } };
  let removed = 0, dispatches = 0;
  const binding = { key: 'original', cleanups: new Set(callbacks), window, remove() { removed++; } };
  const state = { bindings: new Map(), retiring: new Set(), connections: new Map([['view', binding]]) };
  host.request = (...args) => { dispatches++; return detach(...args); };
  return { host, state, binding, window, removed: () => removed, dispatches: () => dispatches };
}
test('private stderr record is bounded and contains only fixed source/name/code/category, never raw message or identity', () => {
  const raw = Object.assign(new Error('endpoint localhost secret=token nonce=1234 sessionId=private 127.0.0.1 payload=abcdef'), { code: 'unknown-private-token', name: 'private-name' });
  const nested = new AggregateError([raw, Object.assign(new Error('Local network cleanup requires retry.'), { code: 'cleanup-unconfirmed' })], 'outer secret', { cause: new TypeError('arbitrary secret') });
  const text = createInternalCleanupDiagnostic('main-view-disconnect', [{ source: 'registered-view-cleanup', error: nested }]), record = decode(text);
  assert(Buffer.byteLength(text) <= 4096); assert.equal(record.nodes.length, 4); assert.equal(record.nodes[1].code, null); assert.equal(record.nodes[1].name, 'Error');
  assert(record.nodes.some(node => node.category === 'local-network-cleanup-unconfirmed')); assert(record.nodes.some(node => node.code === 'cleanup-unconfirmed'));
  assert.doesNotMatch(text, /localhost|secret|token|nonce|sessionId|127\.0\.0\.1|payload|abcdef|private-name/);
});
test('cycles/depth/wide aggregates/getters and hostile observer remain bounded without reading arbitrary getters', async () => {
  let getters = 0; const root = new Error('secret'); Object.defineProperty(root, 'code', { get() { getters++; throw Error('must not read'); } }); Object.defineProperty(root, 'cause', { value: root });
  const cyclic = decode(createInternalCleanupDiagnostic('node-view-detach', [{ source: 'node-handler-cleanup', error: root }])); assert(cyclic.truncated); assert.equal(getters, 0);
  let deep = new Error('last'); for (let i = 0; i < 20; i++) deep = new AggregateError([deep], 'ignored');
  for (const error of [deep, new AggregateError(Array.from({ length: 100 }, () => Object.assign(new Error('ignored'), { code: 'cleanup-unconfirmed' })))]) {
    const text = createInternalCleanupDiagnostic('node-view-detach', [{ source: 'node-handler-cleanup', error }]), record = decode(text); assert(record.truncated); assert(record.nodes.length <= 16); assert(record.nodes.every(node => node.depth < 4)); assert(Buffer.byteLength(text) <= 4096);
  }
  assert.equal(createInternalCleanupDiagnostic('invalid', [{ source: 'registered-view-cleanup', error: root }]), undefined);
  assert.equal(createInternalCleanupDiagnostic('main-view-disconnect', [{ source: 'raw endpoint', error: root }]), undefined);
  assert.doesNotThrow(() => emitInternalCleanupDiagnostic('node-view-detach', [{ source: 'node-handler-cleanup', error: root }], () => { throw Error('observer'); }));
  const held = deferred(); let observed = 0;
  assert.equal(emitInternalCleanupDiagnostic('node-view-detach', [{ source: 'node-handler-cleanup', error: root }], () => { observed++; return held.promise; }), undefined); assert.equal(observed, 1); held.resolve();
  emitInternalCleanupDiagnostic('node-view-detach', [{ source: 'node-handler-cleanup', error: root }], async () => { throw Error('observer-rejected'); }); await Promise.resolve(); await Promise.resolve();
});
test('actual Main disconnect waits original sibling settlement, classifies both sources and throws the exact original errors without destroying the View', async () => {
  const one = Object.assign(new Error('Local network cleanup requires retry.'), { code: 'cleanup-unconfirmed' }), two = Object.assign(new Error('private detail'), { code: 'NODE_CONTROL_FAILED' }), gate = deferred(), logs = [], original = console.error;
  console.error = text => { logs.push(text); return Promise.reject(Error('observer rejected')); };
  try {
    const f = fixture([async () => { throw one; }], async () => { await gate.promise; throw two; });
    let settled = false; const pending = f.host.disconnect(f.state, 'view').then(() => { settled = true; }, error => { settled = true; throw error; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false); assert.equal(logs.length, 0); assert.equal(f.dispatches(), 1); assert.equal(f.window.destroyed, false);
    gate.resolve(); await assert.rejects(pending, error => { assert(error instanceof AggregateError); assert.equal(error.message, 'View connection cleanup was not acknowledged'); assert.deepEqual(error.errors, [one, two]); return true; });
    assert.equal(logs.length, 1); const record = decode(logs[0]); assert.deepEqual(record.nodes.map(node => node.source), ['registered-view-cleanup', 'execution-view-detach']);
    assert.equal(f.state.connections.get('view'), f.binding); assert.equal(f.binding.disconnecting, null); assert.equal(f.window.destroyed, false); assert.equal(f.removed(), 0);
  } finally { console.error = original; }
});
test('successful actual Main disconnect logs nothing and preserves its original physical close/removal ACK semantics', async () => {
  const logs = [], original = console.error; console.error = text => logs.push(text);
  try { const f = fixture([async () => {}], async () => {}); await f.host.disconnect(f.state, 'view'); assert.equal(f.dispatches(), 1); assert.equal(f.window.destroyed, true); assert.equal(f.removed(), 1); assert.equal(f.state.connections.size, 0); assert.deepEqual(logs, []); }
  finally { console.error = original; }
});
