const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { transformSync, buildSync } = require('esbuild');
const { webcrypto } = require('node:crypto');
const { LibraryDependencies, runDependencyWorker } = require('../../electron/library-dependencies');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');
const { openProjectSyncStorageBridge } = require('../../electron/project-sync-storage');

async function sameRootRecovery(f) {
  const module = { exports: {} };
  const context = vm.createContext({ module, window: { fs, crypto: webcrypto, platform: { isWindows: process.platform === 'win32' } },
    TextEncoder, Uint8Array });
  vm.runInContext(buildSync({ entryPoints: ['src/app/services/domains/project/project-recovery-targets.ts'],
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0].text, context);
  const targets = new context.module.exports.ProjectRecoveryTargets();
  const archive = path.join(f.root, '.aily/same-root-saved-primary.json');
  fs.writeFileSync(archive, JSON.stringify({ project: f.root, primary: fs.readFileSync(path.join(f.root, 'project.abi'), 'utf8') }));
  // This is the real saved-target capability used by recoverFailedBlocklyProject
  // for path===sourceProject, not a claim that this Node test drove GUI recovery.
  await targets.remember({ projectSaved: true, project: f.root, sourceProject: f.root,
    recoverySource: { kind: 'saved-document', complete: true }, recoveryArchive: archive }, () => {});
  assert.equal(targets.has(f.root), true);
  assert.equal((await targets.inspect(f.root, () => {})).sourceProject, f.root);
  return targets;
}

function component(f) {
  const source = fs.readFileSync('src/app/editors/blockly-editor/blockly-editor.component.ts', 'utf8');
  const parsed = ts.createSourceFile('component.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'BlocklyEditorComponent');
  const names = ['installMissingBlocklyLibraries', 'restoreMissingProjectLibraries', 'getNpmInstallSpec'];
  const methods = names.map(name => declaration.members.find(node => node.name?.getText(parsed) === name).getText(parsed));
  const context = vm.createContext({ module: { exports: {} }, require, console, crypto: webcrypto, AbortController, DOMException,
    TextEncoder, TextDecoder, Uint8Array,
    window: { crypto: webcrypto, fs: { ...fs, openProjectSyncStorage: openProjectSyncStorageBridge },
      libraryDependencies: f.port, ipcRenderer: { invoke: (_channel, body) => {
        f.calls.push({ operation: body.operation, request: body.request });
        return f.sessions.run(body.operation, body.projectPath, body.request);
      } } },
    ProjectToolboxOnlyLoadError: class extends Error {}, PasteInstallDialogComponent: class {},
  });
  vm.runInContext(buildSync({ entryPoints: ['src/app/services/domains/project/project-managed-library-environment.ts'],
    alias: { '@shared/public-api': path.resolve('src/app/services/shared/development-resource-routing.ts') },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0].text, context);
  Object.assign(context, context.module.exports); context.module = { exports: {} };
  const helper = 'src/app/editors/blockly-editor/services/missing-project-libraries.ts';
  if (fs.existsSync(helper)) {
    vm.runInContext(transformSync(fs.readFileSync(helper, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, context);
    Object.assign(context, context.module.exports); context.module = { exports: {} };
  }
  vm.runInContext(transformSync(`class Subject { ${methods.join('\n')} }; module.exports=Subject;`,
    { loader: 'ts', format: 'cjs', target: 'es2022' }).code, context);
  const controller = new AbortController(), session = { projectPath: f.root, signal: controller.signal };
  const current = () => { if (session.signal.aborted) throw session.signal.reason; };
  const subject = Object.assign(new context.module.exports(), {
    projectService: { currentPackageData: {}, assertProjectDependencySession: current,
      hasSavedRecoveryTarget: () => false, runProjectDependencyTask: (_session, work) => work() },
    configService: { getNpmRegistryForProject: () => undefined, withProjectNpmRegistry: value => value },
    electronService: { exists: fs.existsSync, pathJoin: path.join, readFile: file => fs.readFileSync(file, 'utf8') },
    blocklyService: { loadLibrary: async () => current() },
    cmdService: { runAsyncChecked: () => { throw Error('RAW_NPM_BEFORE_MANAGED_CHECKPOINT'); } },
    crossPlatformCmdService: { removeItem: () => { throw Error('RAW_COPY_BEFORE_MANAGED_CHECKPOINT'); },
      copyItem: () => { throw Error('RAW_COPY_BEFORE_MANAGED_CHECKPOINT'); } },
    modal: { create: () => { throw Error('AUTOMATIC_RECOVERY_MUST_NOT_WAIT_FOR_A_HUMAN'); } },
  });
  return { subject, session, controller, managedInstall: (installs) => context.installMissingLibrariesManaged({
    project: f.root, installs, host: f.port, signal: session.signal, assertCurrent: current,
    options: { offline: true, installLinks: false },
    cancel: requestId => context.window.ipcRenderer.invoke('library-dependencies', {
      operation: 'cancelEnvironment', projectPath: f.root, request: { requestId } }),
    verify: (requestId, packages) => context.readManagedLibraryEnvironment(f.root,
      { requestId, originalTargetPid: process.pid }, { packages, removedPackages: [] }, current),
  }) };
}

function fixture(t, run) {
  const parent = path.resolve('tests/test-results/r2-missing-library-managed'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-')), root = path.join(directory, 'project'), external = path.join(directory, 'external');
  fs.mkdirSync(root); fs.mkdirSync(external);
  t.after(() => { assert.ok(directory.startsWith(parent + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const name = '@aily-project/lib-r2-missing';
  fs.writeFileSync(path.join(external, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  fs.writeFileSync(path.join(external, 'definition.json'), '{"preserved":"external original"}');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"missing-library-project","dependencies":{}}\n');
  fs.mkdirSync(path.join(root, '.aily/abs-sync'), { recursive: true });
  for (const file of ['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json'])
    fs.writeFileSync(path.join(root, file), 'unmodified program ' + file);
  // Opaque program bytes are not a native-publisher fixture or authority; this
  // environment path must never parse, replace or apply any of these four files.
  const programs = ['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json']
    .map(file => [file, fs.readFileSync(path.join(root, file))]);
  const checkpoints = [], calls = [];
  const manager = new LibraryDependencies({ run: async (project, request, hooks) => {
    const owned = manager.environment.owned.get(project);
    assert.ok(owned && fs.existsSync(path.join(owned.folder, 'checkpoint.json')), 'The actual checkpoint must precede the first npm mutation');
    checkpoints.push(owned.record.requestId);
    return run ? run({ project, request, hooks, manager }) : runDependencyWorker(project,
      { ...request, options: { ...request.options, offline: true } }, hooks);
  } });
  const sessions = new LibraryDependencySessions(manager);
  const port = {
    capabilities: async () => sessions.capabilities(),
    mutate: async (project, request) => { calls.push({ operation: 'mutate', request }); return sessions.run('mutate', project, request); },
    observeEnvironment: (project, request) => { calls.push({ operation: 'observe', request }); return sessions.run('observeEnvironment', project, request); },
  };
  return { root, external, directory, name, manager, sessions, port, checkpoints, calls, programs };
}

test('actual missing-library component installs local bytes only through the original Main checkpoint and preserves Program', { timeout: 60000 }, async t => {
  const f = fixture(t), c = component(f);
  const target = await sameRootRecovery(f);
  c.subject.projectService.hasSavedRecoveryTarget = value => target.has(value);
  assert.equal(await c.subject.restoreMissingProjectLibraries(f.root,
    [{ name: f.name, version: '1.0.0', localPath: f.external }], c.session), true);
  assert.ok(f.checkpoints.length > 0);
  assert.equal(f.calls.filter(value => value.operation === 'mutate').length, 1);
  const request = f.calls.find(value => value.operation === 'mutate').request;
  assert.match(request.requestId, /^env1-[a-f0-9-]{36}$/i);
  const result = await f.sessions.run('observeEnvironment', f.root, { requestId: request.requestId });
  assert.equal(result.environment.status, 'completed'); assert.equal(result.environment.current, true);
  const canonical = path.join(f.root, 'local-libraries', ...f.name.split('/'));
  assert.equal(fs.readFileSync(path.join(canonical, 'definition.json'), 'utf8'), '{"preserved":"external original"}');
  assert.equal(fs.realpathSync(path.join(f.root, 'node_modules', ...f.name.split('/'))), fs.realpathSync(canonical));
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});

test('old Main capability refuses missing-library mutation without raw fallback or a checkpoint', async t => {
  const f = fixture(t), c = component(f);
  f.port.capabilities = async () => ({ dependencyEnvironmentVersion: 1 });
  await assert.rejects(c.subject.installMissingBlocklyLibraries(f.root,
    [{ name: f.name, localPath: f.external }], c.session), { code: 'LIBRARY_ENVIRONMENT_UNAVAILABLE' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.checkpoints, []);
});

test('abort reaches actual Main before mutate admission and the same env1 can never install afterwards', async t => {
  const f = fixture(t), c = component(f), original = f.port.mutate;
  f.port.mutate = async (...args) => {
    c.controller.abort(new DOMException('Original project load stopped', 'AbortError'));
    await new Promise(setImmediate);
    return original(...args);
  };
  await assert.rejects(c.subject.installMissingBlocklyLibraries(f.root,
    [{ name: f.name, localPath: f.external }], c.session), { name: 'AbortError' });
  const cancelled = f.calls.find(value => value.operation === 'cancelEnvironment');
  const mutation = f.calls.find(value => value.operation === 'mutate');
  assert.ok(cancelled && mutation); assert.equal(cancelled.request.requestId, mutation.request.requestId);
  assert.ok(f.calls.indexOf(cancelled) < f.calls.indexOf(mutation));
  assert.deepEqual(f.checkpoints, []); assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false);
  assert.equal(f.manager.environment.find(f.root, mutation.request.requestId), null);
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});

test('same-root saved recovery continues the existing load automatically and never requests a human reload', async t => {
  const f = fixture(t), c = component(f), restored = [];
  const target = await sameRootRecovery(f);
  c.subject.projectService.hasSavedRecoveryTarget = value => target.has(value);
  c.subject.installMissingBlocklyLibraries = async (project, libraries, session) => {
    assert.equal(project, f.root); assert.equal(session, c.session); restored.push(libraries);
  };
  const libs = [{ name: f.name, version: '1.0.0', localPath: f.external }];
  assert.equal(await c.subject.restoreMissingProjectLibraries(f.root, libs, c.session), true);
  assert.deepEqual(restored, [libs]);
  c.controller.abort(new DOMException('Stopped', 'AbortError'));
  await assert.rejects(c.subject.restoreMissingProjectLibraries(f.root, libs, c.session), { name: 'AbortError' });
  assert.equal(restored.length, 1, 'A stopped load must not reopen the dialog or restart installation');
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});

test('same-root recovery retains the original program when an external local source is actually missing', async t => {
  const f = fixture(t), c = component(f);
  c.subject.projectService.hasSavedRecoveryTarget = () => true;
  await assert.rejects(c.subject.restoreMissingProjectLibraries(f.root,
    [{ name: f.name, localPath: path.join(f.directory, 'absent-source') }], c.session), { code: 'PROJECT_RECOVERY_LIBRARY_SOURCE_MISSING' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.checkpoints, []);
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});

test('automatic same-root recovery cannot guess latest from absent, file-only or malformed saved specs', async t => {
  const f = fixture(t), c = component(f), attempts = [];
  c.subject.projectService.hasSavedRecoveryTarget = () => true;
  c.subject.installMissingBlocklyLibraries = async (...args) => { attempts.push(args); };
  for (const version of ['', 'file:', 'file:../missing-source', '???', '1.0.0";unexpected']) {
    await assert.rejects(c.subject.restoreMissingProjectLibraries(f.root,
      [{ name: f.name, version, localPath: '' }], c.session), { code: 'PROJECT_RECOVERY_LIBRARY_SPEC_MISSING' });
  }
  assert.deepEqual(attempts, []); assert.deepEqual(f.calls, []); assert.deepEqual(f.checkpoints, []);
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});

test('automatic recovery retains an explicit saved semver range or tag instead of falling back to an unversioned install', async t => {
  const f = fixture(t), c = component(f), attempts = [];
  c.subject.projectService.hasSavedRecoveryTarget = () => true;
  c.subject.installMissingBlocklyLibraries = async (_project, libraries, _session, savedSpecs) => {
    assert.equal(savedSpecs, true); attempts.push(libraries[0].version);
  };
  for (const version of ['1.0.0', '^1.2.3', '>=1.0.0 <2.0.0', 'previous-stable'])
    assert.equal(await c.subject.restoreMissingProjectLibraries(f.root,
      [{ name: f.name, version, localPath: '' }], c.session), true);
  assert.deepEqual(attempts, ['1.0.0', '^1.2.3', '>=1.0.0 <2.0.0', 'previous-stable']);
  assert.deepEqual(f.calls, []);
});

test('real offline npm install specs use the same Main admission and retain every Program byte', { timeout: 60000 }, async t => {
  const f = fixture(t), c = component(f);
  await c.managedInstall([{ packages: [`${f.name}@file:${f.external}`] }]);
  assert.ok(f.checkpoints.length); assert.equal(f.calls.filter(value => value.operation === 'mutate').length, 1);
  const requestId = f.calls.find(value => value.operation === 'mutate').request.requestId;
  const result = await f.manager.observeEnvironment(f.root, { requestId });
  assert.equal(result.environment.status, 'completed'); assert.equal(result.environment.current, true);
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});

test('real worker Stop settles only the original env1, exits the worker and restores pre-install project bytes', { timeout: 60000 }, async t => {
  let reached, release, workerPid;
  const paused = new Promise(resolve => { reached = resolve; });
  const f = fixture(t, ({ project, request, hooks }) => runDependencyWorker(project,
    { ...request, options: { ...request.options, offline: true } }, { ...hooks,
      beforeReify: async (...args) => {
        await hooks.beforeReify(...args); workerPid = args[1].storagePid;
        reached(); await new Promise(resolve => { release = resolve; });
      } }));
  const c = component(f), before = fs.readFileSync(path.join(f.root, 'package.json'));
  const task = c.subject.installMissingBlocklyLibraries(f.root,
    [{ name: f.name, localPath: f.external }], c.session);
  void task.catch(() => {});
  await paused;
  try {
    c.controller.abort(new DOMException('Actual original load Stop', 'AbortError'));
    await assert.rejects(task, { name: 'AbortError' });
  } finally { release?.(); }
  assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0);
  assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
  const requestId = f.calls.find(value => value.operation === 'mutate').request.requestId;
  assert.equal(f.calls.find(value => value.operation === 'cancelEnvironment').request.requestId, requestId);
  assert.equal((await f.manager.observeEnvironment(f.root, { requestId })).environment.status, 'restored');
  assert.ok(fs.readFileSync(path.join(f.root, 'package.json')).equals(before));
  assert.equal(fs.existsSync(path.join(f.root, 'local-libraries', ...f.name.split('/'))), false);
  assert.equal(fs.readFileSync(path.join(f.external, 'definition.json'), 'utf8'), '{"preserved":"external original"}');
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});

test('an existing canonical library conflicts without force and no npm or Program write is permitted', async t => {
  const f = fixture(t), c = component(f), canonical = path.join(f.root, 'local-libraries', ...f.name.split('/'));
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'package.json'), JSON.stringify({ name: f.name, version: '0.9.0' }));
  fs.writeFileSync(path.join(canonical, 'definition.json'), 'old canonical');
  await assert.rejects(c.subject.installMissingBlocklyLibraries(f.root,
    [{ name: f.name, localPath: f.external }], c.session));
  assert.deepEqual(f.checkpoints, []);
  assert.equal(fs.readFileSync(path.join(canonical, 'definition.json'), 'utf8'), 'old canonical');
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});

test('the actual canonical source itself is never copied over or renamed during recovery', { timeout: 60000 }, async t => {
  const f = fixture(t), c = component(f), canonical = path.join(f.root, 'local-libraries', ...f.name.split('/'));
  fs.mkdirSync(path.dirname(canonical), { recursive: true }); fs.renameSync(f.external, canonical);
  const identity = fs.statSync(canonical, { bigint: true });
  await c.subject.installMissingBlocklyLibraries(f.root, [{ name: f.name, localPath: canonical }], c.session);
  assert.equal(fs.statSync(canonical, { bigint: true }).ino, identity.ino);
  assert.equal(fs.realpathSync(path.join(f.root, 'node_modules', ...f.name.split('/'))), fs.realpathSync(canonical));
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});

test('unconfirmed cancellation retains its exact original ID and cannot report restoration or completion', async t => {
  const f = fixture(t), c = component(f);
  f.port.mutate = async (_project, request) => {
    f.calls.push({ operation: 'mutate', request });
    c.controller.abort(new DOMException('Stop before acknowledgement', 'AbortError'));
  };
  const actual = f.sessions.run.bind(f.sessions);
  f.sessions.run = (operation, ...args) => operation === 'cancelEnvironment'
    ? Promise.reject(new Error('Original controller transport unavailable')) : actual(operation, ...args);
  await assert.rejects(c.subject.installMissingBlocklyLibraries(f.root,
    [{ name: f.name, localPath: f.external }], c.session), error => {
    assert.equal(error.code, 'LIBRARY_ENVIRONMENT_CANCELLATION_UNCONFIRMED');
    assert.equal(error.requestId, f.calls.find(value => value.operation === 'mutate').request.requestId);
    return true;
  });
  assert.equal(f.calls.filter(value => value.operation === 'mutate').length, 1);
  assert.equal(f.calls.some(value => value.operation === 'observe'), false);
  assert.deepEqual(f.checkpoints, []);
});

test('lost managed ACK observes only its original env1 and changed-payload replay is rejected without a second npm', { timeout: 60000 }, async t => {
  const f = fixture(t), c = component(f), original = f.port.mutate;
  f.port.mutate = async (...args) => {
    await original(...args);
    throw Error('Controlled lost original IPC acknowledgement after real Main completion');
  };
  await c.subject.installMissingBlocklyLibraries(f.root, [{ name: f.name, localPath: f.external }], c.session);
  const mutations = f.calls.filter(value => value.operation === 'mutate');
  assert.equal(mutations.length, 1);
  const request = mutations[0].request, runs = f.checkpoints.length;
  assert.ok(runs > 0);
  assert.ok(f.calls.filter(value => value.operation === 'observe').every(value => value.request.requestId === request.requestId));
  assert.equal((await f.sessions.run('mutate', f.root, request)).environment.status, 'completed');
  await assert.rejects(f.sessions.run('mutate', f.root, { ...request, packages: ['@aily-project/lib-foreign'] }), /Original environment arguments changed/);
  assert.equal(f.checkpoints.length, runs);
  for (const [file, bytes] of f.programs) assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
});
