'use strict';

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const editorFile = 'src/app/editors/blockly-editor/services/builder.service.ts';
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true };

function readSource(relative) {
  const file = path.join(root, relative);
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function transpile(source) {
  return ts.transpileModule(source, { compilerOptions }).outputText;
}

function load(relative, imports = {}) {
  const exports = {};
  new Function('exports', 'require', transpile(readSource(relative).getFullText()))(exports, name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected fixture import ${name}`);
    return imports[name];
  });
  return exports;
}

function findClass(relative, name) {
  const source = readSource(relative);
  const declaration = source.statements.find(item => ts.isClassDeclaration(item) && item.name?.text === name);
  assert.ok(declaration, name);
  return { source, declaration };
}

function method({ source, declaration }, name) {
  const found = declaration.members.find(item => ts.isMethodDeclaration(item) && item.name.getText(source) === name);
  assert.ok(found, name);
  return found;
}

function methods(relative, className, names, bindings = {}) {
  const source = findClass(relative, className);
  const body = names.map(name => method(source, name).getText(source.source)).join('\n');
  return new Function(...Object.keys(bindings), transpile(`class Selected { ${body} }`) + '\nreturn Selected;')(...Object.values(bindings));
}

const applicationImports = { '@angular/core': { Injectable: () => value => value }, rxjs: require('rxjs') };
const { WorkflowService, ProcessState } = load('src/app/services/core/app-shell/workflow.service.ts', applicationImports);
const { ActionService } = load('src/app/services/core/app-shell/action.service.ts', applicationImports);
const cancellation = load('src/app/services/domains/build/build-cancellation.ts');
const { runProjectBuild } = load('src/app/integrations/blockly/project-build-operation.ts', { '@domain/build/public-api': cancellation });
const { ProjectBuildReceipts } = load('src/app/services/integrations/automation/project-build-receipts.ts');
const { resolveLinuxBoardProjectRoute } = load('src/app/services/shared/linux-board-project-route.ts');
const { createCloudBuildLocalRetry } = load('src/app/utils/cloud-build-local-retry.utils.ts');
const request = load('src/app/utils/build-request.utils.ts');

const editorSource = findClass(editorFile, '_BuilderService');
const editorInit = method(editorSource, 'init');
const editorListeners = ['compile-begin', 'compile-cancel', 'preprocess-trigger'].map(name => {
  const listener = editorInit.body.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(editorSource.source) === 'this.actionService.listen'
    && node.expression.arguments[0]?.text === name);
  assert.ok(listener, name);
  return listener.getText(editorSource.source);
});
const mountEditor = new Function(transpile(editorListeners.join('\n')));

const adapter = methods('src/app/integrations/build/blockly-build.adapter.ts', 'BlocklyBuildAdapter', ['isAvailable', 'build']);
const domain = methods('src/app/services/domains/build/builder.service.ts', 'BuilderService',
  ['build', 'buildCurrentBlocklyProject', 'persistActiveCoderProjectBeforeBuild', 'clearBuildCache', 'triggerPreprocess',
    'triggerPreprocessWithCacheClear'], {
    isBuildCancelled: cancellation.isBuildCancelled, persistBuildResult: () => {},
  });
const bridge = methods('src/app/services/integrations/automation/blockly-live-operation-bridge.service.ts',
  'BlocklyLiveOperationBridgeService', ['executeProjectBuild'], { runProjectBuild });

const caches = [
  '.build/compiler-cache.txt',
  '.temp/libraries/cache.txt',
  '.temp/library-cache.json',
  '.temp/preprocess.json',
];
const retained = [
  '.aily/build-executions/original/inputs.txt',
  '.log/compile/requests/original.log',
  'project.abs',
];

function fixture(t) {
  const temp = fs.realpathSync(os.tmpdir());
  const project = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'aily-build-cache-admission-')));
  const files = [...caches, ...retained];
  const ownedProjects = new Set();
  const seed = target => {
    ownedProjects.add(target);
    for (const relative of files) {
      const file = path.join(target, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, relative, { flag: 'wx' });
    }
  };
  seed(project);
  const board = '@aily-project/board-test';
  const boardRoot = path.join(project, 'node_modules', ...board.split('/'));
  fs.mkdirSync(boardRoot, { recursive: true });
  for (const file of [path.join(project, 'package.json'), path.join(boardRoot, 'package.json'), path.join(boardRoot, 'board.json')]) {
    fs.writeFileSync(file, '{}', { flag: 'wx' });
  }
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(project)), temp);
    assert.match(path.basename(project), /^aily-build-cache-admission-/);
    assert.equal(fs.lstatSync(project).isSymbolicLink(), false);
    fs.rmSync(project, { recursive: true, force: false });
  });

  const previousWindow = global.window;
  global.window = { fs: { existsSync: fs.existsSync, readFileSync: fs.readFileSync } };
  t.after(() => { global.window = previousWindow; });
  const actions = new ActionService();
  t.after(() => actions.unlistenAll());
  const workflow = new WorkflowService();
  const events = [];
  const faults = {};
  const context = {
    currentProjectPath: project,
    currentPackageData: {},
    isAilyCodeProject: () => false,
    beginCoderOperation: () => () => {},
    ensureBlocklyLibraryRuntimeReady: async () => {},
    captureCurrentProjectGuard() {
      const current = this.currentProjectPath;
      return () => current === this.currentProjectPath;
    },
    beginBuildBackendOperation: () => ({ release: () => {} }),
    getBuildPath: async () => '',
    getBoardModule: async () => board,
    getRuntimeBoardModule: () => board,
    getBoardJson: async () => ({ name: 'Test board' }),
    ensureCustomPartitionFile: async (_target, assertCurrent) => assertCurrent(),
  };
  const port = Object.assign(new adapter(), { project: context, actions });
  const builder = Object.assign(new domain(), {
    actionService: actions,
    projectService: context,
    blocklyBuild: port,
    electronService: { pathJoin: path.join },
    notifyBuildCompletion: () => {},
    buildFinishedSubject: { next: () => {} },
    crossPlatformCmdService: { removeItem: async (file, recursive) => {
      const allowed = ['.build', '.temp/libraries', '.temp/library-cache.json', '.temp/preprocess.json'];
      const labels = [...ownedProjects].map(target => path.relative(target, file).replaceAll('\\', '/'));
      const label = labels.find(candidate => allowed.includes(candidate));
      assert.ok(label, file);
      const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(fs.realpathSync(file), file);
      if (stat.isDirectory()) assert.ok(fs.readdirSync(file, { withFileTypes: true }).every(item => item.isFile()));
      await faults.beforeRemove?.(label);
      events.push({ kind: 'clear', label, state: workflow.currentState });
      fs.rmSync(file, { recursive, force: false });
    } },
  });
  const editor = methods(editorFile, '_BuilderService', ['build', 'buildAttemptWithBackend', 'cancel',
    'preparePreprocessCache', 'detachIsolatedPreprocess', 'clearOwnedBuildCache'], {
    crypto: webcrypto,
    ProcessState,
    resolveLinuxBoardProjectRoute,
    createCloudBuildLocalRetry,
    createProjectBuildLog: async (target, requestId) => {
      assert.equal(target, project);
      return { requestId, run: callback => callback() };
    },
    capturedBuildInput: () => undefined,
    buildCancelledResult: cancellation.buildCancelledResult,
    ...request,
  });
  const executor = Object.assign(new editor(), {
    actionService: actions,
    projectService: context,
    workflowService: workflow,
    builderService: builder,
    electronService: { pathJoin: path.join },
    configService: { getCompileBackend: () => 'local' },
    npmService: { ensureLocalCompilerDependencies: async () => {} },
    metrics: { record: () => {} },
    message: { warning: () => {} },
    blocklyService: { workspace: {}, dependencySubject: { next: () => {
      events.push({ kind: 'preprocess', state: workflow.currentState });
    } } },
    isCloudBuild: () => false,
    isPreprocessing: () => false,
    isolatedBuilds: () => true,
    compileSettingsKey: () => 'fixture-local',
    waitForAilyBuilderReady: async () => {},
    waitForPreprocessDrain: async () => {},
    clearProgressTimer: () => {},
    handleCompileError: () => {},
    updateCancelledNotice: () => {},
    ensureCancelState: () => {},
    saveBuildInfo: async (_target, state) => { events.push({ kind: state, state: workflow.currentState }); },
    t: name => name,
    build(...args) {
      events.push({ kind: 'admission', state: workflow.currentState, requestId: args[1] });
      return editor.prototype.build.apply(this, args);
    },
    async generateWorkspaceBuildSnapshotForPreprocess() {
      events.push({ kind: 'freeze', state: workflow.currentState, requestId: this.activeBuildRequestId });
      throw new Error('Fixture stopped at source freeze before compiler launch');
    },
  });
  mountEditor.call(executor);
  const handler = Object.assign(new bridge(), {
    projectService: context,
    builderService: builder,
    extractToolContent: value => value.content,
  });
  const receipts = new ProjectBuildReceipts();
  const start = (requestId, clearCache, preprocessOnly = false) => {
    const request = { version: 1, requestId, waitMs: 2000 };
    return receipts.start(project, request, JSON.stringify([preprocessOnly, clearCache]), () =>
      handler.executeProjectBuild({ clear_cache: clearCache, preprocess_only: preprocessOnly, buildLogRequestId: requestId }, project));
  };
  const assertIntact = (paths, target = project) => {
    for (const relative of paths) assert.equal(fs.readFileSync(path.join(target, relative), 'utf8'), relative);
  };
  const cancel = requestId => actions.dispatch('compile-cancel', { requestId });
  return { project, context, workflow, events, faults, seed, start, receipts, cancel, assertIntact };
}

test('a rejected concurrent Agent build never clears the active project cache or reruns its receipt', async t => {
  const f = fixture(t);
  assert.equal(f.workflow.startBuild(), true);
  for (const clearCache of [false, true]) {
    const requestId = `busy-cache-${clearCache}`;
    const outcome = await f.start(requestId, clearCache);
    assert.equal(outcome.buildReceipt.state, 'completed');
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.buildOutcome, 'not-started');
    f.assertIntact([...caches, ...retained]);
    assert.equal(f.workflow.currentState, ProcessState.BUILDING);
    const observed = await f.receipts.status(f.project, { version: 1, requestId });
    assert.deepEqual(observed.result, outcome.result);
    assert.deepEqual(await f.start(requestId, clearCache), outcome);
  }
  assert.deepEqual(f.events.map(event => event.kind), ['admission', 'admission']);
  f.workflow.finishBuild(true);
  assert.equal(f.workflow.currentState, ProcessState.IDLE);
});

test('the admitted Agent build clears its exact project once before source freeze', async t => {
  const f = fixture(t);
  const outcome = await f.start('owned-clear', true);
  assert.equal(outcome.buildReceipt.state, 'completed');
  assert.equal(outcome.result.ok, false);
  assert.match(outcome.result.result.text, /Fixture stopped at source freeze/);
  assert.deepEqual(f.events, [
    { kind: 'admission', state: ProcessState.IDLE, requestId: 'owned-clear' },
    ...['.build', '.temp/libraries', '.temp/library-cache.json', '.temp/preprocess.json']
      .map(label => ({ kind: 'clear', label, state: ProcessState.BUILDING })),
    { kind: 'freeze', state: ProcessState.BUILDING, requestId: 'owned-clear' },
  ]);
  assert.ok(caches.every(relative => !fs.existsSync(path.join(f.project, relative))));
  f.assertIntact(retained);
  assert.equal(f.workflow.currentState, ProcessState.ERROR);
  assert.deepEqual(await f.start('owned-clear', true), outcome);
  assert.equal(f.events.length, 6);
});

test('a project switch during readiness leaves both sets of caches intact', async t => {
  const f = fixture(t);
  const nextProject = path.join(f.project, 'next-project');
  f.seed(nextProject);
  f.context.ensureBlocklyLibraryRuntimeReady = async () => {
    f.context.currentProjectPath = nextProject;
  };
  const outcome = await f.start('stale-clear', true);
  assert.equal(outcome.buildReceipt.state, 'completed');
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.project, f.project);
  assert.equal(outcome.result.buildOutcome, 'not-started');
  f.assertIntact([...caches, ...retained]);
  f.assertIntact([...caches, ...retained], nextProject);
  assert.deepEqual(f.events, []);
  assert.equal(f.workflow.currentState, ProcessState.IDLE);
});

test('advisory preprocessing clears only after ownership and still triggers no foreground compiler', async t => {
  const f = fixture(t);
  assert.equal(f.workflow.startBuild(), true);
  const rejected = await f.start('busy-preprocess', true, true);
  assert.equal(rejected.buildReceipt.state, 'completed');
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.result.buildOutcome, 'not-started');
  f.assertIntact([...caches, ...retained]);
  assert.deepEqual(f.events, []);
  f.workflow.finishBuild(true);

  const unchanged = await f.start('plain-preprocess', false, true);
  assert.equal(unchanged.result.ok, true);
  assert.deepEqual(f.events, [{ kind: 'preprocess', state: ProcessState.IDLE }]);
  f.assertIntact([...caches, ...retained]);

  const admitted = await f.start('owned-preprocess', true, true);
  assert.equal(admitted.buildReceipt.state, 'completed');
  assert.equal(admitted.result.ok, true);
  assert.deepEqual(f.events.slice(1), [
    ...['.build', '.temp/libraries', '.temp/library-cache.json', '.temp/preprocess.json']
      .map(label => ({ kind: 'clear', label, state: ProcessState.BUILDING })),
    { kind: 'preprocess', state: ProcessState.IDLE },
  ]);
  assert.ok(caches.every(relative => !fs.existsSync(path.join(f.project, relative))));
  f.assertIntact(retained);
  assert.deepEqual(await f.start('owned-preprocess', true, true), admitted);
  assert.equal(f.events.length, 6);
});

test('cancelling during cache removal keeps ownership until the actual removal settles', async t => {
  const f = fixture(t);
  let removalEntered;
  let removalReleased;
  const entered = new Promise(resolve => { removalEntered = resolve; });
  const released = new Promise(resolve => { removalReleased = resolve; });
  f.faults.beforeRemove = async label => {
    if (label === '.build') {
      removalEntered();
      await released;
    }
  };
  const original = f.start('cancel-owned-clear', true);
  await entered;
  try {
    f.cancel('cancel-owned-clear');
    assert.equal(f.workflow.currentState, ProcessState.BUILDING);
    const competing = await f.start('during-old-removal', true);
    assert.equal(competing.result.buildOutcome, 'not-started');
    f.assertIntact([...caches, ...retained]);
    assert.equal((await f.receipts.status(f.project, { version: 1, requestId: 'cancel-owned-clear' })).buildReceipt.state, 'running');
  } finally {
    removalReleased();
    await original;
  }
  const settled = await original;
  assert.equal(settled.buildReceipt.state, 'completed');
  assert.equal(settled.result.buildOutcome, 'cancelled');
  assert.equal(f.events.some(event => event.kind === 'freeze'), false);
  assert.equal(f.events.filter(event => event.kind === 'clear').length, 4);
  assert.deepEqual(f.events.at(-1), { kind: 'cancelled', state: ProcessState.BUILDING });
  assert.equal(f.workflow.currentState, ProcessState.ERROR);
  assert.deepEqual(await f.start('cancel-owned-clear', true), settled);
});
