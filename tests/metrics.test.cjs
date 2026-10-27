const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(source, imports = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', source), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  }).outputText;
  const module = { exports: {} };
  const decorator = () => () => {};
  new Function('require', 'exports', 'module', compiled)(name => imports[name]
    ?? (name === '@angular/core' ? { Injectable: decorator, Inject: decorator, Optional: decorator } : {}), module.exports, module);
  return module.exports;
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cloudBuildLocalRetry = load('src/app/utils/cloud-build-local-retry.utils.ts');

async function fixture(action) {
  const original = { window: global.window, fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const requests = [], timers = new Map();
  let nextTimer = 0;
  const config = { data: {}, init: async () => {} };
  const auth = { getToken2: async () => null };
  const { MetricsService } = load('src/app/services/core/metrics/metrics.service.ts', {
    '../../../configs/api.config': { getServerUrl: () => 'https://metrics.example.test/' },
  });
  const create = () => new MetricsService(config, auth, { runOutsideAngular: callback => callback() });
  try {
    global.window = { electronAPI: { auth: { product: 'blockly' } } };
    global.fetch = async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return { json() { throw new Error('Responses are not consumed'); } };
    };
    global.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
    global.clearTimeout = id => timers.delete(id);
    await action({ create, config, auth, requests, timers });
  } finally { Object.assign(global, original); }
}

test('anonymous milestones send immediately with a window-only session and no response dependency', async () => {
  await fixture(async ({ create, requests, timers }) => {
    const metrics = create();
    for (const event of ['app_opened', 'project_created', 'upload_succeeded', 'compile_attempted', 'build_succeeded']) {
      assert.equal(metrics.record(event), undefined);
      await settle();
    }
    assert.equal(requests.length, 5);
    assert.equal(new Set(requests.map(request => request.body.session_id)).size, 1);
    assert.equal(requests[0].url, 'https://metrics.example.test/api/v1/metrics/me');
    assert.equal(requests[0].credentials, 'omit');
    assert.equal(requests[0].headers.Authorization, undefined);
    assert.equal(requests[2].body.event, 'upload_succeeded');
    assert(Number.isFinite(Date.parse(requests[2].body.occurred_at)));
    assert.equal(requests[2].body.product, 'blockly');
    assert.equal(requests[3].body.event, 'compile_attempted');
    assert.equal(requests[4].body.event, 'build_succeeded');
    create().record('app_opened'); await settle();
    assert.notEqual(requests[0].body.session_id, requests[5].body.session_id);
    assert.equal(timers.size, 0);
  });
});

test('existing tokens and the Coder host identity are sent without a login check or refresh', async () => {
  await fixture(async ({ create, auth, requests }) => {
    window.electronAPI.auth.product = 'coder';
    auth.getToken2 = async () => 'existing-token';
    create().record('project_created'); await settle();
    assert.equal(requests[0].headers.Authorization, 'Bearer existing-token');
    assert.equal(requests[0].body.product, 'coder');
    assert.deepEqual(Object.keys(requests[0].body).sort(), ['event', 'occurred_at', 'product', 'session_id']);
  });
});

test('disabled collection does not read credentials or send, including after asynchronous preparation', async () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '../electron/config/config.json'))).metricsEnabled, true);
  await fixture(async ({ create, config, auth, requests }) => {
    auth.getToken2 = () => { throw new Error('Must not read'); };
    config.data.metricsEnabled = false;
    const metrics = create(); metrics.record('app_opened'); await settle();
    assert.equal(requests.length, 0);
    const token = deferred();
    config.data.metricsEnabled = true; auth.getToken2 = () => token.promise;
    metrics.record('upload_succeeded'); await settle();
    config.data.metricsEnabled = false; token.resolve('token'); await settle();
    assert.equal(requests.length, 0);
  });
});

test('network and HTTP failures never escape or retry; a request aborts after three seconds', async () => {
  await fixture(async ({ create, requests, timers }) => {
    let attempts = 0;
    global.fetch = async () => { attempts++; throw new Error('offline'); };
    const metrics = create();
    assert.doesNotThrow(() => metrics.record('app_opened')); await settle();
    assert.equal(attempts, 1); assert.equal(timers.size, 0);
    global.fetch = async () => { attempts++; return new Response(null, { status: 503 }); };
    metrics.record('app_opened'); await settle();
    assert.equal(attempts, 2); assert.equal(timers.size, 0);
    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      requests.push(options);
      options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    metrics.record('upload_succeeded'); await settle();
    const timer = [...timers.values()][0]; assert.equal(timer.delay, 3000);
    timer.callback(); await settle();
    assert.equal(requests[0].signal.aborted, true); assert.equal(timers.size, 0);
  });
});

test('shared project creation records success and preserves existing failure returns', async () => {
  const records = [];
  const { ProjectService } = load('src/app/services/domains/project/project.service.ts');
  const service = Object.create(ProjectService.prototype);
  Object.defineProperty(service, 'application', { value: { updateFooterState() {} } });
  Object.defineProperty(service, 'message', { value: { error() {} } });
  Object.assign(service, { metrics: { record: node => records.push(node) },
    getProjectMode: () => 'blockly', assertProjectCreationMode: async () => {}, buildProjectPath: () => '/project',
    translate: { instant: key => key }, importProjectDirectory() {},
    initializeProjectDataSchema: async () => {}, updateNewProjectPackageJson() {} });
  service.finishProjectCreation = async () => true;
  assert.equal(await service.projectNewFromTemplate({}, '/template'), true);
  assert.deepEqual(records, ['project_created']);
  service.finishProjectCreation = async () => false;
  assert.equal(await service.projectNewFromTemplate({}, '/template'), false);
  service.initializeProjectDataSchema = async () => { throw new Error('bad template'); };
  assert.equal(await service.projectNewFromTemplate({}, '/template'), false);
  assert.equal(records.length, 1);
});

