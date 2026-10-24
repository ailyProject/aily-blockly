const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');

const base = path.join(__dirname, '../src/app');
function load(relative, imports = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(base, relative), 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  new Function('require', 'exports', output)(name => {
    assert(Object.hasOwn(imports, name), 'Only explicit source-fixture imports are allowed: ' + name);
    return imports[name];
  }, exports);
  return exports;
}
const helper = load('integrations/simulator/blockly-simulator-web-prewarm.ts');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const settle = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };

test('accepted claims capture readiness before awaiting and failed claims never rewrite accepted classification', async () => {
  const captured = { path: '/normal-project', projectSessionId: 'captured', signal: new AbortController().signal, requireCurrent() {} };
  const jobs = [], handles = [], selected = { captured, revision: 1, code: 'normal generated code' };
  const result = { projectPath: captured.path, activation: { original: true } };
  let rejectClaim = false, closes = 0;
  const trigger = helper.createBlocklySimulatorPrewarmTrigger({ readSelection: () => selected,
    schedule(work) { jobs.push(work); return () => { const index = jobs.indexOf(work); if (index >= 0) jobs.splice(index, 1); }; },
    prepare() { const gate = deferred(); const handle = { gate, ready: gate.promise,
      async readPublication() { await gate.promise; if (rejectClaim) throw Error('Controlled rejected claim'); return result; },
      async close() { closes++; } }; handles.push(handle); return handle; },
  });
  const prepare = async () => { trigger.notify(); jobs.shift()(); await settle(); return handles.at(-1); };
  const first = await prepare();
  const pending = trigger.readPreparedPublication(captured, new AbortController().signal);
  assert.equal(trigger.snapshot().claimCount, 0); assert.equal(trigger.snapshot().lastClaimReadiness, 'none');
  first.gate.resolve(); assert.equal(await pending, result);
  assert.equal(trigger.snapshot().claimCount, 1); assert.equal(trigger.snapshot().lastClaimReadiness, 'pending');
  const second = await prepare(); second.gate.resolve(); await settle();
  assert.equal(trigger.snapshot().ready, true);
  assert.equal(await trigger.readPreparedPublication(captured, new AbortController().signal), result);
  assert.equal(trigger.snapshot().claimCount, 2); assert.equal(trigger.snapshot().lastClaimReadiness, 'ready');
  const third = await prepare(); third.gate.resolve(); await settle(); rejectClaim = true;
  assert.equal(await trigger.readPreparedPublication(captured, new AbortController().signal), null);
  assert.equal(closes, 1); assert.equal(trigger.snapshot().claimCount, 2);
  assert.equal(trigger.snapshot().lastClaimReadiness, 'ready');
  assert.equal(trigger.snapshot().claimed, 2); assert.equal(trigger.snapshot().retainedPreparation, false);
  await trigger.close();
});

test('fixed prewarm projection never treats absent fields as zero or publishes a capability', async () => {
  const trigger = helper.createBlocklySimulatorPrewarmTrigger({ readSelection: () => null, prepare() { assert.fail(); } });
  const original = trigger.snapshot();
  const value = helper.projectBlocklySimulatorPrewarmSnapshot({ ...original, privateCapability: { never: 'published' } });
  assert(value); assert(Object.isFrozen(value)); assert.equal(Object.keys(value).length, 15);
  assert.equal(Object.hasOwn(value, 'privateCapability'), false);
  assert.equal(value.lastClaimReadiness, 'none'); assert.equal(value.claimCount, 0);
  for (const bad of [null, {}, { ...original, ready: undefined }, { ...original, claimCount: -1 },
    { ...original, attempts: Number.MAX_SAFE_INTEGER + 1 }, { ...original, claimed: 1 },
    { ...original, lastClaimReadiness: 'some-owner' }, { ...original, get ready() { throw Error('Observation failure'); } }]) {
    assert.equal(helper.projectBlocklySimulatorPrewarmSnapshot(bad), null);
  }
  await trigger.close();
});

test('normal application snapshot projects the original publication once without opening a project caller', async () => {
  const DESTROY = Symbol('destroy'), ACTIVATION = Symbol('activation'); let published;
  class Token { constructor(name) { this.name = name; } }
  const publicationModule = load('integrations/simulator/blockly-simulator-web-publication.ts');
  const module = load('integrations/simulator/simulator-web-app.providers.ts', {
    '@angular/core': { DestroyRef: DESTROY, InjectionToken: Token, inject(token) {
      assert.equal(token, DESTROY); return { onDestroy() {} };
    } },
    './simulator-web-product.providers': { provideSimulatorWebProduct(factory) { published = factory; return factory; } },
    './simulator-web-product.source': { createSimulatorWebProductSource() { assert.fail('Diagnostic read created a product source'); } },
    './simulator-web-project-activation': { createSimulatorWebProjectActivationReader() { assert.fail('Diagnostic read opened a project scope'); } },
    './simulator-web-project-activation.providers': { SIMULATOR_WEB_PROJECT_ACTIVATION: ACTIVATION },
    './blockly-simulator-web-publication': publicationModule,
    './blockly-simulator-web-prewarm': helper,
  });
  module.provideSimulatorWebApplication();
  const trigger = helper.createBlocklySimulatorPrewarmTrigger({ readSelection: () => null, prepare() { assert.fail(); } });
  let reads = 0, raw = trigger.snapshot();
  const source = published({}, { snapshot() { reads++; return { prewarm: raw, privateSource: { never: 'published' } }; } });
  const value = source.snapshot(); assert.equal(reads, 1); assert.equal(value.retainedCallers, 0);
  assert.deepEqual(value.publicationPrewarm, helper.projectBlocklySimulatorPrewarmSnapshot(raw));
  assert.equal(Object.hasOwn(value, 'privateSource'), false);
  raw = {}; assert.equal(source.snapshot().publicationPrewarm, null); assert.equal(reads, 2);
  await source.close(); await trigger.close();
});
