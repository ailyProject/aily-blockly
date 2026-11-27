'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readPureModule, sourceClass } = require('./fixtures/bootstrap-host-source.cjs');
const { copyCoderTemplateDirectory, importProjectDirectory } = require('../../electron/project-file-copy');
const { rootAttachment } = require('../../electron/project-file-lock-owner');

const domain = 'src/app/services/domains/project';
const templates = readPureModule(`${domain}/coder/coder-project-template.ts`);
const boardResolution = readPureModule(`${domain}/coder/coder-board-resolution.ts`);
const { executeCoderProjectCreateOperation } = readPureModule(`${domain}/coder/coder-project-create-operation.ts`, {
  require: (module) => module === './coder-board-resolution' ? boardResolution : require(module),
});
const packageName = '@aily-project/board-esp32';
const packageVersion = '3.3.10';
const cachedBoard = { name: packageName, version: packageVersion, nickname: 'ESP32' };
const npmError = 'npm error code ECONNREFUSED\nnpm error fetch failed';

function creationFixture(t, templateDirectory = templates.CODER_TEMPLATE_DIRECTORY) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-coder-create-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const boardPath = path.join(root, 'node_modules', packageName);
  const template = path.join(boardPath, templateDirectory);
  fs.mkdirSync(projects);
  fs.mkdirSync(template, { recursive: true });
  const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
  writeJson(path.join(boardPath, 'package.json'), cachedBoard);
  writeJson(path.join(boardPath, 'board.json'), { name: 'ESP32' });
  writeJson(path.join(template, 'package.json'), { dependencies: {} });
  fs.writeFileSync(path.join(template, 'project.aci'), '// Board sketch');

  const pathApi = { ...path, getAppDataPath: () => root, isExists: fs.existsSync };
  const fsApi = {
    captureProjectAttachment: directory => rootAttachment(fs.realpathSync.native(directory)),
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readFileSync: (file) => fs.readFileSync(file, 'utf8'),
    writeFileSync: fs.writeFileSync,
    copySync: fs.copyFileSync,
    copyCoderTemplateDirectory,
    importProjectDirectory,
    lstatSync: (file) => {
      const stat = fs.lstatSync(file);
      return { _isDirectory: stat.isDirectory(), _isFile: stat.isFile() };
    },
    readDirSync: (directory) => fs.readdirSync(directory, { withFileTypes: true })
      .map(entry => ({ _isFile: entry.isFile(), name: entry.name })),
  };
  const window = { fs: fsApi, path: pathApi };
  const Project = sourceClass(`${domain}/project.service.ts`, 'ProjectService', {
    ...templates,
    window,
    ...readPureModule(`${domain}/aily-cloud-ignore-file.ts`, { window }),
    ...readPureModule(`${domain}/project-recovery-request.ts`, { require: () => ({}) }),
    ...readPureModule(`${domain}/coder/arduino-sketch.ts`, { window }),
    ...readPureModule(`${domain}/project-mode.ts`),
    isAilyBoardPackageName: (name) => name === packageName,
    isAilyScopedPackageName: (name) => name.startsWith('@aily-project/'),
    ...readPureModule(`${domain}/project-package-name.ts`),
  }, ['projectNew', 'projectNewWithResult', 'buildProjectPath', 'buildNpmPackageSpec',
    'normalizeAilyBoardPackageName', 'updateNewProjectPackageJson', 'normalizeAilyCodeBoardDepRange',
    'projectNewFromTemplate', 'importProjectDirectory', 'getProjectMode', 'projectOpenInternal',
    'backfillProjectCloudIgnore', 'projectDirectoryMatches']);
  const service = new Project();
  const calls = { commands: [], opened: [] };
  service.assertProjectCreationMode = async () => {};
  service.configService = { getNpmRegistryForProject: () => undefined };
  service.buildNpmInstallCommand = async (spec) => spec;
  service.cmdService = {
    runAsync: async (command) => {
      calls.commands.push(command);
      return { type: 'close', code: 1, stderr: npmError };
    },
  };
  service.application = { updateFooterState() {} };
  service.metrics = { record() {} };
  service.message = { error() {} };
  service.translate = { instant: (key) => key };
  const options = { deferActivation: true, templateDirectory: templates.CODER_TEMPLATE_DIRECTORY };
  const create = (name, boardVersion = packageVersion) => executeCoderProjectCreateOperation({
    boardName: packageName, name, boardVersion,
  }, {
    normalizeBoardName: (name) => name,
    getBoards: () => [cachedBoard],
    defaultParentPath: () => projects,
    createProject: (data) => service.projectNewWithResult(data, options),
    openProject: async (project) => { calls.opened.push(project); return true; },
    recordBoardUsage() {},
  });
  return { create, service, calls, projects, boardPath, template, options, writeJson, window };
}

