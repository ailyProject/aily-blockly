'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readPureModule, sourceClass } = require('./fixtures/bootstrap-host-source.cjs');

const domain = 'src/app/services/domains/project';
const templates = readPureModule(`${domain}/blockly-project-template.ts`);
const board = { name: '@aily-project/board-test', version: '1.2.3' };
const library = '@aily-project/lib-kept';
const npmError = 'npm error ECONNREFUSED: original registry error';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-blockly-create-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const boardPath = path.join(root, 'node_modules', board.name);
  const template = path.join(boardPath, 'template');
  fs.mkdirSync(projects); fs.mkdirSync(template, { recursive: true });
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  write(path.join(boardPath, 'package.json'), board);
  write(path.join(boardPath, 'board.json'), { name: 'Test board' });
  write(path.join(template, 'package.json'), { dependencies: { [board.name]: board.version, [library]: '2.4.1' } });
  write(path.join(template, 'project.abi'), { blocks: { languageVersion: 0, blocks: [] } });
  const sdk = path.join(root, 'tools', 'compiler', '5.3.0');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'installed.txt'), 'existing shared tool');
  const originalBoard = fs.readFileSync(path.join(boardPath, 'package.json'));
  const fsApi = {
    ...fs, readFileSync: file => fs.readFileSync(file, 'utf8'),
    lstatSync: file => { const s = fs.lstatSync(file); return { _isDirectory: s.isDirectory(), _isFile: s.isFile() }; },
  };
  const pathApi = { ...path, getAppDataPath: () => root };
  const window = { fs: fsApi, path: pathApi };
  const Project = sourceClass(`${domain}/project.service.ts`, 'ProjectService', {
    ...readPureModule(`${domain}/coder/coder-project-template.ts`),
    ...readPureModule(`${domain}/aily-cloud-ignore-file.ts`, { window }),
    ...templates, window,
    isAilyBoardPackageName: name => name === board.name,
    isAilyScopedPackageName: name => name.startsWith('@aily-project/'),
    ...readPureModule(`${domain}/project-package-name.ts`),
  }, ['projectNewWithResult', 'buildProjectPath', 'buildNpmPackageSpec', 'normalizeAilyBoardPackageName', 'updateNewProjectPackageJson']);
  const service = new Project(), calls = { installs: [], schema: [] };
  service.assertProjectCreationMode = async mode => assert.equal(mode, 'blockly');
  service.configService = { getNpmRegistryForProject: () => undefined };
  service.buildNpmInstallCommand = async spec => spec;
  service.cmdService = { runAsync: async cmd => { calls.installs.push(cmd); return { type: 'close', code: 1, stderr: npmError }; } };
  service.application = { updateFooterState() {} };
  service.metrics = { record() {} }; service.message = { error() {} };
  service.translate = { instant: key => key };
  service.importProjectDirectory = (from, to) => fs.cpSync(from, to, { recursive: true });
  service.initializeProjectDataSchema = async project => calls.schema.push(project);
  const create = (name, version = board.version, options = {}) => service.projectNewWithResult({ name, path: projects, board: { ...board, version } }, { deferActivation: true, ...options });
  return { root, projects, boardPath, template, sdk, originalBoard, write, create, calls, fsApi, pathApi };
}

test('first and second Blockly creation reuse only the exact verified board and preserve template libraries and shared SDK', async t => {
  const f = fixture(t);
  for (const name of ['first blocks', 'second blocks']) {
    const result = await f.create(name);
    assert.equal(result.ok, true, result.error);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.projectPath, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies[board.name], board.version);
    assert.equal(manifest.dependencies[library], '2.4.1');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.projectPath, 'project.abi'), 'utf8')), { blocks: { languageVersion: 0, blocks: [] } });
    assert.match(fs.readFileSync(path.join(result.projectPath, '.ailyignore'), 'utf8'), /^#[^\n]+\nbuild\/\n$/);
  }
  assert.deepEqual(f.calls.installs, []);
  assert.equal(f.calls.schema.length, 2);
  assert.ok(fs.readFileSync(path.join(f.boardPath, 'package.json')).equals(f.originalBoard));
  assert.equal(fs.readFileSync(path.join(f.sdk, 'installed.txt'), 'utf8'), 'existing shared tool');
});

for (const [name, invalidate] of [
  ['another installed version', f => f.write(path.join(f.boardPath, 'package.json'), { ...board, version: '1.2.2' })],
  ['another installed package', f => f.write(path.join(f.boardPath, 'package.json'), { ...board, name: '@aily-project/board-other' })],
  ['malformed board config', f => fs.writeFileSync(path.join(f.boardPath, 'board.json'), '{')],
  ['missing template ABI', f => fs.unlinkSync(path.join(f.template, 'project.abi'))],
  ['malformed template ABI', f => fs.writeFileSync(path.join(f.template, 'project.abi'), '{')],
  ['invalid workspace structure', f => f.write(path.join(f.template, 'project.abi'), { blocks: [] })],
  ['another template board version', f => f.write(path.join(f.template, 'package.json'), { dependencies: { [board.name]: '9.0.0' } })],
  ['ambiguous template version', f => f.write(path.join(f.template, 'package.json'), { dependencies: { [board.name]: '^1.2.3' } })],
  ['missing template board identity', f => f.write(path.join(f.template, 'package.json'), { dependencies: { [library]: '2.4.1' } })],
  ['Coder template in Blockly directory', f => f.write(path.join(f.template, 'package.json'), { type: 'coder', dependencies: { [board.name]: board.version } })],
]) test(`${name} retains the original install and failure facts without creating a project`, async t => {
  const f = fixture(t); invalidate(f);
  const result = await f.create('must not create');
  assert.equal(result.ok, false); assert.equal(result.stage, 'board-install');
  assert.equal(result.npmExitCode, 1); assert.equal(result.error, npmError);
  assert.deepEqual(f.calls.installs, [`${board.name}@${board.version}`]);
  assert.deepEqual(fs.readdirSync(f.projects), []);
  assert.equal(fs.readFileSync(path.join(f.sdk, 'installed.txt'), 'utf8'), 'existing shared tool');
});

test('ranges, tags and custom template directories keep their original installation path', async t => {
  const f = fixture(t);
  for (const version of ['latest', '^1.2.3']) assert.equal((await f.create('not created', version)).stage, 'board-install');
  assert.equal((await f.create('custom', board.version, { templateDirectory: 'custom' })).stage, 'board-install');
  assert.equal(f.calls.installs.length, 3); assert.deepEqual(fs.readdirSync(f.projects), []);
});
