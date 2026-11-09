'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const esbuild = require('esbuild');
const rx = require('rxjs');
const root = '/projects/coder';
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const scene = () => ({ schemaVersion: 2, kind: 'aily-scene-editor-document', sceneId: 'main',
  graphSemanticRevision: 'a'.repeat(64), components: [], terminals: [], componentConfigs: {} });
const decorator = () => () => {};

async function load(relative, mocks = {}, window = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const transformed = await esbuild.transform(await fs.readFile(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node22', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  const module = { exports: {} };
  vm.runInNewContext(transformed.code, { module, exports: module.exports, window, crypto, AbortController, AbortSignal,
    DOMException, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (mocks[name]) return mocks[name];
      if (name === '@angular/core') return { Injectable: () => value => value, Inject: decorator, Optional: decorator };
      if (name === 'rxjs') return rx;
      return {};
    },
  }, { filename });
  return module.exports;
}

async function compilerFixture() {
  const files = new Map([[root+'/package.json', JSON.stringify({ type: 'coder', entry: 'src/main.cpp', dependencies: { '@aily-project/board-test': '1' } })],
    [root+'/sketch/src/main.cpp', '#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}']]);
  const commands = [], finishes = [], captures = [], metadata = [], killCalls = [];
  const spawned = deferred(), stop = deferred();
  const exists = file => files.has(file) || [...files.keys()].some(key => key.startsWith(file+'/'));
  const window = { fs: { readFileSync: file => { if (!files.has(file)) throw Error('Missing '+file); return files.get(file); },
    writeFileSync: (file, text) => files.set(file, text) },
    path: { isExists: exists, getAilyBuilderPath: () => '/builder', getAppDataPath: () => '/app', getAilyChildPath: () => '/child' },
    builder: { captureBuildSource(config) { captures.push(config); return { mode: 'coder', digest: 'b'.repeat(64) }; } } };
  const requests = await load('src/app/utils/build-request.utils.ts', {}, window);
  const publications = await load('src/app/utils/build-publication.utils.ts', {}, window);
  const progress = await load('src/app/utils/aily-builder-progress.utils.ts');
  const gpio = await load('src/app/integrations/simulator/simulator-scene-gpio-build-metadata.ts', {
    '@aily-project/simulator-host-sdk': { inferArduinoGpioConfigurations: () => [], inferArduinoHardwareHints: () => [] },
  });
  const { CompileService } = await load('src/app/services/domains/build/compile.service.ts', {
    '@core/platform/public-api': { isCmdTerminalOutput: output => ['close', 'exit'].includes(output.type) },
    '@domain/project/public-api': { coderSourceDirectory: manifest => manifest.arduinoSketch ? '' : 'sketch' },
    '../../../utils/build-request.utils': requests,
    '../../../utils/build-publication.utils': publications,
    '../../../utils/aily-builder-progress.utils': progress,
    '../../../integrations/simulator/simulator-scene-gpio-build-metadata': gpio,
    '../../../utils/project-log.utils': { appendProjectLog() {} },
  }, window);
  const subject = new rx.Subject();
  let busy = false;
  const service = new CompileService({ currentProjectPath: root, isAilyCodeProject: () => true, getProjectDependencyBlockMessage: () => null },
    { spawn(command, args, options) { commands.push({ command, args, options }); spawned.resolve(); return subject; },
      async kill(id) { killCalls.push(id); const result = await stop.promise; if (result === true) subject.complete(); return result; } },
    { createDirectory: async () => {} }, { pathJoin: (...parts) => path.posix.join(...parts) },
    { startBuild() { if (busy) return false; busy = true; return true; }, finishBuild(...args) { finishes.push(args); busy = false; }, updateNotice() {} },
    { za7: '/7z' }, { data: {}, isCoderProduct: () => true }, { warning() {}, error() {} },
    { triggerAfterSuccessfulCompile() {} }, { update() {} }, { instant: key => key },
    { updateCodeHash: async () => 'captured', saveBuildInfo: async (...args) => metadata.push(args) },
    { assertCoderDependenciesReady: async () => {} });
  return { service, files, commands, finishes, captures, metadata, killCalls, spawned, stop, subject, get busy() { return busy; } };
}

test('Coder simulation emits a scene-bound delivery request from saved disk sources', async () => {
  const f = await compilerFixture(), controller = new AbortController();
  const pending = f.service.runCompileFromDisk({ projectPath: root, requestId: 'original-request', signal: controller.signal,
    recordProjectDelivery: true, graphSemanticRevision: scene().graphSemanticRevision, sceneDocument: scene() });
  await Promise.race([f.spawned.promise, pending.then(result => { assert.fail(JSON.stringify(result)); })]);
  const command = f.commands[0], config = JSON.parse(f.files.get(command.args[1]));
  assert.equal(command.options.buildDeliveryRequest, command.args[1]);
  assert.equal(command.options.buildWorkspace, root);
  assert.equal(config.recordProjectDelivery, true); assert.equal(config.graphSemanticRevision, scene().graphSemanticRevision);
  assert.equal(config.code, f.files.get(root+'/sketch/src/main.cpp'));
  assert.equal(config.sourceCapture.mode, 'coder'); assert.equal(config.sourceCapture.workspace, undefined);
  assert.equal(JSON.parse(f.files.get(config.sceneGpioDirectionsPath)).kind, 'aily-scene-gpio-directions');
  f.subject.next({ type: 'close', code: 0 }); f.subject.complete();
  assert.equal((await pending).success, true); assert.equal(f.finishes.length, 1);
});

test('foreign request cannot cancel a normal or another scoped Coder compiler', async () => {
  for (const requestId of [undefined, 'original-request']) {
    const f = await compilerFixture(); const pending = f.service.runCompileFromDisk({ projectPath: root, requestId });
    await f.spawned.promise; f.service.cancel('foreign-request'); await turn();
    assert.equal(f.service.cancelled, false); assert.equal(f.killCalls.length, 0); assert.equal(f.finishes.length, 0);
    f.subject.next({ type: 'close', code: 0 }); f.subject.complete(); await pending;
  }
});

test('original signal cancellation keeps the build busy until physical tree-stop confirmation', async () => {
  const f = await compilerFixture(), controller = new AbortController();
  const pending = f.service.runCompileFromDisk({ projectPath: root, requestId: 'original-request', signal: controller.signal });
  await f.spawned.promise; controller.abort();
  f.subject.next({ type: 'close', code: 0 }); f.subject.complete(); await turn();
  assert.deepEqual(f.killCalls, [f.commands[0].options.streamId]);
  assert.equal(f.finishes.length, 0); assert.equal(f.metadata.length, 0); assert.equal(f.busy, true);
  f.stop.resolve(true); const result = await pending;
  assert.equal(result.success, false); assert.equal(result.result.errorCode, 'build-cancelled');
  assert.equal(f.finishes.length, 1); assert.equal(f.metadata[0][2], 'cancelled'); assert.equal(f.busy, false);
});

for (const failure of [false, 'throw']) test(`unconfirmed scoped stop ${failure} does not release or admit another build`, async () => {
  const f = await compilerFixture(), controller = new AbortController(); let settled = false;
  f.service.runCompileFromDisk({ projectPath: root, requestId: 'original-request', signal: controller.signal }).then(() => { settled = true; }, () => { settled = true; });
  await f.spawned.promise; controller.abort(); f.subject.next({ type: 'close', code: 0 }); f.subject.complete();
  if (failure === false) f.stop.resolve(false); else f.stop.reject(Error('not confirmed'));
  await turn(); await turn();
  assert.equal(settled, false); assert.equal(f.busy, true); assert.equal(f.finishes.length, 0);
  const busy = await f.service.runCompileFromDisk({ projectPath: root, requestId: 'new-request' });
  assert.equal(busy.success, false); assert.equal(f.commands.length, 1);
});

async function builderFixture({ save = deferred() } = {}) {
  const calls = [], saved = deferred();
  const { BuilderService } = await load('src/app/services/domains/build/builder.service.ts', {
    './build-result-snapshot': { persistBuildResult() {} },
  });
  const service = new BuilderService({ dispatchWithFeedback() { saved.resolve(); return rx.from(save.promise); } },
    { currentProjectPath: root, isCoderProjectContext: true, isAilyCodeProject: () => true,
      coderProjects: [{ path: root }], boardChangeSubject: new rx.Subject() }, {}, {}, {},
    { async runCompileFromDisk(input) { calls.push(input); return { success: true, result: { state: 'done' } }; } });
  return { service, save, saved, calls };
}

test('Coder builder waits for actual save success then forwards the exact scope', async () => {
  const f = await builderFixture(), controller = new AbortController();
  const input = { requestId: 'original-request', graphSemanticRevision: scene().graphSemanticRevision, sceneDocument: scene(), signal: controller.signal };
  const pending = f.service.buildCoderProjectForSimulation(root, input);
  await f.saved.promise; assert.equal(f.calls.length, 0);
  f.save.resolve({ success: true }); await pending;
  assert.equal(f.calls[0].projectPath, root); assert.equal(f.calls[0].requestId, input.requestId);
  assert.equal(f.calls[0].signal, input.signal); assert.equal(f.calls[0].recordProjectDelivery, true);
});

for (const cause of ['save-failure', 'aborted-during-save', 'wrong-project', 'wrong-scene']) test(`Coder build rejects ${cause} before disk compilation`, async () => {
  const f = await builderFixture(), controller = new AbortController();
  const input = { requestId: 'original-request', graphSemanticRevision: scene().graphSemanticRevision, sceneDocument: scene(), signal: controller.signal };
  if (cause === 'wrong-scene') input.graphSemanticRevision = 'b'.repeat(64);
  const pending = f.service.buildCoderProjectForSimulation(cause === 'wrong-project' ? '/foreign' : root, input);
  if (cause === 'aborted-during-save') controller.abort();
  f.save.resolve({ success: cause !== 'save-failure', error: 'save failed' });
  await assert.rejects(pending); assert.equal(f.calls.length, 0);
});