for (const directory of [templates.CODER_TEMPLATE_DIRECTORY, templates.LEGACY_CODER_TEMPLATE_DIRECTORY, 'template']) {
  test(`first and second Coder creation reuse the exact cached ${directory}`, async (t) => {
    const f = creationFixture(t, directory);
    for (const name of ['first ESP32', 'second ESP32']) {
      const result = await f.create(name);
      assert.equal(result.ok, true, result.message);
      const sketch = fs.readFileSync(path.join(result.project, 'sketch', 'src', 'main.cpp'), 'utf8');
      assert.equal(sketch, directory === 'template' ? templates.DEFAULT_CODER_ARDUINO_SOURCE : '// Board sketch');
      const manifest = JSON.parse(fs.readFileSync(path.join(result.project, 'package.json'), 'utf8'));
      assert.equal(manifest.type, 'coder');
      assert.equal(manifest.dependencies[packageName], `^${packageVersion}`);
      assert.equal(fs.statSync(path.join(result.project, 'project.aci')).size, 0);
      assert.equal(fs.readFileSync(path.join(result.project, '.ailyignore'), 'utf8'), 'build/\n');
    }
    assert.equal(f.calls.opened.length, 2);
    assert.deepEqual(f.calls.commands, []);
  });
}

for (const [name, prepare] of [
  ['another version', () => '3.3.11'],
  ['version range', () => '^3.3.10'],
  ['another package name', (f) => f.writeJson(path.join(f.boardPath, 'package.json'), { ...cachedBoard, name: '@aily-project/board-other' })],
  ['broken board config', (f) => fs.writeFileSync(path.join(f.boardPath, 'board.json'), '{')],
  ['broken template manifest', (f) => f.writeJson(path.join(f.template, 'package.json'), [])],
]) {
  test(`${name} uses npm and preserves its failed stage and stderr in the Coder receipt`, async (t) => {
    const f = creationFixture(t);
    const version = prepare(f) || packageVersion;
    const result = await f.create('ESP32', version);
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'board-install');
    assert.equal(result.npmExitCode, 1);
    assert.equal(result.error, npmError);
    assert.deepEqual(f.calls.commands, [`${packageName}@${version}`]);
    assert.deepEqual(f.calls.opened, []);
    assert.deepEqual(fs.readdirSync(f.projects), []);
  });
}

test('generates a default sketch and a launch file when the cached board has no source', async (t) => {
  const f = creationFixture(t);
  fs.unlinkSync(path.join(f.template, 'project.aci'));
  const result = await f.create('ESP32');
  assert.equal(result.ok, true, result.message);
  assert.equal(fs.readFileSync(path.join(result.project, 'sketch', 'src', 'main.cpp'), 'utf8'), templates.DEFAULT_CODER_ARDUINO_SOURCE);
  assert.equal(fs.statSync(path.join(result.project, 'project.aci')).size, 0);
  assert.deepEqual(f.calls.commands, []);
});

