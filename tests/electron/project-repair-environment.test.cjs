const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { createProjectRecoveryReceipts } = require('../../electron/project-recovery-receipts');
const { createRepairEnvironmentController, readRepairBootstrap, codeIdentity, rendererOverride, shutdownRepairEnvironment, verifyFork } = require('../../electron/project-repair-environment');
const { createRepairContinuationController, checkRepairProjectOpen } = require('../../electron/project-repair-lineage');
const loadProjectViewLocks = require('./fixtures/project-view-locks.cjs');
const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const output = path.resolve(__dirname, '../test-results/abs-recovery-next-20261026/native-repair');
fs.mkdirSync(output, { recursive: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(output, 'case-'));
  t.after(() => { if (!path.resolve(root).startsWith(output + path.sep)) throw new Error('Invalid test cleanup root'); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'source'), target = path.join(root, 'target'), appData = path.join(root, 'parent-data'), appPath = path.join(root, 'same-app');
  for (const dir of [source, target, appData, path.join(appPath, 'electron')]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ['main.js', 'preload.js']) fs.writeFileSync(path.join(appPath, 'electron', name), 'same code');
  for (const relative of ['electron/project-repair-environment.js', 'electron/project-repair-lineage.js', 'electron/project-repair-normalization.js',
    'electron/project-recovery-receipts.js', 'electron/project-repair-handoff.js', 'electron/project-repair-primary.js',
    'electron/project-file-access.js', 'electron/project-lock.js', 'child/scripts/native-file-lock.js',
    'child/scripts/build-workspace-lease.js', 'child/scripts/system-boot-id.js']) {
    const file = path.join(appPath, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'same protocol code');
  }
  fs.writeFileSync(path.join(appPath, 'package.json'), '{"main":"electron/main.js"}');
  const abi = JSON.stringify({ blocks: { blocks: [{ type: 'missing_block' }] } });
  for (const project of [source, target]) { fs.writeFileSync(path.join(project, 'project.abi'), abi); fs.writeFileSync(path.join(project, 'package.json'), '{"name":"fixture"}'); }
  fs.writeFileSync(path.join(source, 'project.abs'), Buffer.from([0xff, 0xfe, 0x41]));
  const archive = path.join(target, 'recovery-source-fixture.json');
  fs.writeFileSync(archive, JSON.stringify({ version: 1, sourceProject: source, files: { 'project.abi': abi }, partialCanvas: { captured: false } }));
  const store = createProjectRecoveryReceipts(appData), request = 'fixture-request-123';
  const result = { ok: true, sourceProject: source, project: target, projectSaved: true, activated: false, recoveryArchive: archive,
    activationBlocked: { reason: 'partial-canvas-unavailable' }, recoverySource: { version: 1, kind: 'saved-document', complete: true, loadFailed: true, partialCanvas: 'unavailable' } };
  store.begin(source, request, '[]', hash(abi)); store.complete(source, request, '[]', result, hash(abi));
  let spawned = 0, launch;
  const opts = { appDataPath: appData, appPath, execPath: process.execPath, pid: 100, serve: true,
    env: { AILY_DEV_RENDERER_URL: 'http://127.0.0.1:4205', AILY_NPM_PREFIX: path.join(appData, 'managed') },
    spawnChild: (exe, args, options) => { spawned++; launch = { exe, args, options }; return { pid: 200, once() {}, unref() {} }; },
    observeChild: async () => null, queryChild: async () => null, processState: pid => pid === 100 || pid === 200,
    sourceViewRetained: () => true, sourceRendererGeneration: () => 1, projectViewLocks: loadProjectViewLocks() };
  const prepare = createRepairEnvironmentController(opts), continuation = createRepairContinuationController(opts);
  const resume = { version: 1, project: target, sourceProject: source, requestId: request, resumeRequestId: 'fixture-resume-123' };
  let activation;
  const controller = { ensure: () => activation ??= (async () => {
    await prepare.ensure(source, request); const result = await continuation.resume(resume);
    assert.equal(result.code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING', JSON.stringify(result)); return result.repairEnvironment;
  })() };
  return { root, source, target, abi, appData, appPath, request, opts, controller, prepare, continuation, resume,
    launch: () => launch, spawned: () => spawned };
}
const identityParams = env => ({ version: 2, project: env.project, environmentId: env.environmentId, requestId: env.requestId,
  parentHostPid: env.parentHostPid, lineageId: env.lineageId, epoch: env.epoch });
function evidenceReader(files) {
  const filename = path.resolve(__dirname, '../../electron/project-repair-environment.js'), localRequire = createRequire(filename);
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', '__filename', fs.readFileSync(filename, 'utf8'))(
    name => name === 'node:fs' ? files : localRequire(name), instance, instance.exports, path.dirname(filename), filename);
  return instance.exports.readJson;
}
for (const kind of ['replacement', 'mtime']) test(`private evidence ${kind} races use a dedicated observation code without relaxing snapshot checks`, t => {
  const f = fixture(t), file = path.join(f.root, 'evidence.json'); fs.writeFileSync(file, '{"state":"starting"}');
  let reads = 0;
  const reader = evidenceReader({ ...fs,
    readFileSync(filename, ...args) {
      const data = fs.readFileSync(filename, ...args);
      if (filename === file && kind === 'replacement') {
        fs.writeFileSync(file + '.next', '{"state":"ready"}'); fs.renameSync(file + '.next', file);
      }
      return data;
    },
    lstatSync(filename, ...args) {
      const stat = fs.lstatSync(filename, ...args);
      if (filename === file && ++reads === 2 && kind === 'mtime') return Object.assign(Object.create(stat), { mtimeMs: stat.mtimeMs + 1 });
      return stat;
    } });
  assert.throws(() => reader(file), { code: 'PROJECT_REPAIR_EVIDENCE_CHANGED' });
});
for (const operation of ['inspect', 'resume']) test(`${operation} evidence races offer only exact read-only observation, never a mutation replay`, async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request);
  const native = require('../../electron/project-repair-environment'), original = native.readJson;
  let changed = false;
  const reader = evidenceReader({ ...fs, readFileSync(filename, ...args) {
    const data = fs.readFileSync(filename, ...args);
    if (!changed && filename.endsWith('.json')) {
      changed = true; fs.writeFileSync(filename + '.race', data); fs.renameSync(filename + '.race', filename);
    }
    return data;
  } });
  let raced;
  try { native.readJson = reader; raced = await f.continuation[operation](operation === 'inspect' ? { version: 1, project: f.target } : f.resume); }
  finally { native.readJson = original; }
  assert.equal(raced.code, 'PROJECT_REPAIR_EVIDENCE_CHANGED'); assert.equal(raced.recoverability.state, 'observation-raced');
  assert.deepEqual(raced.nextAction, { tool: 'project_recover', input: { project: f.target, action: 'inspect_environment' } });
  assert.equal(raced.sourceGuardReleased, false); assert.equal(raced.originalWorkspaceRebound, false); assert.equal(f.spawned(), 0);
  assert.equal((await f.continuation.inspect({ version: 1, project: f.target })).ok, true);
});
test('a definite preparation failure is retryable with the same request after its cause is fixed', async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request);
  fs.writeFileSync(path.join(f.appData, 'config.json'), '{invalid config');
  const failed = await f.continuation.resume(f.resume);
  assert.equal(failed.code, 'PROJECT_REPAIR_NOT_STARTED'); assert.equal(failed.retryableResume.phase, 'preparation');
  assert.equal(failed.retryableResume.resumeRequestId, f.resume.resumeRequestId); assert.equal(f.spawned(), 0);
  fs.writeFileSync(path.join(f.appData, 'config.json'), '{}');
  const observed = await f.continuation.inspect({ version: 1, project: f.target });
  assert.equal(observed.ok, true); assert.equal(observed.pendingResume, undefined);
  assert.equal(observed.retryableResume.resumeRequestId, f.resume.resumeRequestId);
  const retried = await f.continuation.resume(f.resume);
  assert.equal(retried.code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING'); assert.equal(f.spawned(), 1);
  await f.continuation.resume(f.resume); assert.equal(f.spawned(), 1);
});
test('a synchronous rejected launch is known not started, without treating an unknown returned PID as safe', async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request);
  let rejected = true;
  const controller = createRepairContinuationController({ ...f.opts, spawnChild: (...args) => {
    if (rejected) throw Object.assign(new Error('Invalid local spawn arguments'), { code: 'ERR_INVALID_ARG_VALUE' });
    return f.opts.spawnChild(...args);
  } });
  const failed = await controller.resume(f.resume);
  assert.equal(failed.code, 'PROJECT_REPAIR_NOT_STARTED'); assert.equal(failed.retryableResume.phase, 'launch-rejected');
  assert.equal(f.spawned(), 0); rejected = false;
  assert.equal((await controller.resume(f.resume)).code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING'); assert.equal(f.spawned(), 1);
});
test('an interrupted preparation can resume after controller restart without replaying unknown launches', async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request);
  fs.writeFileSync(path.join(f.appData, 'config.json'), '{invalid config');
  await f.continuation.resume(f.resume);
  const lineageRoot = path.join(f.appData, 'agent-repair-environments', 'lineages');
  const requests = path.join(lineageRoot, fs.readdirSync(lineageRoot)[0], 'requests');
  const requestFile = path.join(requests, f.resume.resumeRequestId + '.json');
  const interrupted = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  interrupted.state = 'preparing'; delete interrupted.failure;
  fs.writeFileSync(requestFile, JSON.stringify(interrupted));
  fs.writeFileSync(path.join(f.appData, 'config.json'), '{}');
  const restarted = createRepairContinuationController(f.opts);
  const inspected = await restarted.inspect({ version: 1, project: f.target });
  assert.equal(inspected.ok, true); assert.equal(inspected.retryableResume.code, 'PROJECT_REPAIR_PREPARATION_INTERRUPTED');
  assert.equal((await restarted.resume(f.resume)).code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING'); assert.equal(f.spawned(), 1);
  assert.equal(fs.existsSync(interrupted.recordFile), true, 'Keep the previous partial attempt as evidence');
});
test('a returned process handle without a confirmed PID stays pending and cannot launch another attempt', async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request); let attempted = 0, errorObserver = 0;
  const controller = createRepairContinuationController({ ...f.opts, spawnChild: () => {
    attempted++; return { once(name) { if (name === 'error') errorObserver++; } };
  } });
  assert.equal((await controller.resume(f.resume)).code, 'PROJECT_REPAIR_SPAWN_UNCONFIRMED');
  const inspected = await controller.inspect({ version: 1, project: f.target });
  assert.equal(inspected.code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING'); assert.equal(inspected.retryableResume, undefined);
  await controller.resume(f.resume); await controller.resume({ ...f.resume, resumeRequestId: 'another-unconfirmed-pid' });
  assert.equal(attempted, 1); assert.equal(errorObserver, 1);
});
test('saved target continuation survives a moved historical source without rebinding or rewriting it', async t => {
  const f = fixture(t); const env = await f.controller.ensure(f.source, f.request);
  const child = readRepairBootstrap(f.launch().options.env.AILY_REPAIR_BOOTSTRAP,
    { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  child.complete({ project: f.target, ready: true });
  const targetBefore = fs.readFileSync(path.join(f.target, 'project.abi'));
  const moved = f.source + '-moved'; fs.renameSync(f.source, moved);
  const controller = createRepairContinuationController({ ...f.opts,
    queryChild: async record => child.identity(identityParams({ ...env, ...record })).repairEnvironment });
  const inspected = await controller.inspect({ version: 1, project: f.target });
  assert.equal(inspected.ok, true, JSON.stringify(inspected)); assert.equal(inspected.repairEnvironment.state, 'ready');
  assert.equal(inspected.recoveryContinuation.sourceProject, f.source);
  const resumed = await controller.resume({ ...f.resume, resumeRequestId: 'moved-source-resume-123' });
  assert.equal(resumed.ok, true); assert.equal(f.spawned(), 1); assert.equal(fs.existsSync(f.source), false);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'project.abi')), targetBefore);
  assert.equal(fs.readFileSync(path.join(moved, 'project.abi'), 'utf8'), f.abi);
});
test('historical source proof does not accept a current source alias into the independent target', async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request);
  fs.renameSync(f.source, f.source + '-moved'); fs.symlinkSync(f.target, f.source, 'junction');
  const result = await f.continuation.inspect({ version: 1, project: f.target });
  assert.equal(result.ok, false); assert.match(result.message, /independent physical/); assert.equal(f.spawned(), 0);
});
test('old lineages acquire a physical snapshot only while the original source can still be verified', async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request);
  const recordRoot = path.join(f.appData, 'agent-repair-environments');
  const initialFile = path.join(recordRoot, fs.readdirSync(recordRoot).find(name => /^[a-f0-9]{64}\.json$/.test(name)));
  const old = JSON.parse(fs.readFileSync(initialFile, 'utf8')); delete old.physicalOrigin;
  fs.writeFileSync(initialFile, JSON.stringify(old));
  assert.equal((await f.continuation.inspect({ version: 1, project: f.target })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(initialFile, 'utf8')).physicalOrigin.version, 1);
  fs.renameSync(f.source, f.source + '-moved');
  assert.equal((await f.continuation.inspect({ version: 1, project: f.target })).ok, true);
  const again = JSON.parse(fs.readFileSync(initialFile, 'utf8')); delete again.physicalOrigin;
  fs.writeFileSync(initialFile, JSON.stringify(again));
  const unsupported = await f.continuation.inspect({ version: 1, project: f.target });
  assert.equal(unsupported.code, 'PROJECT_REPAIR_HISTORICAL_PROOF_UNAVAILABLE');
  assert.equal(unsupported.recoverability.state, 'historical-proof-unavailable');
  assert.equal(unsupported.nextAction.input.action, 'inspect'); assert.equal(f.spawned(), 0);
});
test('a pinned target cannot be redirected through an ancestor junction after its historical source moves', async t => {
  const f = fixture(t), originalParent = path.join(f.root, 'target-parent'), redirectedParent = path.join(f.root, 'redirected-parent');
  for (const parent of [originalParent, redirectedParent]) fs.mkdirSync(path.join(parent, 'project'), { recursive: true });
  const alias = path.join(f.root, 'target-alias'); fs.symlinkSync(originalParent, alias, 'junction');
  const target = path.join(alias, 'project'), requestId = 'pinned-target-origin';
  for (const parent of [originalParent, redirectedParent]) {
    const directory = path.join(parent, 'project');
    fs.writeFileSync(path.join(directory, 'project.abi'), f.abi);
    fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"redirect-check"}');
    fs.writeFileSync(path.join(directory, 'source-proof.json'), JSON.stringify({ version: 1,
      sourceProject: f.source, files: { 'project.abi': f.abi }, partialCanvas: { captured: false } }));
  }
  const store = createProjectRecoveryReceipts(f.appData); store.begin(f.source, requestId, '[]', hash(f.abi));
  store.complete(f.source, requestId, '[]', { projectSaved: true, activated: false, project: target, sourceProject: f.source,
    recoveryArchive: path.join(target, 'source-proof.json'), activationBlocked: { reason: 'partial-canvas-unavailable' },
    recoverySource: { kind: 'saved-document', complete: true, partialCanvas: 'unavailable' } }, hash(f.abi));
  await f.prepare.ensure(f.source, requestId); fs.renameSync(f.source, f.source + '-moved');
  fs.unlinkSync(alias); fs.symlinkSync(redirectedParent, alias, 'junction');
  const result = await f.continuation.inspect({ version: 1, project: target });
  assert.equal(result.ok, false); assert.match(result.message, /native physical origin/); assert.equal(f.spawned(), 0);
});
test('an authenticated child can prepare a complete workspace fork under its owning root without inheriting the old saved-primary restriction', async t => {
  const f = fixture(t), env = await f.controller.ensure();
  const sourceChild = readRepairBootstrap(f.launch().options.env.AILY_REPAIR_BOOTSTRAP,
    { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  sourceChild.complete({ project: f.target, ready: true });
  const actualEnvironment = sourceChild.identity(identityParams(env)).repairEnvironment;
  const controller = createRepairContinuationController({ ...f.opts, queryChild: async record =>
    sourceChild.identity(identityParams({ ...actualEnvironment, ...record })).repairEnvironment });
  const sourceRecord = await controller.authenticatedSource(actualEnvironment);
  await assert.rejects(controller.authenticatedSource({ ...actualEnvironment, epoch: actualEnvironment.epoch + 1 }), /native owner lineage/);
  const target = path.join(f.root, 'nested-target'); fs.mkdirSync(target);
  const liveAbi = '{"blocks":{"blocks":[{"type":"live_workspace_edit"}]}}';
  fs.writeFileSync(path.join(target, 'project.abi'), liveAbi); fs.writeFileSync(path.join(target, 'package.json'), '{"name":"nested"}');
  const requestId = 'nested-workspace-fork';
  const store = createProjectRecoveryReceipts(sourceRecord.privateAppData);
  store.begin(f.target, requestId, '[]', hash(f.abi));
  store.complete(f.target, requestId, '[]', { ok: true, projectSaved: true, activated: false,
    project: target, sourceProject: f.target, recoverySource: { version: 1, kind: 'workspace', complete: true,
      loadFailed: false, partialCanvas: 'not-applicable' } }, hash(liveAbi));
  assert.throws(() => verifyFork(sourceRecord.privateAppData, f.target, requestId, false), /exact completed/);
  const prepared = await f.prepare.prepareDelegated({ sourceRecord, sourceEnvironment: actualEnvironment,
    sourceProject: f.target, project: target, requestId });
  assert.equal(prepared.parentHostPid, 100); assert.equal(prepared.hostPid, undefined);
  let launch;
  const continuation = createRepairContinuationController({ ...f.opts, spawnChild: (exe, args, options) => {
    launch = { exe, args, options }; return { pid: 201, once() {}, unref() {} };
  } });
  const resumed = await continuation.resume({ version: 1, project: target, sourceProject: f.target,
    requestId, resumeRequestId: 'nested-workspace-resume' });
  assert.equal(resumed.repairEnvironment.parentHostPid, 100); assert.equal(resumed.repairEnvironment.hostPid, 201);
  const nested = readRepairBootstrap(launch.options.env.AILY_REPAIR_BOOTSTRAP,
    { execPath: process.execPath, appPath: f.appPath, pid: 201 });
  assert.equal(nested.admission().recoverySource.kind, 'workspace'); assert.equal(nested.admission().targetAbiHash, hash(liveAbi));
  nested.complete({ project: target, ready: true });
  assert.equal(sourceChild.identity(identityParams(actualEnvironment)).repairEnvironment.state, 'ready');
  assert.equal(fs.readFileSync(path.join(f.target, 'project.abi'), 'utf8'), f.abi);
});
test('unserialisable source launches a private same-exec repair view without altering source bytes', async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.source, 'project.abs'));
  const env = await f.controller.ensure(f.source, f.request), launch = f.launch();
  assert.equal(env.state, 'starting'); assert.equal(env.originalViewPreserved, true); assert.equal(env.hostPid, 200);
  assert.equal(env.hostCodeIdentity, codeIdentity(process.execPath, f.appPath));
  assert.equal(launch.exe, process.execPath); assert.equal(launch.args[0], f.appPath); assert.ok(launch.args.includes('--serve'));
  assert.notEqual(launch.options.env.AILY_APPDATA_PATH, f.appData);
  assert.ok(launch.args.some(arg => arg.startsWith('--user-data-dir=') && !arg.endsWith(f.appData)));
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'project.abs')), before);
  assert.equal(fs.existsSync(path.join(f.target, 'project.abs')), false);
});
test('lost ACK and parent controller restart observe one exact launch, never duplicate spawn', async t => {
  const f = fixture(t);
  const [first, concurrent] = await Promise.all([f.controller.ensure(f.source, f.request), f.controller.ensure(f.source, f.request)]);
  assert.deepEqual(first, concurrent); assert.equal(f.spawned(), 1);
  const restarted = createRepairContinuationController({ ...f.opts, pid: 101 });
  const next = (await restarted.resume(f.resume)).repairEnvironment;
  assert.equal(f.spawned(), 1); assert.equal(next.environmentId, first.environmentId); assert.equal(next.parentHostPid, 100);
  assert.equal(next.state, 'starting');
});
test('trusted child handoff revalidates completed receipt and loads a precise saved-primary capability', async t => {
  const f = fixture(t), env = await f.controller.ensure(f.source, f.request), launch = f.launch();
  const child = readRepairBootstrap(launch.options.env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  assert.equal(child.admission().targetAbiHash, hash(f.abi));
  const params = identityParams(env);
  assert.equal(child.identity(params).repairEnvironment.state, 'starting');
  child.complete({ project: f.target, ready: false, error: 'Missing library' });
  assert.equal(child.identity(params).repairEnvironment.state, 'load-failed');
  assert.equal(child.identity({ ...params, project: f.source }).ok, false);
  assert.equal(child.identity({ ...params, environmentId: 'other' }).ok, false);
});
test('bootstrap cannot be replayed in another process, executable, or changed build', async t => {
  const f = fixture(t); await f.controller.ensure(f.source, f.request);
  const filename = f.launch().options.env.AILY_REPAIR_BOOTSTRAP, correct = { execPath: process.execPath, appPath: f.appPath, pid: 200 };
  assert.throws(() => readRepairBootstrap(filename, { ...correct, pid: 201 }), /another process/);
  assert.throws(() => readRepairBootstrap(filename, { ...correct, execPath: path.join(f.root, 'different.exe') }), /exact application/);
  fs.writeFileSync(path.join(f.appPath, 'electron', 'main.js'), 'newer build');
  assert.throws(() => readRepairBootstrap(filename, correct), /exact application/);
});
test('initial target normalisation does not silently attest a different primary', async t => {
  const f = fixture(t); await f.controller.ensure(f.source, f.request);
  const child = readRepairBootstrap(f.launch().options.env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  fs.writeFileSync(path.join(f.target, 'project.abi'), '{"changed":true}');
  assert.throws(() => child.complete({ project: f.target, ready: true }), /changed the saved primary/);
});
test('tampered archive or arbitrary path cannot create repair launch authority', async t => {
  const f = fixture(t);
  await assert.rejects(f.prepare.ensure(f.source, 'unknown-request'), /exact completed/);
  fs.writeFileSync(path.join(f.target, 'recovery-source-fixture.json'), '{}');
  await assert.rejects(f.prepare.ensure(f.source, f.request), /archive/); assert.equal(f.spawned(), 0);
});
test('private auth starts empty and strict config/environment allowlists do not inherit session secrets', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.appData, '.aily'), '{"refresh_token":"private-parent-refresh"}');
  fs.writeFileSync(path.join(f.appData, 'config.json'), JSON.stringify({ lang: 'zh_CN', theme: 'dark', access_token: 'secret',
    compile: { backend: 'cloud', token: 'secret' }, agent: { apiKey: 'secret' },
    regions: { local: { npm_registry: 'http://127.0.0.1:4873', api_server: 'https://user:secret@example.test' } } }));
  f.opts.env.AILY_AUTH_FILE = '/private/parent-auth'; f.opts.env.OPENAI_API_KEY = 'secret'; f.opts.env.AILY_AGENT_TOKEN = 'secret';
  f.opts.env.NODE_OPTIONS = '--require=parent-code.js'; f.opts.env.PATH = '/runtime/path';
  await f.controller.ensure(f.source, f.request);
  const env = f.launch().options.env, config = JSON.parse(fs.readFileSync(path.join(env.AILY_APPDATA_PATH, 'config.json')));
  assert.equal(config.compile.backend, 'local'); assert.equal(config.lang, 'zh_CN'); assert.equal(config.agent, undefined);
  assert.equal(config.access_token, undefined); assert.equal(config.regions.local.api_server, undefined);
  assert.equal(config.regions.local.npm_registry, 'http://127.0.0.1:4873/');
  for (const name of ['AILY_AUTH_FILE', 'OPENAI_API_KEY', 'AILY_AGENT_TOKEN', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
  assert.equal(env.PATH, '/runtime/path'); assert.equal(fs.existsSync(path.join(env.AILY_APPDATA_PATH, '.aily')), false);
});
test('parent observation accepts only the authenticated owned child observation', async t => {
  const f = fixture(t), first = await f.controller.ensure(f.source, f.request);
  const controller = createRepairContinuationController({ ...f.opts, queryChild: async record => ({ ...first, state: 'ready', hostPid: record.hostPid }) });
  assert.equal((await controller.resume(f.resume)).repairEnvironment.state, 'ready'); assert.equal(f.spawned(), 1);
});
test('development renderer rejects external, credentialled, routed or malformed URLs', () => {
  assert.equal(rendererOverride('http://localhost:4200'), 'http://localhost:4200');
  assert.equal(rendererOverride('http://127.0.0.1:4205/'), 'http://127.0.0.1:4205');
  for (const value of ['https://localhost:4200', 'http://example.com', 'http://user@localhost:4200', 'http://localhost:4200/?secret=1', 'http://localhost:4200/#/main', 'http://localhost:4200/another-build'])
    assert.throws(() => rendererOverride(value), /loopback HTTP root/);
});
test('owned child shutdown refuses a parent, mismatched identity, open view and remaining writer', async t => {
  const f = fixture(t), env = await f.controller.ensure(f.source, f.request);
  const child = readRepairBootstrap(f.launch().options.env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  const params = identityParams(env);
  let closed = 0;
  const ports = { currentProject: () => '', admit: async () => ({ ok: true }), close: () => { closed++; } };
  assert.equal((await shutdownRepairEnvironment(null, params, ports)).ok, false);
  assert.equal((await shutdownRepairEnvironment(child, { ...params, requestId: 'not-the-request' }, ports)).ok, false);
  assert.equal((await shutdownRepairEnvironment(child, params, { ...ports, currentProject: () => f.target })).code, 'PROJECT_REPAIR_VIEW_ACTIVE');
  assert.equal((await shutdownRepairEnvironment(child, params, { ...ports, admit: async () => ({ ok: false }) })).code, 'PROJECT_REPAIR_VIEW_BUSY');
  assert.equal(closed, 0);
  assert.equal((await shutdownRepairEnvironment(child, params, ports)).ok, true); assert.equal(closed, 1);
});
test('fork preparation cannot race initial source verification by starting a child or changing ABI', async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.target, 'project.abi'));
  const prepared = await f.prepare.ensure(f.source, f.request);
  assert.equal(prepared.state, 'starting'); assert.equal(prepared.hostPid, undefined); assert.equal(f.spawned(), 0);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'project.abi')), before);
  const inspection = await f.continuation.inspect({ version: 1, project: f.target });
  assert.equal(inspection.ok, true); assert.equal(inspection.childState, 'never-started'); assert.equal(inspection.repairEnvironment.epoch, 0);
});
test('explicit first resume pins the current target independently of historical fork bytes', async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request);
  const changed = '{"legitimateTargetEdit":true}'; fs.writeFileSync(path.join(f.target, 'project.abi'), changed);
  const started = await f.continuation.resume(f.resume);
  assert.equal(started.code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING'); assert.equal(started.repairEnvironment.epoch, 1);
  const child = readRepairBootstrap(f.launch().options.env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  assert.equal(child.admission().targetAbiHash, hash(changed)); child.complete({ project: f.target, ready: true });
  assert.equal(fs.readFileSync(path.join(f.source, 'project.abi'), 'utf8'), f.abi);
});
function liveOptions(f, child, extra = {}) {
  return { ...f.opts, queryChild: async (record, _directory, operation) => {
    const response = child.identity(identityParams({ ...record, parentHostPid: record.parentHostPid }));
    return response.ok ? { ...response.repairEnvironment, ...(operation === 'project_repair_adoptable' ? { ownerStatus: { idle: true } } : {}) } : null;
  }, ...extra };
}
test('missing Chat route after legitimate apply resumes the authenticated lineage with the current ABI hash', async t => {
  const f = fixture(t); await f.controller.ensure();
  const child = readRepairBootstrap(f.launch().options.env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  child.complete({ project: f.target, ready: true });
  fs.writeFileSync(path.join(f.target, 'project.abi'), '{"afterApply":true}');
  const controller = createRepairContinuationController(liveOptions(f, child));
  const inspected = await controller.inspect({ version: 1, project: f.target });
  assert.equal(inspected.ok, true); assert.equal(inspected.recoveryContinuation.currentAbiHash, hash('{"afterApply":true}'));
  const resumed = await controller.resume({ ...f.resume, resumeRequestId: 'missing-route-resume' });
  assert.equal(resumed.ok, true); assert.equal(resumed.repairEnvironment.epoch, 1);
  assert.equal(resumed.recoveryContinuation.originalForkSourceAbiHash, hash(f.abi)); assert.equal(f.spawned(), 1);
});
test('parent adoption requires previous owner exit, actual child idle and a new monotonic epoch', async t => {
  const f = fixture(t); await f.controller.ensure();
  const child = readRepairBootstrap(f.launch().options.env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  child.complete({ project: f.target, ready: true });
  const old = (await f.continuation.inspect({ version: 1, project: f.target })).repairEnvironment;
  const denied = createRepairContinuationController(liveOptions(f, child, { pid: 101 }));
  assert.equal((await denied.resume({ ...f.resume, resumeRequestId: 'still-live-owner' })).code, 'PROJECT_REPAIR_OWNER_STILL_ACTIVE');
  const controller = createRepairContinuationController(liveOptions(f, child, { pid: 101, processState: pid => pid !== 100 }));
  const observation = await controller.inspect({ version: 1, project: f.target });
  assert.equal(observation.recoveryContinuation.sourceView, 'unavailable'); assert.equal(observation.recoveryContinuation.ownerHostPid, 100);
  const resumed = await controller.resume({ ...f.resume, resumeRequestId: 'parent-adoption-resume' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed)); assert.equal(resumed.repairEnvironment.parentHostPid, 101);
  assert.equal(resumed.repairEnvironment.epoch, 2); assert.equal(resumed.repairEnvironment.sourceView, 'unavailable');
  assert.equal(child.identity(identityParams(old)).ok, false); assert.equal(child.identity(identityParams(resumed.repairEnvironment)).ok, true);
  assert.equal(f.spawned(), 1);
});
test('a normally exited child can resume one new epoch without altering old records or source bytes', async t => {
  const f = fixture(t); await f.controller.ensure(); const oldLaunch = f.launch().options.env.AILY_REPAIR_BOOTSTRAP;
  const oldBytes = fs.readFileSync(oldLaunch), sourceBefore = fs.readFileSync(path.join(f.source, 'project.abi'));
  let count = 0;
  const controller = createRepairContinuationController({ ...f.opts, processState: pid => pid !== 200,
    spawnChild: () => { count++; return { pid: 201, once() {}, unref() {} }; } });
  const result = await controller.resume({ ...f.resume, resumeRequestId: 'exited-child-resume' });
  assert.equal(result.code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING'); assert.equal(result.repairEnvironment.hostPid, 201);
  assert.equal(result.repairEnvironment.epoch, 2); assert.equal(count, 1);
  await controller.resume({ ...f.resume, resumeRequestId: 'exited-child-resume' }); assert.equal(count, 1);
  assert.deepEqual(fs.readFileSync(oldLaunch), oldBytes); assert.deepEqual(fs.readFileSync(path.join(f.source, 'project.abi')), sourceBefore);
});
test('abandoned or active writer records are reported exactly and are never removed to restart a child', async t => {
  const f = fixture(t); await f.controller.ensure();
  const file = path.join(f.target, '.aily', 'project-files.write.lock'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify({ pid: 200, token: 'keep-the-real-owner' }); fs.writeFileSync(file, bytes);
  const controller = createRepairContinuationController({ ...f.opts, processState: pid => pid !== 200 });
  const result = await controller.resume({ ...f.resume, resumeRequestId: 'blocked-writer-resume' });
  assert.equal(result.code, 'PROJECT_REPAIR_TARGET_BUSY'); assert.equal(result.details.resource, 'project-files.write.lock');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(f.spawned(), 1);
});
test('unknown process-spawn completion preserves the original pending request and never starts a second epoch', async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request); let attempted = 0;
  const controller = createRepairContinuationController({ ...f.opts, spawnChild: () => { attempted++; throw new Error('lost spawn acknowledgement'); } });
  assert.equal((await controller.resume(f.resume)).ok, false);
  const observed = await controller.inspect({ version: 1, project: f.target });
  assert.equal(observed.pendingResume.resumeRequestId, f.resume.resumeRequestId);
  await controller.resume({ ...f.resume, resumeRequestId: 'different-unknown-request' }); assert.equal(attempted, 1);
});
test('live-child parent adoption refuses a busy runtime without changing its owner epoch', async t => {
  const f = fixture(t); const env = await f.controller.ensure();
  const child = readRepairBootstrap(f.launch().options.env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  child.complete({ project: f.target, ready: true });
  const base = liveOptions(f, child, { pid: 101, processState: pid => pid !== 100 });
  const controller = createRepairContinuationController({ ...base, queryChild: async (record, root, operation) => {
    const value = await base.queryChild(record, root, operation);
    return operation === 'project_repair_adoptable' ? { ...value, ownerStatus: { idle: false } } : value;
  } });
  const result = await controller.resume({ ...f.resume, resumeRequestId: 'busy-child-adoption' });
  assert.equal(result.code, 'PROJECT_REPAIR_TARGET_BUSY'); assert.equal(result.details.resource, 'repair-child-runtime');
  assert.equal(child.identity(identityParams(env)).ok, true); assert.equal(f.spawned(), 1);
});
test('repair view lock recheck never forces another owner or permits opening the protected source', async t => {
  const f = fixture(t), record = { project: f.target };
  assert.equal(checkRepairProjectOpen(record, f.source, 200).code, 'PROJECT_REPAIR_TARGET_MISMATCH');
  const lock = path.join(f.target, '.aily', 'project-open.lock'); fs.mkdirSync(path.dirname(lock), { recursive: true });
  const bytes = JSON.stringify({ pid: 300, execPath: '/another-owned-app' }); fs.writeFileSync(lock, bytes);
  assert.equal(checkRepairProjectOpen(record, f.target, 200).code, 'PROJECT_REPAIR_TARGET_BUSY');
  assert.equal(fs.readFileSync(lock, 'utf8'), bytes);
});
for (const previousOwner of [true, 'unknown']) test(`an exited child cannot transfer an ${previousOwner === true ? 'alive' : 'unconfirmed'} parent's lineage to a new caller`, async t => {
  const f = fixture(t); await f.controller.ensure();
  const original = await f.continuation.inspect({ version: 1, project: f.target }); let spawned = 0;
  const controller = createRepairContinuationController({ ...f.opts, pid: 101,
    processState: pid => pid === 100 ? previousOwner : pid === 200 ? false : true,
    spawnChild: () => { spawned++; throw new Error('must not spawn'); } });
  const denied = await controller.resume({ ...f.resume, resumeRequestId: 'exited-child-new-owner' });
  assert.equal(denied.code, 'PROJECT_REPAIR_OWNER_STILL_ACTIVE'); assert.equal(denied.details.owner.pid, 100); assert.equal(spawned, 0);
  const after = await f.continuation.inspect({ version: 1, project: f.target });
  assert.equal(after.repairEnvironment.epoch, original.repairEnvironment.epoch);
  assert.equal(after.repairEnvironment.parentHostPid, original.repairEnvironment.parentHostPid);
});
test('a prepared lineage cannot be claimed by another caller while its original owner is alive', async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request); let spawned = 0;
  const controller = createRepairContinuationController({ ...f.opts, pid: 101,
    spawnChild: () => { spawned++; throw new Error('must not spawn'); } });
  assert.equal((await controller.resume(f.resume)).code, 'PROJECT_REPAIR_OWNER_STILL_ACTIVE'); assert.equal(spawned, 0);
});
for (const relative of ['electron/project-repair-environment.js', 'electron/project-repair-lineage.js', 'electron/project-repair-normalization.js',
  'electron/project-recovery-receipts.js', 'electron/project-repair-handoff.js', 'electron/project-repair-primary.js',
  'electron/project-file-access.js', 'electron/project-lock.js', 'child/scripts/native-file-lock.js',
  'child/scripts/build-workspace-lease.js', 'child/scripts/system-boot-id.js']) test(`a helper-only change to ${relative} changes code identity and rejects old lineage`, async t => {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request);
  const before = codeIdentity(process.execPath, f.appPath); fs.appendFileSync(path.join(f.appPath, relative), '\nchanged boundary');
  assert.notEqual(codeIdentity(process.execPath, f.appPath), before);
  const controller = createRepairContinuationController(f.opts);
  const result = await controller.inspect({ version: 1, project: f.target });
  assert.equal(result.code, 'PROJECT_REPAIR_BUILD_CHANGED'); assert.equal(f.spawned(), 0);
});
for (const direction of ['target-inside-source', 'source-inside-target']) test(`physical fork isolation rejects an ancestor junction: ${direction}`, async t => {
  const f = fixture(t), actualParent = direction === 'target-inside-source' ? f.source : f.target;
  const nested = path.join(actualParent, 'nested-project'); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'project.abi'), f.abi);
  const alias = path.join(f.root, 'ancestor-alias'); fs.symlinkSync(actualParent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const source = direction === 'target-inside-source' ? f.source : path.join(alias, 'nested-project');
  const target = direction === 'target-inside-source' ? path.join(alias, 'nested-project') : f.target;
  const archive = path.join(target, 'physical-source-proof.json');
  fs.writeFileSync(archive, JSON.stringify({ version: 1, sourceProject: source, files: { 'project.abi': f.abi }, partialCanvas: { captured: false } }));
  const store = createProjectRecoveryReceipts(f.appData), request = 'physical-containment-proof';
  store.begin(source, request, '[]', hash(f.abi)); store.complete(source, request, '[]', {
    projectSaved: true, activated: false, project: target, sourceProject: source, recoveryArchive: archive,
    activationBlocked: { reason: 'partial-canvas-unavailable' }, recoverySource: { kind: 'saved-document', complete: true, partialCanvas: 'unavailable' },
  }, hash(f.abi));
  const before = fs.readFileSync(path.join(source, 'project.abi'));
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.throws(() => verifyFork(f.appData, source, request), /independent physical directory/);
  assert.deepEqual(fs.readFileSync(path.join(source, 'project.abi')), before);
});
test('parent and child exit with the exact known view record still resumes one new ready epoch without source writes', async t => {
  const f = fixture(t); await f.controller.ensure();
  const lock = path.join(f.target, '.aily', 'project-open.lock'), old = { pid: 200, execPath: process.execPath, appVersion: 'fixture-version', startedAt: Date.now() };
  fs.writeFileSync(lock, JSON.stringify(old)); const sourceBytes = fs.readFileSync(path.join(f.source, 'project.abi'));
  let launch, spawned = 0;
  const opts = { ...f.opts, pid: 101, processState: pid => pid === 100 || pid === 200 ? false : true,
    spawnChild: (exe, args, options) => { spawned++; launch = options; return { pid: 201, once() {}, unref() {} }; } };
  const controller = createRepairContinuationController(opts), request = { ...f.resume, resumeRequestId: 'known-exited-view-resume' };
  const pending = await controller.resume(request);
  assert.equal(pending.repairEnvironment.epoch, 2); assert.equal(pending.repairEnvironment.hostPid, 201); assert.equal(spawned, 1);
  assert.equal(fs.existsSync(lock), false);
  const record = JSON.parse(fs.readFileSync(launch.env.AILY_REPAIR_BOOTSTRAP));
  const archived = JSON.parse(fs.readFileSync(record.projectViewRecovery.archive));
  assert.equal(archived.snapshot.contents, JSON.stringify(old)); assert.equal(archived.snapshot.owner.pid, 200);
  const child = readRepairBootstrap(launch.env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 201 });
  assert.equal(checkRepairProjectOpen(child.record, f.target, 201), null);
  child.complete({ project: f.target, ready: true });
  const observing = createRepairContinuationController({ ...opts, queryChild: async rec => child.identity(identityParams(rec)).repairEnvironment });
  const ready = await observing.resume(request);
  assert.equal(ready.ok, true); assert.equal(ready.repairEnvironment.state, 'ready'); assert.equal(ready.repairEnvironment.sourceView, 'unavailable');
  assert.equal(spawned, 1); assert.deepEqual(fs.readFileSync(path.join(f.source, 'project.abi')), sourceBytes);
});
for (const reason of ['wrong-pid', 'alive', 'unknown', 'changed-lock']) test(`view recovery refuses ${reason}, preserving the actual record and not launching`, async t => {
  const f = fixture(t); await f.controller.ensure();
  const lock = path.join(f.target, '.aily', 'project-open.lock'), old = { pid: reason === 'wrong-pid' ? 300 : 200,
    execPath: process.execPath, appVersion: 'fixture-version', startedAt: Date.now() };
  fs.writeFileSync(lock, JSON.stringify(old)); let spawned = 0;
  const changed = { ...old, pid: 301 };
  const projectViewLocks = reason === 'changed-lock' ? { ...f.opts.projectViewLocks,
    recoverExitedViewLock: (...args) => { fs.writeFileSync(lock, JSON.stringify(changed)); return f.opts.projectViewLocks.recoverExitedViewLock(...args); } } : f.opts.projectViewLocks;
  const opts = { ...f.opts, pid: 101, projectViewLocks, processState: pid => pid === 100 ? false
    : pid === 200 ? reason === 'alive' ? true : reason === 'unknown' ? 'unknown' : false : false,
    spawnChild: () => { spawned++; throw new Error('must not launch'); } };
  const result = await createRepairContinuationController(opts).resume({ ...f.resume, resumeRequestId: `view-refusal-${reason}` });
  assert.equal(result.ok, false); assert.equal(spawned, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), JSON.stringify(reason === 'changed-lock' ? changed : old));
  if (reason === 'wrong-pid' || reason === 'changed-lock') {
    assert.equal(result.nextAction, undefined); assert.equal(result.observeAction.tool, 'project_recover');
    assert.equal(result.recoverability.doNotRetryBlindly, true);
  }
});
