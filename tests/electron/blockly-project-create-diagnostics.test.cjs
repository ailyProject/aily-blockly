'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { bridgeFixture, readPureModule, sourceClass } = require('./fixtures/bootstrap-host-source.cjs');
const { importProjectDirectory } = require('../../electron/project-file-copy');

const domain = 'src/app/services/domains/project';
const bridgeFile = 'src/app/services/integrations/automation/blockly-live-operation-bridge.service.ts';
const board = { name: '@aily-project/board-diagnostic', version: '1.2.3' };
const npmFailure = 'npm error code ECONNREFUSED\nnpm error original package source was unavailable';
const schemaFailure = 'Project Data normalization could not read the original required resource';
const validationFailure = 'The requested creation mode is no longer active';

// Actual production renderer dispatch, lifecycle admission, creation methods and
// native file copy. Only npm and the normalization backend are controlled ports;
// no application result, copied project, mode or receipt is manufactured.
function fixture(t, failure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-blockly-create-diagnostic-'));
  t.after(() => {
    const target = path.resolve(root);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(target).startsWith('aily-blockly-create-diagnostic-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const parent = path.join(root, 'projects'), boardPath = path.join(root, 'node_modules', board.name),
    template = path.join(boardPath, 'template'), name = 'diagnostic project', project = path.join(parent, 'diagnostic_project');
  fs.mkdirSync(parent); fs.mkdirSync(template, { recursive: true });
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
  write(path.join(boardPath, 'package.json'), board);
  write(path.join(boardPath, 'board.json'), { name: 'Diagnostic board' });
  write(path.join(template, 'package.json'), { dependencies: { [board.name]: board.version, '@aily-project/lib-retained': '4.5.6' } });
  write(path.join(template, 'project.abi'), { blocks: { languageVersion: 0, blocks: [] } });
  fs.writeFileSync(path.join(template, 'retained.txt'), 'original template material');
  const initialAbi = fs.readFileSync(path.join(template, 'project.abi')),
    calls = { installs: [], normalizations: [], opened: [] },
    fsApi = { ...fs, importProjectDirectory, readFileSync: file => fs.readFileSync(file, 'utf8'),
      lstatSync: file => { const stat = fs.lstatSync(file); return { _isDirectory: stat.isDirectory(), _isFile: stat.isFile() }; } },
    pathApi = { ...path, getAppDataPath: () => root },
    packageNames = { isAilyBoardPackageName: value => value === board.name,
      isAilyScopedPackageName: value => value.startsWith('@aily-project/') },
    f = bridgeFixture('', 7);
  f.window.path = pathApi; f.window.fs = fsApi;
  const Project = sourceClass(`${domain}/project.service.ts`, 'ProjectService', {
    window: f.window, ...packageNames,
    ...readPureModule(`${domain}/aily-cloud-ignore-file.ts`, { window: f.window }),
    AILY_NPM_SCOPE: '@aily-project', AILY_LINUX_NPM_SCOPE: '@aily-project-linux',
    ...readPureModule(`${domain}/blockly-project-template.ts`),
    ...readPureModule(`${domain}/coder/coder-project-template.ts`),
    ...readPureModule(`${domain}/project-package-name.ts`),
    normalizeProjectDataDocument: async input => {
      calls.normalizations.push(input.projectPath);
      if (failure === 'schema') throw Object.assign(new Error(schemaFailure), { code: 'PROJECT_DATA_RESOURCE_MISSING' });
      return {};
    },
  }, ['createDefaultNewProjectData', 'projectNew', 'projectNewWithResult', 'buildProjectPath', 'buildNpmPackageSpec',
    'buildNpmInstallCommand', 'normalizeAilyBoardPackageName', 'importProjectDirectory',
    'initializeProjectDataSchema', 'updateNewProjectPackageJson']);
  for (const name of Object.getOwnPropertyNames(Project.prototype)) {
    if (name !== 'constructor') f.domain[name] = Project.prototype[name];
  }
  const Names = sourceClass(bridgeFile, 'BlocklyLiveOperationBridgeService', packageNames, ['normalizeAilyBoardPackageName']);
  f.bridge.normalizeAilyBoardPackageName = Names.prototype.normalizeAilyBoardPackageName;
  f.bridge.executeProjectCreate = f.originalMethods.executeProjectCreate;
  f.bridge.configService.getPreferredChatAgentRuntimeMode = () => 'blockly';
  f.domain.configService = f.bridge.configService;
  f.domain.electronService = { isElectron: false };
  f.domain.application.updateFooterState = () => {};
  f.domain.assertProjectCreationMode = async mode => {
    assert.equal(mode, 'blockly');
    if (failure === 'validation') throw new Error(validationFailure);
  };
  f.domain.cmdService = { runAsync: async (command, cwd) => {
    calls.installs.push({ command, cwd }); return { type: 'close', code: 47, stderr: npmFailure };
  } };
  f.domain.createProjectDataStore = () => ({});
  f.domain.reportProjectDataNormalization = () => {};
  f.domain.message = { error() {} }; f.domain.metrics = { record() {} };
  f.domain.translate = { instant: key => key };
  f.domain.projectOpenInternal = async target => {
    calls.opened.push(target);
    if (failure === 'activation') return false;
    f.domain.currentProjectPath = target; return true;
  };
  const originalCreation = f.domain.projectNewWithResult.bind(f.domain);
  let internalResult;
  f.domain.projectNewWithResult = async (...args) => { internalResult = await originalCreation(...args); return internalResult; };
  const create = () => f.bridge.executeOperation({ operation: 'project_create', rendererGeneration: 7,
    lifecycle: { version: 1, sourceProject: null, rendererGeneration: 7 },
    params: { developmentMode: 'blockly', boardName: board.name, boardVersion: failure === 'npm' ? '9.9.9' : board.version,
      name, path: parent } });
  return { ...f, create, calls, parent, project, initialAbi, internal: () => internalResult };
}

test('public Blockly creation preserves the actual npm failure stage, exit code and raw error', async t => {
  const f = fixture(t, 'npm'), result = await f.create();
  assert.equal(result.ok, false);
  assert.equal(f.calls.installs.length, 1);
  assert.deepEqual(fs.readdirSync(f.parent), []);
  assert.equal(f.internal().stage, 'board-install');
  assert.equal(f.internal().npmExitCode, 47);
  assert.equal(f.internal().error, npmFailure);
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
  assert.deepEqual(f.calls.opened, []);
  assert.equal(result.stage, 'board-install', 'The public tool must not fold the proven stage into a boolean');
  assert.equal(result.npmExitCode, 47);
  assert.equal(result.error, npmFailure);
  assert.equal(result.project, null);
  assert.equal(result.partialMutation, undefined);
});

test('public Blockly creation identifies and preserves the partial original root after normalization fails', async t => {
  const f = fixture(t, 'schema'), result = await f.create();
  assert.equal(result.ok, false);
  assert.deepEqual(f.calls.installs, []);
  assert.deepEqual(f.calls.normalizations, [f.project]);
  assert.equal(f.internal().stage, 'project-files');
  assert.equal(f.internal().error, schemaFailure);
  assert.ok(fs.readFileSync(path.join(f.project, 'project.abi')).equals(f.initialAbi));
  assert.equal(fs.readFileSync(path.join(f.project, 'retained.txt'), 'utf8'), 'original template material');
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
  assert.deepEqual(f.calls.opened, []);
  assert.equal(result.project, f.project, 'The existing original root must remain discoverable to the tool caller');
  assert.equal(result.partialMutation, true);
  assert.equal(result.stage, 'project-files');
  assert.equal(result.error, schemaFailure);
});

test('an existing destination is preserved and never claimed as this request partial project', async t => {
  const f = fixture(t, 'existing');
  fs.mkdirSync(f.project); fs.writeFileSync(path.join(f.project, 'user.txt'), 'user original');
  const before = fs.statSync(f.project, { bigint: true }), result = await f.create();
  assert.equal(result.ok, false); assert.equal(result.stage, 'project-files');
  assert.match(result.error, /EEXIST/);
  assert.equal(result.project, null); assert.equal(result.partialMutation, undefined);
  assert.deepEqual(f.calls.installs, []); assert.deepEqual(f.calls.normalizations, []); assert.deepEqual(f.calls.opened, []);
  assert.deepEqual(fs.readdirSync(f.project), ['user.txt']);
  assert.equal(fs.readFileSync(path.join(f.project, 'user.txt'), 'utf8'), 'user original');
  assert.equal(fs.statSync(f.project, { bigint: true }).ino, before.ino);
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
});

test('validation failure before installation reports the original failure without a partial root', async t => {
  const f = fixture(t, 'validation'), result = await f.create();
  assert.equal(result.ok, false); assert.equal(result.stage, 'validation'); assert.equal(result.error, validationFailure);
  assert.equal(result.project, null); assert.equal(result.partialMutation, undefined); assert.equal(result.npmExitCode, undefined);
  assert.deepEqual(f.calls.installs, []); assert.deepEqual(f.calls.normalizations, []); assert.deepEqual(f.calls.opened, []);
  assert.deepEqual(fs.readdirSync(f.parent), []);
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
});

test('activation returning false reports the exact copied project as partial without recreating it', async t => {
  const f = fixture(t, 'activation'), result = await f.create();
  assert.equal(result.ok, false); assert.equal(result.stage, 'activation');
  assert.equal(result.project, f.project); assert.equal(result.createdProject, f.project);
  assert.equal(result.projectCreated, true); assert.equal(result.partialMutation, true);
  assert.equal(result.activation.completed, false); assert.equal(result.code, 'PROJECT_CREATE_ACTIVATION_FAILED');
  assert.deepEqual(f.calls.installs, []); assert.deepEqual(f.calls.normalizations, [f.project]);
  assert.deepEqual(f.calls.opened, [f.project]);
  assert.ok(fs.readFileSync(path.join(f.project, 'project.abi')).equals(f.initialAbi));
  assert.equal(fs.readFileSync(path.join(f.project, 'retained.txt'), 'utf8'), 'original template material');
  assert.deepEqual(fs.readdirSync(f.parent), ['diagnostic_project']);
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
});
