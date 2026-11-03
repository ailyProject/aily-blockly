'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// Exercise the actual queue and typed semantic diagnostic without a renderer.
// Blockly field/serialization adapters are unused: these tests inject a full
// snapshot reader. The Angular suite separately covers real Blockly and realms.
const root = path.resolve(__dirname, '../src/app'), modules = new Map();
function load(relative) {
  const filename = path.join(root, relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const compiled = new Module(filename, module); modules.set(filename, compiled);
  compiled.require = id => id.endsWith('abs-state') ? load('integrations/blockly/abs/abs-state.ts')
    : id.endsWith('blockly-native-semantic-diagnostic') ? load('editors/blockly-editor/services/blockly-native-semantic-diagnostic.ts')
      : id.endsWith('abs-json') ? { absJson: JSON.stringify } : {};
  compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, filename);
  return compiled.exports;
}
const { NativeUiTasks } = load('editors/blockly-editor/services/blockly-native-ui-tasks.ts');
const hostTurn = () => new Promise(resolve => setTimeout(resolve, 0));

test('a real host macrotask runs between complete checked UI slices', async () => {
  const queue = new NativeUiTasks(undefined, () => 0), calls = [];
  let snapshots = 0, yields = 0, heartbeat = -1;
  for (let i = 0; i < 20; i++) queue.set(() => { calls.push(i); });
  setTimeout(() => { heartbeat = calls.length; }, 0);
  await queue.drainCooperatively(() => { snapshots++; return '{}'; }, async () => { yields++; await hostTurn(); }, () => {});
  assert.deepEqual(calls, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(heartbeat, 8); assert.equal(yields, 2); assert.equal(snapshots, 21 + yields);
});

test('elapsed CPU slices and stable virtual timer ordering do not use real timer delays', async () => {
  let now = 0, yields = 0; const queue = new NativeUiTasks(undefined, () => now), order = [];
  for (let i = 0; i < 9; i++) queue.set(() => { order.push('parallel-' + i); now += 9; }, 100);
  queue.set(() => { order.push('first'); queue.set(() => order.push('nested'), 0); }, 200);
  queue.set(() => order.push('same-due'), 200);
  const cancelled = queue.set(() => order.push('cancelled'), 150); queue.clear(cancelled);
  await queue.drainCooperatively(() => '{}', async () => { yields++; }, () => {});
  assert.deepEqual(order, [...Array.from({ length: 9 }, (_, i) => 'parallel-' + i), 'first', 'same-due', 'nested']);
  assert.equal(yields, 9);
});

test('neither an individual task nor an interleaved observer can mutate and later restore persisted meaning', async () => {
  for (const outside of [false, true]) {
    let state = 0, calls = 0; const queue = new NativeUiTasks(undefined, () => 0);
    if (outside) for (let i = 0; i < 8; i++) queue.set(() => { calls++; });
    else queue.set(() => { state = 1; calls++; });
    queue.set(() => { state = 0; calls++; });
    await assert.rejects(queue.drainCooperatively(() => JSON.stringify({ state }), async () => { state = 1; }, () => {}),
      { code: 'ABS_NATIVE_UI_CONTRACT_CHANGED' });
    assert.equal(calls, outside ? 8 : 1); assert.equal(queue.hasPending, false);
  }
});

test('changed guard, disposal and failed scheduler stop the original queue without another callback', async () => {
  for (const failure of ['guard', 'dispose', 'scheduler']) {
    let calls = 0, current = true; const queue = new NativeUiTasks(undefined, () => 0);
    for (let i = 0; i < 9; i++) queue.set(() => { calls++; });
    await assert.rejects(queue.drainCooperatively(() => '{}', async () => {
      if (failure === 'guard') current = false;
      else if (failure === 'dispose') queue.dispose();
      else throw Error('host scheduler failed');
    }, () => { if (!current) throw Error('scope changed'); }));
    assert.equal(calls, 8); assert.equal(queue.hasPending, false);
  }
});

test('host yielding does not admit asynchronous callbacks or reset the finite library task budget', async () => {
  const bad = new NativeUiTasks(); bad.set(() => Promise.resolve());
  await assert.rejects(bad.drainCooperatively(() => '{}', hostTurn, () => {}), /asynchronous UI callbacks/);
  const queue = new NativeUiTasks(undefined, () => 0); let calls = 0, snapshots = 0;
  for (let i = 0; i < 512; i++) queue.set(() => { calls++; });
  await queue.drainCooperatively(() => { snapshots++; return '{}'; }, async () => {}, () => {});
  assert.equal(calls, 512); assert.equal(snapshots, 513 + 63);
  assert.throws(() => queue.set(() => {}), { code: 'ABS_LIMIT' });
});

test('empty queues do not schedule and original synchronous callers retain C+1 full snapshots', async () => {
  const empty = new NativeUiTasks();
  await empty.drainCooperatively(() => assert.fail('empty snapshot'), async () => assert.fail('empty yield'), () => {});
  const sync = new NativeUiTasks(); let calls = 0, snapshots = 0;
  for (let i = 0; i < 20; i++) sync.set(() => { calls++; });
  sync.drain(() => { snapshots++; return '{}'; });
  assert.equal(calls, 20); assert.equal(snapshots, 21);
});
