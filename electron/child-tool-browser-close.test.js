'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Execute the original component methods with explicit DI ports. Rendering and
// the real Main/Node/Worker ACKs are covered by the local product acceptance.
const source = fs.readFileSync(path.join(__dirname, '../src/app/tools/child-tool-host/child-tool-host.component.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
const decorator = () => () => undefined;
const imports = new Proxy({}, { get: () => decorator });
const output = { exports: {} };
new Function('require', 'module', 'exports', compiled)(() => imports, output, output.exports);
const { ChildToolHostComponent } = output.exports;
function fixture(close) {
  const instance = Object.create(ChildToolHostComponent.prototype), calls = [];
  Object.assign(instance, { config: { runtime: { browserExecution: {} } }, closing: false,
    resolvedToolId: 'simulator', browserSurface: { close },
    uiService: { completeToolClose: id => calls.push(id) },
    notifyChildBeforeClose: () => { throw Error('Browser View has no iframe endpoint'); },
    processService: { forceStop: () => { throw Error('Shared runtime must not be force-stopped'); } },
  });
  Object.defineProperty(instance, 'isStandalone', { value: false });
  return { instance, calls };
}
test('strict Browser close waits for the original cleanup ACK and then removes the panel', async () => {
  let acknowledge; const ack = new Promise(resolve => { acknowledge = resolve; });
  const { instance, calls } = fixture(() => ack), pending = instance.close({ strict: true });
  await Promise.resolve(); assert.deepEqual(calls, []);
  acknowledge({ released: true, refCount: 0, acknowledged: true, physicalClosed: true });
  assert.equal((await pending).ok, true); assert.deepEqual(calls, ['simulator']);
});
test('failed Browser cleanup retains the panel and permits the exact cleanup retry', async () => {
  let attempts = 0;
  const { instance, calls } = fixture(async () => { if (++attempts === 1) throw Error('Node ACK missing'); return { released: true }; });
  assert.equal((await instance.close({ strict: true })).ok, false);
  assert.deepEqual(calls, []); assert.equal(instance.closing, false);
  assert.equal((await instance.close({ strict: true })).ok, true); assert.equal(attempts, 2);
});
test('legacy strict iframe close still respects its beforeClose refusal', async () => {
  const { instance, calls } = fixture(() => { throw Error('Not a Browser View'); });
  instance.config = {}; instance.notifyChildBeforeClose = async () => false;
  assert.equal((await instance.close({ strict: true })).ok, false); assert.deepEqual(calls, []);
});


test('resize retries remeasure the viewport and keep Main bounds failures bounded', async t => {
  const text = fs.readFileSync(path.join(__dirname, '../src/app/tools/child-tool-browser-surface/child-tool-browser-surface.component.ts'), 'utf8');
  const code = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
  const module = { exports: {} }; new Function('require','module','exports',code)(() => imports,module,module.exports);
  const surface = Object.create(module.exports.ChildToolBrowserSurfaceComponent.prototype);
  let retries = 0, failures = [], calls = [], reject = true;
  Object.assign(surface, { destroyed: false, lastGeometry: '', geometryRetries: 0, active: true,
    geometry: () => ({ bounds: { x: 0, y: 0, width: 400 - retries, height: 300 }, visible: true }),
    handle: { update: async value => { calls.push(value); if (reject) throw Error('Embedded View bounds exceed its owner viewport'); } },
    schedule: () => { retries++; }, failed: { emit: error => failures.push(error) },
  });
  await surface.update(); assert.equal(retries,1); assert.equal(failures.length,0);
  reject=false; await surface.update(); assert.equal(calls[1].bounds.width,399); assert.equal(surface.geometryRetries,0);
  surface.lastGeometry=''; reject=true;
  for(let i=0;i<4;i++)await surface.update();
  assert.equal(retries,4); assert.equal(failures.length,1);
});