test('Coder template creation prepares launch and cloud ignore files before activation and preserves template contents', async (t) => {
  const f = creationFixture(t);
  const template = path.join(f.boardPath, 'example');
  fs.mkdirSync(template);
  f.writeJson(path.join(template, 'package.json'), { name: 'example', type: 'coder' });
  f.service.electronService = { isElectron: true };
  f.service.initializeProjectDataSchema = async () => {};
  let expected = Buffer.alloc(0);
  let expectedIgnore;
  f.service.finishProjectCreation = async (project) => {
    assert.deepEqual(fs.readFileSync(path.join(project, 'project.aci')), expected);
    const cloudIgnore = fs.readFileSync(path.join(project, '.ailyignore'), 'utf8');
    if (expectedIgnore === undefined) assert.equal(cloudIgnore, 'build/\n');
    else assert.equal(cloudIgnore, expectedIgnore);
    return true;
  };
  assert.equal(await f.service.projectNewFromTemplate({ name: 'fresh', path: f.projects }, template), true);
  assert.equal(fs.existsSync(path.join(template, 'project.aci')), false);
  assert.equal(fs.existsSync(path.join(template, '.ailyignore')), false);
  expected = Buffer.from([0xff, 0, 1]);
  expectedIgnore = '# template rules\r\n/custom/\r\n*.tmp\r\n';
  fs.writeFileSync(path.join(template, 'project.aci'), expected);
  fs.writeFileSync(path.join(template, '.ailyignore'), expectedIgnore);
  assert.equal(await f.service.projectNewFromTemplate({ name: 'existing', path: f.projects }, template), true);
  assert.deepEqual(fs.readFileSync(path.join(template, 'project.aci')), expected);
  assert.equal(fs.readFileSync(path.join(template, '.ailyignore'), 'utf8'), expectedIgnore);
});

for (const native of [false, true]) {
  test(`opening an existing ${native ? 'native Arduino sketch' : 'Coder project'} backfills the launch file under the project lock`, async (t) => {
    const f = creationFixture(t);
    const root = path.join(f.projects, 'existing');
    const projectFile = path.join(root, 'project.aci');
    fs.mkdirSync(root);
    if (native) fs.writeFileSync(path.join(root, 'existing.ino'), 'void setup() {}');
    else f.writeJson(path.join(root, 'package.json'), { name: 'existing', type: 'coder' });
    f.window.projectLock = { tryAcquire: async (project, options) => {
      assert.equal(project, root);
      assert.equal(fs.existsSync(projectFile), options?.provisional !== true);
      return { ok: true, attachment: f.window.fs.captureProjectAttachment(project) };
    } };
    Object.assign(f.service, {
      currentProjectPath: '',
      coderProjects: [],
      isSameProjectPath: (a, b) => a === b,
      ensureProjectModeAllowed: async (project) => f.service.getProjectMode(project) === 'coder',
      electronService: { isElectron: true, exists: fs.existsSync, setTitle() {} },
      configService: { getApplicationName: () => 'Coder' },
      registerCoderProject: () => assert.equal(fs.statSync(projectFile).size, 0),
      restoreCoderWorkspaceTabs: async () => {},
      dependencyLifecycle: { beginPreparation: () => undefined },
      rememberDependencyBackend: (session) => session,
      getCoderProjectContext: () => ({ currentPackageData: { name: 'existing' }, syncCurrentBoardConfig: async () => {} }),
      publishCoderProjectContext() {},
      projectActivationSubject: { next() {} },
      router: { createUrlTree() {}, isActive: () => true },
    });
    assert.equal(await f.service.projectOpenInternal(root), true);
    const ignorePath = path.join(root, '.ailyignore');
    assert.equal(fs.readFileSync(ignorePath, 'utf8'), 'build/\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).type, 'coder');
    if (native) assert.equal(fs.readFileSync(path.join(root, 'existing.ino'), 'utf8'), 'void setup() {}');

    // A user may clear the rules without wanting the default to return.
    fs.writeFileSync(ignorePath, '');
    f.service.coderProjects = [{ path: root }];
    f.service.dependencyLifecycle.get = () => undefined;
    f.window.projectLock.tryAcquire = async project => ({ ok: true, attachment: f.window.fs.captureProjectAttachment(project) });
    assert.equal(await f.service.projectOpenInternal(root, { reason: 'open' }), true);
    assert.equal(fs.readFileSync(ignorePath, 'utf8'), '');
  });
}

test('projectNew callers still receive a boolean', async (t) => {
  const f = creationFixture(t);
  assert.equal(await f.service.projectNew({ name: 'ui', path: f.projects, board: cachedBoard }, f.options), true);
  assert.equal(await f.service.projectNew({
    name: 'ui2', path: f.projects, board: { ...cachedBoard, version: '3.3.11' },
  }, f.options), false);
});
