const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { buildSync, transformSync } = require('esbuild');
const { webcrypto } = require('node:crypto');
const { LibraryDependencies, runDependencyWorker } = require('../../electron/library-dependencies');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');
const { openProjectSyncStorageBridge } = require('../../electron/project-sync-storage');

const helperSource = buildSync({ entryPoints: ['src/app/services/domains/project/project-managed-library-environment.ts'],
  alias: { '@shared/public-api': path.resolve('src/app/services/shared/development-resource-routing.ts') },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0].text;
const domainSource = fs.readFileSync('src/app/services/domains/project/project.service.ts', 'utf8');
const parsed = ts.createSourceFile('project.service.ts', domainSource, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProjectService');
const domainMethods = ['finishLibraryMutation', 'abortLibraryMutation'].map(name => {
  const method = declaration.members.find(node => node.name?.getText(parsed) === name); assert.ok(method); return method.getText(parsed);
}).join('\n');
const domainCode = transformSync(`class Domain { ${domainMethods} }; module.exports = Domain`, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
function loadHost(f, override = value => value) {
  const calls = [], native = { crypto: webcrypto, path, fs: { ...fs, openProjectSyncStorage: openProjectSyncStorageBridge }, libraryDependencies: {
    observeEnvironment: async (root, request) => { calls.push('observeEnvironment'); return override(await f.manager.observeEnvironment(root, request)); },
    status: async root => { calls.push('status'); return f.sessions.run('status', root); },
    historyCommit: (root, request) => { calls.push('historyCommit'); return f.manager.historyCommit(root, request); },
    historyDiscard: (root, request) => { calls.push('historyDiscard'); return f.manager.historyDiscard(root, request); },
    discard: () => { throw Error('Managed runtime refresh must never discard/reconcile'); },
    prepare: () => { throw Error('Managed runtime refresh must never prepare/reify sources twice'); },
  } };
  const module = { exports: {} }, context = vm.createContext({ module, console, window: native, TextEncoder, TextDecoder, Uint8Array,
    setTimeout, clearTimeout });
  vm.runInContext(helperSource, context); const helper = module.exports;
  context.readManagedLibraryEnvironment = helper.readManagedLibraryEnvironment;
  context.module = { exports: {} }; vm.runInContext(domainCode, context);
  return { Domain: context.module.exports, helper, calls, native };
}

const sourceMirrors = root => ['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json']
  .map(name => { try { return fs.readFileSync(path.join(root, name)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } });
async function completedFixture(t) {
  const f = fixture(t), history = await f.manager.historyBegin(f.root, { packages: [f.name] });
  await f.sessions.run('mutate', f.root, f.request);
  f.historyToken = history.token; f.reference = { requestId: f.request.requestId, originalTargetPid: process.pid };
  f.scope = { packages: [f.name], removedPackages: [] };
  return f;
}

function domainFixture(f, host, runtimeError) {
  const liveDocument = { pages: [{ id: 'main', content: { blocks: [{ id: 'C', fields: { VALUE: 201 } }] } }], activePageId: 'main' };
  const pendingA = { source: 'tracked private A(101)', generation: 'G0' }, releases = [], records = [];
  const mutation = { projectPath: f.root, token: f.historyToken, before: structuredClone(liveDocument), ...f.scope,
    edit: { release: () => releases.push('edit'), record: callback => records.push(callback) }, lease: { release: () => releases.push('lease') } };
  const domain = Object.assign(new host.Domain(), { libraryMutation: mutation, currentProjectPath: f.root,
    captureCurrentProjectGuard: () => () => true, libraryChangesChanged: { next: () => {} },
    acceptLibraryStatus: (_root, value) => { assert.equal(value.dirty, false); },
    ensureBlocklyLibraryRuntimeReady: async () => { if (runtimeError) throw runtimeError; },
    application: { captureBlocklyLibraryDocument: async () => structuredClone(liveDocument) } });
  return { domain, liveDocument, pendingA, releases, records };
}

function fixture(t) {
  const parent = path.resolve('tests/test-results/r2-managed-runtime'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'owned-'));
  t.after(() => { assert.ok(root.startsWith(parent + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const name = '@aily-project/lib-r2-runtime', canonical = path.join(root, 'local-libraries', ...name.split('/'));
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  fs.writeFileSync(path.join(canonical, 'retained.txt'), 'original local definition');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"managed-runtime","dependencies":{}}\n');
  const manager = new LibraryDependencies({ run: (project, request, hooks) => runDependencyWorker(project,
    { ...request, options: { ...request.options, offline: true } }, hooks) });
  return { root, name, canonical, manager, sessions: new LibraryDependencySessions(manager),
    request: { requestId: 'env1-runtime-completed', action: 'install', packages: [`${name}@file:./local-libraries/${name}`], options: { offline: true, installLinks: false } } };
}

test('a new successful unchanged-manifest reconcile completes without detaching the existing internal library junction', async t => {
  const f = fixture(t);
  await f.sessions.run('mutate', f.root, f.request);
  const installed = path.join(f.root, 'node_modules', ...f.name.split('/'));
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), true);
  const manifest = fs.readFileSync(path.join(f.root, 'package.json'));
  const original = f.manager.environment.observe(f.root, f.request.requestId);
  assert.equal(original.status, 'completed'); assert.equal(original.current, true);
  assert.deepEqual(original.mutation, { action: 'install', packages: [f.name] });
  await f.manager.discard(f.root, { reconcile: true, historyRestored: true });
  assert.equal(f.manager.environment.describe(f.root).status, 'completed', 'A newly owned successful reconciliation is not a discarded pending edit');
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), true, 'Reconcile must not replace a healthy internal link with retained detached bytes');
  assert.equal(fs.realpathSync(installed), fs.realpathSync(f.canonical));
  assert.ok(fs.readFileSync(path.join(f.root, 'package.json')).equals(manifest));
  assert.equal(f.manager.environment.observe(f.root, f.request.requestId).status, 'completed');
});

test('verified original managed completion refreshes runtime/history with no second npm, source publication or link detachment', async t => {
  const f = await completedFixture(t), host = loadHost(f), view = domainFixture(f, host);
  const before = sourceMirrors(f.root), packageBytes = fs.readFileSync(path.join(f.root, 'package.json'));
  const runs = []; f.manager.run = () => { runs.push(true); throw Error('Unexpected second npm'); };
  await view.domain.finishLibraryMutation(f.historyToken, false, f.reference);
  assert.deepEqual(host.calls, ['observeEnvironment', 'status', 'observeEnvironment', 'historyCommit']); assert.deepEqual(runs, []);
  assert.deepEqual(sourceMirrors(f.root), before); assert.ok(fs.readFileSync(path.join(f.root, 'package.json')).equals(packageBytes));
  assert.equal(fs.lstatSync(path.join(f.root, 'node_modules', ...f.name.split('/'))).isSymbolicLink(), true);
  assert.deepEqual(view.liveDocument.pages[0].content.blocks[0].fields, { VALUE: 201 }); assert.equal(view.pendingA.source, 'tracked private A(101)');
  assert.equal(view.domain.libraryMutation, undefined); assert.deepEqual(view.releases, ['edit', 'lease']);
  assert.equal(view.records.length, 1); assert.equal(f.manager.environment.observe(f.root, f.request.requestId).status, 'completed');
});

test('Stop before managed refresh or a real runtime failure only releases front ownership and cannot roll back completed npm', async t => {
  const f = await completedFixture(t), before = sourceMirrors(f.root), packageBytes = fs.readFileSync(path.join(f.root, 'package.json'));
  f.manager.run = () => { throw Error('Stop/runtime failure cannot run npm'); };
  const stopHost = loadHost(f), stopped = domainFixture(f, stopHost);
  await stopped.domain.abortLibraryMutation(f.historyToken);
  assert.deepEqual(stopHost.calls, ['historyDiscard']); assert.equal(stopped.domain.libraryMutation, undefined);
  const next = await f.manager.historyBegin(f.root, { packages: [f.name] }); f.historyToken = next.token;
  const failedHost = loadHost(f), failed = domainFixture(f, failedHost, Error('actual runtime load failed'));
  await assert.rejects(failed.domain.finishLibraryMutation(f.historyToken, false, f.reference), /actual runtime load failed/);
  assert.deepEqual(failedHost.calls, ['observeEnvironment', 'status', 'historyDiscard']);
  assert.equal(failed.domain.libraryMutation, undefined); assert.deepEqual(failed.releases, ['edit', 'lease']);
  assert.ok(fs.readFileSync(path.join(f.root, 'package.json')).equals(packageBytes)); assert.deepEqual(sourceMirrors(f.root), before);
  assert.equal(f.manager.environment.observe(f.root, f.request.requestId).status, 'completed');
  assert.equal(fs.realpathSync(path.join(f.root, 'node_modules', ...f.name.split('/'))), fs.realpathSync(f.canonical));
  const nextAction = await f.manager.historyBegin(f.root, { packages: [f.name] }); await f.manager.historyDiscard(f.root, nextAction);
});

test('managed runtime refresh rejects foreign, stale or wrongly scoped completion and always releases its front token without writes', async t => {
  const f = await completedFixture(t), original = (await f.manager.observeEnvironment(f.root, { requestId: f.request.requestId })).environment;
  const invalid = [
    value => { value.environment.requestId = 'env1-other'; },
    value => { value.environment.current = false; }, value => { value.environment.status = 'restored'; },
    value => { value.environment.executor.hostPid++; }, value => { value.environment.attachment.identity.ino = '999'; },
    value => { value.environment.mutation.action = 'remove'; }, value => { value.environment.mutation.packages = ['@aily-project/lib-other']; },
    value => { value.environment.hashes.package = 'sha256:' + '0'.repeat(64); }, value => { delete value.environment.hashes.yarn; },
  ];
  const before = fs.readFileSync(path.join(f.root, 'package.json'));
  for (const change of invalid) {
    const next = await f.manager.historyBegin(f.root, { packages: [f.name] }); f.historyToken = next.token;
    const host = loadHost(f, value => { change(value); return value; }), view = domainFixture(f, host);
    await assert.rejects(view.domain.finishLibraryMutation(f.historyToken, false, f.reference), { code: 'LIBRARY_ENVIRONMENT_RUNTIME_UNVERIFIED' });
    assert.equal(view.domain.libraryMutation, undefined); assert.deepEqual(view.releases, ['edit', 'lease']);
    assert.deepEqual(host.calls, ['observeEnvironment', 'historyDiscard']);
  }
  assert.equal(original.current, true); assert.ok(fs.readFileSync(path.join(f.root, 'package.json')).equals(before));
  const host = loadHost(f);
  for (const input of [undefined, {}, true, { ...f.reference, body: {} }, { ...f.reference, originalTargetPid: 0 }]) {
    assert.throws(() => host.helper.readManagedLibraryEnvironmentReference(input), { code: 'LIBRARY_ENVIRONMENT_RUNTIME_UNVERIFIED' });
  }
});

test('project-bound bridge reads absent environment inputs as null without depending on stripped Error.code', async t => {
  const f = await completedFixture(t), host = loadHost(f), reads = [], rawReads = [];
  assert.equal(fs.existsSync(path.join(f.root, '.npmrc')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'npm-shrinkwrap.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'yarn.lock')), false);
  const open = host.native.fs.openProjectSyncStorage;
  host.native.fs.openProjectSyncStorage = async (...args) => {
    const capability = await open(...args);
    return { ...capability, read: async key => { reads.push(key); return capability.read(key); } };
  };
  host.native.fs.readFileSync = (file, ...args) => {
    rawReads.push(file);
    if (path.basename(file) === '.npmrc') throw new Error('ENOENT: no such file or directory .npmrc');
    return fs.readFileSync(file, ...args);
  };
  const environment = await host.helper.readManagedLibraryEnvironment(f.root, f.reference, f.scope, () => {});
  assert.equal(environment.status, 'completed'); assert.equal(environment.current, true);
  assert.deepEqual(reads, ['package.json', 'package-lock.json', '.npmrc', 'npm-shrinkwrap.json', 'yarn.lock']);
  assert.deepEqual(rawReads, [], 'Nullable environment input reads must stay inside the bound native capability');
  let valid = true;
  host.native.fs.openProjectSyncStorage = async (...args) => {
    const capability = await open(...args);
    return { ...capability, read: async key => { const value = await capability.read(key); valid = false; return value; } };
  };
  await assert.rejects(host.helper.readManagedLibraryEnvironment(f.root, f.reference, f.scope,
    () => { if (!valid) throw Error('project guard changed during awaited input read'); }), /project guard changed/);
});

test('a stopped runtime refresh cannot clear a newer front mutation after its original await resumes', async t => {
  const f = await completedFixture(t), host = loadHost(f), view = domainFixture(f, host);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  view.domain.ensureBlocklyLibraryRuntimeReady = async () => { enter(); await held; };
  const finishing = view.domain.finishLibraryMutation(f.historyToken, false, f.reference);
  const settled = assert.rejects(finishing, /no longer owns the original project mutation/);
  await entered;
  await view.domain.abortLibraryMutation(f.historyToken);
  const next = await f.manager.historyBegin(f.root, { packages: [f.name] }); f.historyToken = next.token;
  const newer = domainFixture(f, host).domain.libraryMutation;
  view.domain.libraryMutation = newer;
  release(); await settled;
  assert.equal(view.domain.libraryMutation, newer, 'Late cleanup owns only its captured front mutation');
  assert.equal(f.manager.environment.observe(f.root, f.request.requestId).status, 'completed');
  await view.domain.abortLibraryMutation(next.token);
});

test('discarding a real prior uncommitted npm edit still restores it rather than granting successful completion', async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.root, 'package.json'));
  await f.manager.mutate(f.root, f.request);
  assert.equal(f.manager.status(f.root).dirty, true);
  await f.manager.discard(f.root, { reconcile: true });
  assert.equal(f.manager.status(f.root).dirty, false);
  assert.equal(f.manager.environment.observe(f.root, f.request.requestId).status, 'restored');
  assert.ok(fs.readFileSync(path.join(f.root, 'package.json')).equals(before));
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules', ...f.name.split('/'))), false);
});

test('a preexisting local-authoring discard is not reclassified as a newly successful reconcile', async t => {
  const f = fixture(t), local = path.join(f.root, 'sketch/libraries/PrivateLocal');
  fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(path.join(local, 'user.cpp'), '// retained original source');
  f.manager.locals.trash = target => fs.promises.rm(target, { recursive: true });
  await f.manager.locals.remove(f.root, 'PrivateLocal');
  assert.equal(f.manager.locals.dirty(f.root), true); assert.equal(f.manager.environment.owned.size, 0);
  await f.manager.discard(f.root, { reconcile: true });
  assert.equal(f.manager.environment.describe(f.root).status, 'restored');
  assert.equal(fs.readFileSync(path.join(local, 'user.cpp'), 'utf8'), '// retained original source');
});
