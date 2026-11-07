'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const esbuild = require('esbuild');

// Run the actual Editor build/cancel methods. Only preparation and the Main
// process-stop acknowledgement are controlled; no Angular/browser is started.
async function fixture() {
  const filename = path.resolve(__dirname, '../src/app/editors/blockly-editor/services/builder.service.ts');
  const transformed = await esbuild.transform(await fs.readFile(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node22', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  const ProcessState = { IDLE: 'idle', BUILDING: 'building', UPLOADING: 'uploading', INSTALLING: 'installing' };
  const module = { exports: {} }, messages = [], kills = [], finishes = [];
  const quiet = { log() {}, warn() {}, error() {}, info() {} };
  vm.runInNewContext(transformed.code, { module, exports: module.exports, console: quiet,
    AbortController, setTimeout, clearTimeout, window: {},
    require(id) {
      if (id === '@angular/core') return { Injectable: () => value => value };
      if (id === '@core/app-shell/public-api') return { ProcessState };
      if (id === '@shared/public-api') return { resolveLinuxBoardProjectRoute: () => null };
      if (id === 'rxjs/operators') return require(id);
      return {};
    },
  }, { filename });
  const service = Object.create(module.exports._BuilderService.prototype);
  const prepare = Promise.withResolvers(), stop = Promise.withResolvers(); let unsubscribed = 0;
  service.projectService = { currentProjectPath: '/original-project', currentPackageData: {}, getBuildPath: () => prepare.promise };
  service.workflowService = { currentState: ProcessState.IDLE, startBuild() {
    if (this.currentState !== ProcessState.IDLE) return false;
    this.currentState = ProcessState.BUILDING; return true;
  }, finishBuild(...args) { finishes.push(args); this.currentState = ProcessState.IDLE; } };
  service.electronService = { pathJoin: (...parts) => parts.join('/') };
  service.cmdService = { async kill(id) { kills.push(id); return stop.promise; }, spawn() { assert.fail('Cancelled preparation cannot launch a late compiler.'); } };
  service.t = key => key; service.message = { warning: value => messages.push(value) };
  for (const method of ['clearProgressTimer', 'updateCancelledNotice', 'ensureCancelState', 'handleCompileError']) service[method] = () => {};
  return { service, prepare, stop, kills, finishes, ProcessState, messages,
    attachProcess() { service.streamId = 'original-compiler-stream'; service.buildSubscription = { unsubscribe() { unsubscribed++; } }; },
    get unsubscribed() { return unsubscribed; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

for (const first of ['preparation', 'physical-stop']) test(`scoped cancellation joins ${first} and the other original obligation before releasing build`, async () => {
  const f = await fixture(), requestId = 'original-source-bound-request';
  let settled = false;
  const original = f.service.build('a'.repeat(64), requestId, 2).then(
    value => { settled = true; return value; }, error => { settled = true; return error; });
  f.attachProcess(); const originalSignal = f.service.buildCancellation.signal;
  f.service.cancel(requestId); f.service.cancel(requestId);
  assert.equal(originalSignal.aborted, true); assert.deepEqual(f.kills, ['original-compiler-stream']);
  assert.equal(f.unsubscribed, 0, 'Stopping observation is not physical process cleanup.');
  if (first === 'preparation') f.prepare.resolve(''); else f.stop.resolve(true);
  await turn(); assert.equal(settled, false); assert.equal(f.finishes.length, 0);
  assert.equal(f.service.workflowService.currentState, f.ProcessState.BUILDING);
  const busy = await f.service.build('b'.repeat(64), 'foreign-request', 2).catch(error => error);
  assert.equal(busy.state, 'warn'); assert.equal(busy.errorCode, undefined);
  if (first === 'preparation') f.stop.resolve(true); else f.prepare.resolve('');
  const outcome = await original;
  assert.equal(outcome.errorCode, 'build-cancelled'); assert.equal(f.finishes.length, 1);
  assert.equal(f.unsubscribed, 1); assert.equal(f.service.activeBuildRequestId, null);
  assert.equal(f.service.workflowService.currentState, f.ProcessState.IDLE);
});

test('foreign request cancellation leaves an actual original Editor build and its process untouched', async () => {
  const f = await fixture(), original = f.service.build('a'.repeat(64), 'original-request', 2).catch(error => error);
  f.attachProcess(); const signal = f.service.buildCancellation.signal;
  f.service.cancel('foreign-request'); await turn();
  assert.equal(signal.aborted, false); assert.deepEqual(f.kills, []); assert.equal(f.unsubscribed, 0);
  f.service.cancel('original-request'); f.stop.resolve(true); f.prepare.resolve('');
  assert.equal((await original).errorCode, 'build-cancelled');
});

for (const failure of [false, 'throw']) test(`unconfirmed compiler termination (${failure}) cannot complete, release workflow, or admit retry`, async () => {
  const f = await fixture(); let settled = false;
  f.service.build('a'.repeat(64), 'original-request', 2).then(() => { settled = true; }, () => { settled = true; });
  f.attachProcess(); f.service.cancel('original-request');
  if (failure === false) f.stop.resolve(false); else f.stop.reject(new Error('Physical stop is unconfirmed'));
  f.prepare.resolve(''); await turn(); await turn();
  assert.equal(settled, false); assert.equal(f.finishes.length, 0); assert.equal(f.unsubscribed, 0);
  assert.equal(f.service.activeBuildRequestId, 'original-request');
  assert.equal(f.service.workflowService.currentState, f.ProcessState.BUILDING);
  const busy = await f.service.build('b'.repeat(64), 'new-request', 2).catch(error => error);
  assert.equal(busy.state, 'warn'); assert.deepEqual(f.kills, ['original-compiler-stream']);
});
