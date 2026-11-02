'use strict';
// Actual package postinstall + ESP32 compilation in isolated writable resources.
// Requires the local compiler package/archive and SDK; never mutates their originals.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
const repo = path.resolve(__dirname, '../..');
const source = process.env.AILY_COMPILER_SOURCE_APPDATA || path.join(os.homedir(),
  process.platform === 'darwin' ? 'Library/aily-project' : process.platform === 'win32' ? 'AppData/Local/aily-project' : '.aily-project');
const builder = process.env.AILY_COMPILER_TEST_BUILDER || path.resolve(repo, '../aily-builder');
const output = fs.mkdtempSync(path.join(repo, 'tests/.artifacts/compiler-repair-'));
const root = path.join(output, 'appdata'), tools = path.join(root, 'tools');
const packageName = '@aily-project/compiler-esp-x32';
const packageDir = path.join(root, 'node_modules', packageName);
const sourcePackage = path.join(source, 'node_modules', packageName);
const metadata = JSON.parse(fs.readFileSync(path.join(sourcePackage, 'package.json'), 'utf8'));
const version = metadata.version;
const compilerDir = path.join(tools, `esp-x32@${version}`);
const bases = { sdkBase: path.join(source, 'sdk'), compilersBase: tools, toolsBase: tools };
const report = { platform: process.platform, arch: process.arch, compilerVersion: version, output, cases: [], installs: 0 };
const fileApi = {
  readFileSync: fs.readFileSync,
  readDirSync: dir => fs.readdirSync(dir, { withFileTypes: true }),
  statSync: filename => { const s = fs.statSync(filename); return { size: s.size, mode: s.mode, _isFile: s.isFile() }; },
};
const window = { fs: fileApi, platform: { isWindows: process.platform === 'win32' },
  path: { join: path.join, basename: path.basename, isExists: fs.existsSync, getAppDataPath: () => root },
  env: { get: async () => undefined }, npm: { run: async () => { throw new Error('Unexpected npm fallback/network request'); } } };
