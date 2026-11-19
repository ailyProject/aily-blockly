'use strict';
// Real Electron -> renderer preparation -> local compiler / loopback Gateway + Worker.
// Seeds are read-only; all projects, account fixtures, caches and outputs are isolated.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { launchAilyElectron, getMainWindow, openBlocklyProject } = require('../fixtures/electron-app.ts');
const { captureSnapshot } = require('../../electron/cloud-build/snapshot');
const protocol = require('../../electron/cloud-build/protocol');
const { createPreset, allocatePartitions, serializePartitions, parsePartitionCsv, validatePartitions } = require('../../src/app/services/shared/partitions/partition-layout.ts');
const repo = path.resolve(__dirname, '../..');
const source = process.env.PARTITION_PROJECT_SEED, seed = process.env.AILY_E2E_TOOLCHAIN_SEED, cloudRoot = process.env.PARTITION_CLOUD_ROOT;
assert(source && seed && cloudRoot, 'Set PARTITION_PROJECT_SEED, AILY_E2E_TOOLCHAIN_SEED and PARTITION_CLOUD_ROOT');
const outBase = path.join(repo, 'e2e/.artifacts/partition-build'); fs.mkdirSync(outBase, { recursive: true });
const output = fs.mkdtempSync(path.join(outBase, 'run-')), project = path.join(output, 'project');
const write = (filename, content) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); };
const writeJson = (filename, value) => write(filename, JSON.stringify(value, null, 2));
const report = { output, cases: [] };
const log = (kind, value) => { console.log(kind, JSON.stringify(value)); writeJson(path.join(output, 'report.json'), report); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, description, timeout = 240000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(200); } throw Error('Timed out: ' + description); }
function verifyPartitionBinary(file, csv) {
  const rows = validatePartitions(parsePartitionCsv(csv).rows, 4 * 1024 * 1024).partitions;
  const bytes = fs.readFileSync(file);
  rows.forEach((row, index) => {
    const offset = index * 32;
    assert.equal(bytes.readUInt16LE(offset), 0x50aa);
    assert.equal(bytes[offset + 2], row.typeId); assert.equal(bytes[offset + 3], row.subtypeId);
    assert.equal(bytes.readUInt32LE(offset + 4), row.offsetBytes); assert.equal(bytes.readUInt32LE(offset + 8), row.sizeBytes);
    assert.equal(bytes.subarray(offset + 12, offset + 28).toString().replace(/\0.*$/, ''), row.name);
  });
}
let gateway, worker, launch, main, events = [];
const boardModule = '@aily-project/board-esp32s3';
(async () => {
  const sourceBoard = path.join(source, 'node_modules', boardModule);
  fs.cpSync(path.join(sourceBoard, 'template'), project, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
  pkg.name = 'partition-build-acceptance'; pkg.projectConfig = { PartitionScheme: 'custom', FlashSize: '4M' };
  writeJson(path.join(project, 'package.json'), pkg);
  const copied = new Set();
  function copyPackage(name) {
    if (copied.has(name)) return; copied.add(name);
    const directory = path.join(source, 'node_modules', name); assert(fs.existsSync(directory), name);
    fs.cpSync(directory, path.join(project, 'node_modules', name), { recursive: true });
    for (const dep of Object.keys(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).dependencies || {})) copyPackage(dep);
  }
  Object.keys(pkg.dependencies).forEach(copyPackage);
  const boardRoot = path.join(project, 'node_modules', boardModule), boardPkg = JSON.parse(fs.readFileSync(path.join(boardRoot, 'package.json'))), board = JSON.parse(fs.readFileSync(path.join(boardRoot, 'board.json')));
  const boardCsv = path.join(boardRoot, 'partitions.csv'), csvFile = path.join(project, 'src/partitions.csv');
  fs.rmSync(boardCsv, { force: true }); fs.rmSync(csvFile, { force: true }); fs.rmSync(path.join(project, 'partitions.csv'), { force: true });
  const snapshotProfile = { runner: 'aily-builder', boardModule, boardVersion: boardPkg.version, boardDigest: protocol.boardDigest(boardPkg, board) };
  assert.throws(() => captureSnapshot({ currentProjectPath: project, boardModule, code: 'void setup() {}\nvoid loop() {}' }, snapshotProfile), /Custom partition source is unavailable/);
  report.baseline = 'unprepared custom project rejected by cloud snapshot'; log('baseline', report.baseline);
  const sdk = path.join(seed, 'sdk', 'esp32_' + boardPkg.boardDependencies['@aily-project/sdk-esp32']);
  const { startGateway } = require(path.join(cloudRoot, 'builder-gateway/src'));
  const { startCompilerNode } = require(path.join(cloudRoot, 'builder-server'));
  gateway = await startGateway({ host: '127.0.0.1', port: 0, dataDir: path.join(output, 'gateway'),
    boardCatalog: { schemaVersion: 1, boards: [{ boardModule, boardVersion: boardPkg.version, name: 'ESP32-S3' }] } });
  const builderEntryPath = process.env.PARTITION_CLOUD_BUILDER || path.join(cloudRoot, 'builder-server/compiler/runtime/aily-builder.js');
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(builderEntryPath), 'package.json'))).version;
  const profile = { id: 'partition-acceptance', ...snapshotProfile, boardPackagePath: boardRoot, fqbn: board.type,
    builderVersion: version, builderEntryPath, sdkPath: sdk, toolsPath: path.join(seed, 'tools'), boardsTxtPath: path.join(sdk, 'boards.txt'),
    supportedPlatforms: [process.platform], platform: process.platform, arch: process.arch, jobs: 2, compileOnly: true,
    artifactSegments: [{ path: '{sketch}.bin', role: 'firmware' }, { path: '{sketch}.partitions.bin', role: 'auxiliary' }],
    toolVersions: { 'esp-x32': '14.2.0', 'esp32s3-libs': '3.3.10', esptool_py: '5.3.0' },
    resources: { ramBytes: 512 * 1024 * 1024, diskBytes: 256 * 1024 * 1024 }, probeTimeoutMs: 240000 };
  worker = await startCompilerNode({ workerId: 'partition-acceptance', executionProfile: 'development',
    gatewayUrl: gateway.url.replace(/^http/, 'ws') + '/api/internal/build/nodes/connect', workRoot: path.join(output, 'worker'),
    maxSlots: 1, jobsPerTask: 2, autoCapacity: { enabled: false }, profiles: [profile], minFreeDiskBytes: 256 * 1024 * 1024 });
  for (const event of ['progress', 'log', 'task-error', 'diagnostic', 'committed']) worker.on(event, value => fs.appendFileSync(path.join(output, 'worker.jsonl'), JSON.stringify({ event, value }) + '\n'));
  await until(() => gateway.nodes.size, 'worker registration');
  const serverKey = gateway.operations.statisticsServer([...gateway.nodes.values()][0].workerId).key;
  const enabled = await fetch(gateway.url + '/api/admin/servers/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverKey, boardKeys: [boardModule + '@' + boardPkg.version] }) }); assert(enabled.ok);
  const target = await until(async () => (await fetch(gateway.url + '/api/v1/build/targets').then(r => r.json())).profiles?.[0], 'real compiler probe');
  const caps = await fetch(gateway.url + '/api/v1/build/capabilities').then(r => r.json());
  const home = path.join(output, 'home'); fs.mkdirSync(home);
  process.env.AILY_E2E_DEV_URL ||= 'http://localhost:4200';
  launch = await launchAilyElectron({ environment: { AILY_BUILD_PRODUCT: 'blockly', HOME: home,
    AILY_E2E_TOOLCHAIN_PROJECT: project, AILY_CLOUD_BUILD_GATEWAY_URL: gateway.url, AILY_CLOUD_BUILD_PUBLIC_KEY: caps.publicKey,
    PI_CODING_AGENT_DIR: path.join(output, 'agent'), AILY_AGENT_HOME: path.join(output, 'agent') },
    config: { selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true, compile: { backend: 'cloud' }, devmode: { enabled: true, autoSave: false } } });
  launch.app.removeAllListeners('console');
  launch.app.process().stdout?.on('data', data => fs.appendFileSync(path.join(output, 'electron.log'), data));
  launch.app.process().stderr?.on('data', data => fs.appendFileSync(path.join(output, 'electron.log'), data));
  main = await getMainWindow(launch.app);
  main.on('console', m => fs.appendFileSync(path.join(output, 'renderer.log'), `[${m.type()}] ${m.text()}\n`));
  await main.exposeFunction('__partitionBuildEvent', event => { events.push(event); fs.appendFileSync(path.join(output, 'cloud.jsonl'), JSON.stringify(event) + '\n'); });
  await main.evaluate(() => window.cloudBuild.onProgress(event => window.__partitionBuildEvent(event)));
  await main.addLocatorHandler(main.locator('app-login .login-close'), b => b.click());
  await main.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-main-window'))?.authService?.getAuthInitializationState() === 'signed_out');
  // Local account fixture only. All compiler jobs run on our isolated loopback server.
  await main.evaluate(() => { const auth = window.ng.getComponent(document.querySelector('app-main-window')).authService; auth.isLoggedInSubject.next(true); auth.setCurrentUserInfo({ id: 'partition-local-fixture', subscription_plan: { name: 'pro' } }); });
  await openBlocklyProject(main, project);
  await main.waitForFunction(project => { const p = window.ng.getComponent(document.querySelector('app-header')).projectService; const s = p.getBlocklyProjectLoadStatus(project); if (s?.state === 'error') throw Error(JSON.stringify(s)); return p.currentProjectPath === project && s?.ready; }, project, { timeout: 240000 });
  log('opened', { pid: launch.app.process().pid, project, gateway: gateway.url });
  async function compile(name, cloud, disk = false) {
    events = []; const started = Date.now(); log('compile', { name });
    if (disk) {
      const result = await main.evaluate(project => window.ng.getComponent(document.querySelector('app-header')).builderService.build(project), project);
      assert.equal(result?.success ?? result?.state === 'done', true, JSON.stringify(result));
    } else await main.locator('app-header app-act-btn[data-action="compile"]').click();
    if (!disk) {
    const built = await until(() => {
      const latest = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
      if (Date.parse(latest.buildInfo?.lastBuildTime || '') >= started) return latest;
      const failure = events.find(e => e.stage === 'failed'); if (failure) throw Error(JSON.stringify(failure));
    }, name, 360000);
    assert.equal(built.buildInfo.lastBuildStatus, 'success', JSON.stringify(built.buildInfo));
    }
    const csv = fs.readFileSync(csvFile, 'utf8');
    const result = { name, cloud, disk, milliseconds: Date.now() - started, csvSha256: protocol.sha256(Buffer.from(csv)) };
    if (cloud) {
      const complete = events.find(e => e.stage === 'complete'); assert(complete, 'actual cloud completion');
      const dir = await main.evaluate(project => window.cloudBuild.artifactPath({ projectPath: project }), project);
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'aily-cloud-result.json'))); protocol.verifyManifest(receipt.manifest, receipt.signature, caps.publicKey);
      for (const file of receipt.manifest.artifacts) { const bytes = fs.readFileSync(path.join(dir, file.path)); assert.equal(bytes.length, file.sizeBytes); assert.equal(protocol.sha256(bytes), file.sha256); }
      Object.assign(result, { reused: !!complete.reused, jobId: receipt.manifest.jobId, inputDigest: receipt.manifest.inputDigest, verifiedArtifacts: receipt.manifest.artifacts.map(a => a.path) });
      verifyPartitionBinary(path.join(dir, 'sketch.partitions.bin'), csv);
      writeJson(path.join(output, name + '-receipt.json'), receipt);
    } else {
      assert.equal(fs.readFileSync(path.join(project, '.temp/sketch/partitions.csv'), 'utf8'), csv);
      verifyPartitionBinary(path.join(project, '.build/sketch.partitions.bin'), csv);
      const bins = fs.readdirSync(path.join(project, '.build')).filter(file => file.endsWith('.bin')); assert(bins.length); result.binaries = bins;
    }
    report.cases.push(result); log('passed', result); return result;
  }
  const first = await compile('cloud-generated', true);
  assert.equal(fs.readFileSync(csvFile, 'utf8'), serializePartitions(allocatePartitions(createPreset('iot', 4 * 1024 * 1024)).rows));
  assert.equal((await compile('cloud-reuse', true)).reused, true);
  write(csvFile, fs.readFileSync(csvFile, 'utf8') + '# preserved user edit\n');
  const edited = await compile('cloud-csv-change', true); assert.equal(edited.reused, false); assert.notEqual(edited.inputDigest, first.inputDigest);
  const boardContent = serializePartitions(allocatePartitions(createPreset('large', 4 * 1024 * 1024)).rows);
  fs.unlinkSync(csvFile); write(boardCsv, boardContent);
  await compile('cloud-board-fallback', true); assert.equal(fs.readFileSync(csvFile, 'utf8'), boardContent);
  await main.evaluate(async () => { const config = window.ng.getComponent(document.querySelector('app-header')).configService; config.data.compile.backend = 'local'; await config.saveCompileSettings(); });
  await until(() => main.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).configService.getCompileBackend() === 'local'), 'local mode');
  fs.unlinkSync(csvFile); fs.unlinkSync(boardCsv);
  await compile('local-sdk-fallback', false);
  assert.equal(fs.readFileSync(csvFile, 'utf8'), fs.readFileSync(path.join(sdk, 'tools/partitions/default.csv'), 'utf8'));
  // Run the disk compile entry point too, using the last saved generated sketch.
  const stable = fs.readFileSync(csvFile, 'utf8'); await compile('local-disk-existing', false, true); assert.equal(fs.readFileSync(csvFile, 'utf8'), stable);
  await main.screenshot({ path: path.join(output, 'compiled.png') });
  report.success = true;
})().catch(error => { report.error = error.stack; process.exitCode = 1; log('failure', error.stack); }).finally(async () => {
  if (launch) await launch.close(); if (worker) await worker.close(); if (gateway) await gateway.close();
  writeJson(path.join(output, 'report.json'), report); console.log('Evidence:', output);
});
