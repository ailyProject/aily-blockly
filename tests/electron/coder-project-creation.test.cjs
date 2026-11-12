'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readPureModule, sourceClass } = require('./fixtures/bootstrap-host-source.cjs');

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
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readFileSync: (file) => fs.readFileSync(file, 'utf8'),
    writeFileSync: fs.writeFileSync,
    copySync: fs.copyFileSync,
    lstatSync: (file) => {
      const stat = fs.lstatSync(file);
      return { _isDirectory: stat.isDirectory(), _isFile: stat.isFile() };
    },
  };
  const Project = sourceClass(`${domain}/project.service.ts`, 'ProjectService', {
    ...templates,
    window: { fs: fsApi, path: pathApi },
    isAilyBoardPackageName: (name) => name === packageName,
    isAilyScopedPackageName: (name) => name.startsWith('@aily-project/'),
    ...readPureModule(`${domain}/project-package-name.ts`),
  }, ['projectNew', 'projectNewWithResult', 'buildProjectPath', 'buildNpmPackageSpec',
    'normalizeAilyBoardPackageName', 'updateNewProjectPackageJson', 'normalizeAilyCodeBoardDepRange']);
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
  return { create, service, calls, projects, boardPath, template, options, writeJson };
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
  ['missing sketch', (f) => fs.unlinkSync(path.join(f.template, 'project.aci'))],
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

test('projectNew callers still receive a boolean', async (t) => {
  const f = creationFixture(t);
  assert.equal(await f.service.projectNew({ name: 'ui', path: f.projects, board: cachedBoard }, f.options), true);
  assert.equal(await f.service.projectNew({
    name: 'ui2', path: f.projects, board: { ...cachedBoard, version: '3.3.11' },
  }, f.options), false);
});