function load(sourceText, extras = {}) {
  const context = { exports: {}, require, window, console, ...extras };
  vm.runInNewContext(ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.exports;
}
function read(relative) { return fs.readFileSync(path.join(repo, relative), 'utf8'); }
const integrity = load(read('src/app/utils/compiler-integrity.utils.ts'));
const platformPackages = load(read('src/app/utils/platform-packages.utils.ts'));
const serviceText = read('src/app/services/domains/dependencies/npm.service.ts');
const ast = ts.createSourceFile('npm.service.ts', serviceText, ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'NpmService');
// Execute production lifecycle methods, supplying only host/notice/process boundaries.
const methods = ['depVersionSatisfiesDecl', 'installedIsNewerThanDeclared', 'isPlatformPackageOnDisk',
  'compilerIntegrityProblem', 'areBoardPlatformDepsReady', 'removeIncompleteCompilerDirectory', 'installBoardDependencies'];
const body = methods.map(name => {
  const member = service.members.find(node => node.name?.getText(ast) === name);
  assert.ok(member, name); return member.getText(ast);
}).join('\n');
const { Probe } = load(`export class Probe { ${body} }`, { ...integrity, ...platformPackages,
  ...require('semver'), appendScopedNpmRegistry: command => command });
const cleanupModule = { exports: {} }, handlers = new Map();
vm.runInNewContext(read('electron/appdata-resource-cleanup.js'), {
  module: cleanupModule, process: { env: { AILY_APPDATA_PATH: root } },
  require: name => name === 'electron' ? { app: { getPath: () => root },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } } : require(name),
});
cleanupModule.exports.registerAppDataResourceCleanupHandlers();
window.ipcRenderer = { invoke: (channel, data) => handlers.get(channel)({}, data) };
const environment = { ...process.env, AILY_COMPILERS_PATH: tools,
  AILY_7ZA_PATH: path.join(repo, 'child', process.platform === 'win32' ? '7za.exe' : '7zz'),
  AILY_ZIP_URL: 'https://invalid.example.test', AILY_ZIP_URLS: '',
  PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
for (const key of ['AILY_CHILD_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'COMPILER_PATH']) delete environment[key];
async function run(args, cwd, logName) {
  const log = fs.openSync(path.join(output, logName), 'w');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd, env: environment, stdio: ['ignore', log, log] });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`${logName}: process exited ${code}`)));
    });
  } finally { fs.closeSync(log); }
}
const npm = Object.assign(new Probe(), {
  assertDependencySession() {}, traceToAppLog() {}, updateBoardDependencyNotice() {},
  getNpmErrorMessage: error => error.message, isCloudBuild: () => false,
  getPlatformPathBases: async () => bases,
  configService: { isCoderProduct: () => false, getNpmRegistryForProject: () => '' },
  application: { updateNotice: notice => { if (notice.state === 'done') report.cases.push('installation-verified'); } },
  translate: { instant: key => key },
  cmdService: { runAsyncChecked: async (command, cwd) => {
    assert.equal(command, 'npm run postinstall'); assert.equal(cwd, packageDir); report.installs++;
    const npmCli = path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    await run([npmCli, 'run', 'postinstall'], cwd, `postinstall-${report.installs}.log`);
  } },
});
const problem = () => integrity.findCompilerIntegrityProblem(packageName, compilerDir, fileApi, path.join, process.platform === 'win32');
async function install() { await npm.installBoardDependencies({ boardDependencies: { [packageName]: version } }, false); }
(async () => {
  fs.mkdirSync(compilerDir, { recursive: true }); fs.mkdirSync(packageDir, { recursive: true });
  for (const name of ['package.json', 'postinstall.js']) fs.copyFileSync(path.join(sourcePackage, name), path.join(packageDir, name));
  const archive = `esp-x32@${version}.7z`;
  // A file copy avoids Windows symlink privileges and protects the original cached archive on installer failure.
  fs.copyFileSync(path.join(sourcePackage, archive), path.join(packageDir, archive));
  assert.ok(problem(), 'empty compiler directory must fail integrity');
  const started = performance.now(); await install();
  report.firstRepairMs = performance.now() - started;
  assert.equal(problem(), undefined); assert.equal(report.installs, 1);
  await install(); assert.equal(report.installs, 1, 'healthy compiler must not reinstall');
  report.cases.push('healthy-compiler-skips-install');
  const cc1plus = path.join(compilerDir, 'libexec/gcc/xtensa-esp-elf');
  const gccVersion = fs.readdirSync(cc1plus).find(name => /^\d/.test(name));
  fs.unlinkSync(path.join(cc1plus, gccVersion, 'cc1plus' + (process.platform === 'win32' ? '.exe' : '')));
  assert.ok(problem(), 'missing internal C++ compiler must fail integrity');
  await install(); assert.equal(problem(), undefined); assert.equal(report.installs, 2);
  report.cases.push('deleted-internal-compiler-auto-repaired');

  const timings = [], readiness = [];
  for (let i = 0; i < 500; i++) { const time = performance.now(); assert.equal(problem(), undefined); timings.push(performance.now() - time); }
  for (let i = 0; i < 100; i++) { const time = performance.now(); assert.equal(await npm.areBoardPlatformDepsReady({ [packageName]: version }), true); readiness.push(performance.now() - time); }
  const stats = values => { values.sort((a, b) => a - b); return { samples: values.length, medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * .95)], maxMs: values.at(-1) }; };
  report.integrity = stats(timings); report.readiness = stats(readiness);
  for (const entry of ['esp32-libs@3.3.12', 'esptool_py@5.3.1', 'ctags@5.8-arduino11']) {
    fs.symlinkSync(path.join(source, 'tools', entry), path.join(tools, entry), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const sketch = path.join(output, 'sketch.ino'), build = path.join(output, 'build'), preprocess = path.join(output, 'preprocess.json');
  fs.writeFileSync(sketch, 'void setup() {}\nvoid loop() {}\n');
  const launch = ['--import', path.join(builder, 'node_modules/tsx/dist/loader.mjs'), path.join(builder, 'main.ts')];
  await run([...launch, 'preprocess', sketch, '--board', 'esp32:esp32:esp32', '--sdk-path', path.join(source, 'sdk/esp32_3.3.12'),
    '--tools-path', tools, '--tool-versions', `esp-x32@${version},esp32-libs@3.3.12,esptool_py@5.3.1`,
    '--build-path', build, '--save-result', preprocess], output, 'preprocess.log');
  await run([...launch, 'compile', sketch, '--board', 'esp32:esp32:esp32', '--build-path', build,
    '--preprocess-result', preprocess, '--no-archive-cloud-cache', '--no-fetch-archive-cloud-cache'], output, 'compile.log');
  assert.ok(fs.readdirSync(build).some(name => name.endsWith('.bin')));
  report.cases.push('real-esp32-firmware-compiled-after-repair'); report.success = true;
})().catch(error => { report.success = false; report.error = error.stack; process.exitCode = 1; })
  .finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.success) fs.rmSync(root, { recursive: true, force: true });
  });