test('Python and Arduino report actual upload success before auxiliary cleanup, but not failure or cancellation', async () => {
  const records = [];
  const { UploaderService } = load('src/app/services/domains/device/uploader.service.ts', {
    './policies/upload-dispatch-policy': { resolveUploadDispatchMode: () => 'coder-direct' },
  });
  const service = Object.create(UploaderService.prototype);
  service.metrics = { record: node => records.push(node) };
  service.isPythonProject = () => true; service.currentLinuxBoardRoute = () => ({});
  service.uploadPythonProject = async () => ({ state: 'done' });
  assert.equal((await service.uploadCurrentProject()).state, 'done');
  service.uploadPythonProject = async () => { throw new Error('failed'); };
  await assert.rejects(service.uploadCurrentProject()); assert.equal(records.length, 1);
  service.isPythonProject = () => false;
  service.serialService = { currentPort: 'TEST-NO-DEVICE', currentPortInfo: { type: 'serial' } };
  service.createUploadOperationId = () => 'upload';
  service.sendSerialResourceUploadSignal = async signal => { if (signal.endsWith('connect') && !signal.endsWith('disconnect')) throw new Error('cleanup'); };
  service.projectService = { isAilyCodeProject: () => true };
  service.application = { hasActionListener: () => false, uploadFromBlocklyEditor: async () => ({ state: 'done' }) };
  service.electronService = { isWindowFocused: () => true }; service.resumeLifecycleFromPolicy = () => ({});
  await assert.rejects(service.uploadCurrentProject(), /cleanup/); assert.equal(records.length, 2);
  service.application.uploadFromBlocklyEditor = async () => ({ state: 'warn', text: 'Cancelled' });
  await assert.rejects(service.uploadCurrentProject(), /cleanup/); assert.equal(records.length, 2);
});

test('disk compilation reports an attempt before local or cloud failure, but not preprocessing or a busy rejection', async () => {
  const { CompileService } = load('src/app/services/domains/build/compile.service.ts', {
    '../../../utils/cloud-build-local-retry.utils': cloudBuildLocalRetry,
  });
  const records = [];
  const service = Object.create(CompileService.prototype);
  let backend = 'local', accepted = true;
  Object.assign(service, {
    metrics: { record: event => records.push(event) },
    projectService: { currentProjectPath: '/project', isCloudBuild: () => backend === 'cloud', captureCurrentProjectGuard: () => () => true,
      getProjectDependencyBlockMessage: () => undefined, beginBuildBackendOperation: () => ({ release() {} }) },
    configService: { getCompileBackend: () => backend, getCompileSettingsKey: () => backend,
      getCloudBuildSettings: () => ({}), isCoderProduct: () => false },
    npmService: { prepareCompileBackend: async () => {} },
    application: { startBuild: () => accepted, finishBuild() {}, updateNotice() {} },
    message: { warning() {} }, t: key => key, handleFailNotice() {},
    runCompile: async () => { throw new Error('compiler failed'); },
  });
  for (backend of ['local', 'cloud']) {
    assert.equal((await service.runCompileFromDisk()).success, false);
  }
  assert.deepEqual(records, ['compile_attempted', 'compile_attempted']);
  await service.runCompileFromDisk({ preprocessOnly: true });
  accepted = false;
  await service.runCompileFromDisk();
  assert.equal(records.length, 2);
});

test('Blockly compilation reports preparation failure as an attempt, while Python generation and busy actions do not', async () => {
  const { _BuilderService } = load('src/app/editors/blockly-editor/services/builder.service.ts', {
    '@shared/public-api': { resolveLinuxBoardProjectRoute: data => data.devmode === 'python' ? {} : null },
    '@core/app-shell/public-api': { ProcessState: { BUILDING: 'BUILDING' } },
    '../../../utils/cloud-build-local-retry.utils': cloudBuildLocalRetry,
  });
  const records = [], service = Object.create(_BuilderService.prototype);
  Object.assign(service, {
    metrics: { record: event => records.push(event) },
    configService: { getCompileBackend: () => 'local', getCompileSettingsKey: () => 'local' },
    projectService: { currentProjectPath: '/project', currentPackageData: {}, captureCurrentProjectGuard: () => () => true,
      beginBuildBackendOperation: () => ({ release() {} }) },
    workflowService: { startBuild: () => true, finishBuild() {} },
    clearProgressTimer() {}, handleCompileError() {}, t: key => key,
    generateAndWritePythonEntry: async () => ({ state: 'done' }),
    message: { warning() {} },
  });
  const previousWindow = global.window;
  try {
    global.window = { cloudBuild: { invalidate: async () => { throw new Error('build preparation failed'); } } };
    await assert.rejects(service.build(), error => error.text === 'build preparation failed');
    assert.deepEqual(records, ['compile_attempted']);
    service.projectService.currentPackageData = { devmode: 'python' };
    assert.equal((await service.build()).state, 'done');
    service.projectService.currentPackageData = {};
    service.workflowService.startBuild = () => false;
    await assert.rejects(service.build(), error => error.state === 'warn');
    assert.equal(records.length, 1);
  } finally { global.window = previousWindow; }
});
