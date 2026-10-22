// Replay a recorded ABS candidate through public Agent tools in an isolated Electron host.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { parseArgs } = require('node:util');
const { _electron } = require('playwright');

const { values: args } = parseArgs({ options: {
  source: { type: 'string' }, session: { type: 'string' }, agent: { type: 'string' }, output: { type: 'string' },
  installed: { type: 'string' },
  variant: { type: 'string', default: '0' }, 'expect-failure': { type: 'boolean', default: false },
} });
for (const name of ['source', 'session', 'agent', 'output', 'installed']) assert.ok(path.isAbsolute(args[name] || ''), `--${name} must be absolute`);
const repo = path.resolve(__dirname, '../..'), root = args.output;
assert.equal(fs.existsSync(root), false, 'Never overwrite earlier evidence');
fs.mkdirSync(root, { recursive: true });
const project = path.join(root, 'project'), appData = path.join(root, 'app-data');
const skipped = new Set(['.build', '.log', '.temp', '.workspace-history', '.aily/abs-sync', 'project.abs', 'project.abs.map.json']);
fs.cpSync(args.source, project, { recursive: true, dereference: true,
  filter: source => !skipped.has(path.relative(args.source, source).replaceAll(path.sep, '/')) });
fs.mkdirSync(appData);
const dependencies = JSON.parse(fs.readFileSync(path.join(project, 'node_modules/@aily-project/board-easyvoice_1306_dev/package.json'))).boardDependencies;
for (const name of Object.keys(dependencies)) fs.cpSync(path.join(args.installed, 'node_modules', name),
  path.join(appData, 'node_modules', name), { recursive: true, dereference: true, mode: fs.constants.COPYFILE_FICLONE });
for (const relative of ['sdk/ci13xx_1.0.14', 'tools/riscv-gcc@9.2.0', 'tools/citool-cli@1.2.2', 'tools/ctags@5.8-arduino11']) {
  fs.cpSync(path.join(args.installed, relative), path.join(appData, relative),
    { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
}
fs.writeFileSync(path.join(appData, 'package.json'), JSON.stringify({ private: true, dependencies }));
const config = JSON.parse(fs.readFileSync(path.join(repo, 'electron/config/config.json')));
config.project_path = root; config.appdata_path[process.platform] = appData;
fs.writeFileSync(path.join(appData, 'config.json'), JSON.stringify(config));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent-state');
process.env.AILY_APPDATA_PATH = appData;
const candidates = fs.readFileSync(args.session, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  .flatMap(row => Array.isArray(row.message?.content) ? row.message.content : [])
  .filter(entry => entry.type === 'toolCall' && entry.name === 'abs_apply').map(entry => entry.arguments.abs);
const candidate = candidates[Number(args.variant)];
assert.equal(typeof candidate, 'string', 'Recorded candidate required');
const hash = value => createHash('sha256').update(value).digest('hex');
const mirrors = directory => Object.fromEntries(['project.abi', 'project.abs', 'project.abs.map.json'].map(name =>
  [name, fs.existsSync(path.join(directory, name)) ? hash(fs.readFileSync(path.join(directory, name))) : null]));
const sourceBefore = mirrors(args.source);
const report = { startedAt: new Date().toISOString(), variant: args.variant, calls: [], errors: [], checks: [] };
const save = () => fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
let app, page, history;
async function main() {
  const native = await fetch('http://localhost:4200/blockly/runtime/native-candidate.js').then(r => r.arrayBuffer());
  report.nativeHash = hash(Buffer.from(native));
  assert.equal(report.nativeHash, JSON.parse(fs.readFileSync(path.join(repo, '.generated/blockly-runtime/manifest.json'))).sha256);
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(root, 'profile')}`], cwd: repo,
    env: { ...env, AILY_E2E: '1', AILY_BUILD_PRODUCT: 'blockly', AILY_APPDATA_PATH: appData }, timeout: 60000 });
  report.hostPid = app.process().pid;
  process.env.AILY_LIBRARY_HOST_PID = String(report.hostPid);
  const deadline = Date.now() + 60000;
  while (!page && Date.now() < deadline) {
    for (const win of app.windows()) if (await win.locator('app-main-window').count().catch(() => 0)) { page = win; break; }
    if (!page) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(page, 'Real main window');
  page.on('pageerror', error => { report.errors.push(error.message); save(); });
  await page.waitForFunction(() => !!window.ng?.getComponent && !!document.querySelector('app-header'));
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click(); };
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss();
    window.audioRegressionProject = window.ng.getComponent(document.querySelector('app-header')).projectService;
  });
  await page.evaluate(async project => {
    await window.audioRegressionProject.initializeProjectDataSchema(project);
    if (!await window.audioRegressionProject.projectOpen(project)) throw Error('Project open failed');
  }, project);
  const ready = () => page.waitForFunction(() => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return c?.projectService.getBlocklyProjectLoadStatus(c.projectService.currentProjectPath)?.ready;
  }, undefined, { timeout: 120000 });
  await ready();
  const snapshot = () => page.evaluate(() => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return { audio: c.blocklyService.workspace.getAllBlocks(false).filter(b => b.type === 'chipintelli_audio_local_audio')
      .map(b => ({ id: b.id, value: b.getFieldValue('AUDIO') })), code: c.blocklyService.getGeneratedCode() };
  });
  report.before = await snapshot();
  assert.equal(report.before.audio.length, 1);
  const audioFiles = Object.fromEntries(['sourcePath', 'audioPath'].map(key => {
    const relative = report.before.audio[0].value[key];
    return [relative, hash(fs.readFileSync(path.join(project, relative)))];
  }));
  const load = relative => import(pathToFileURL(path.join(args.agent, 'dist', relative)).href);
  const { createBlocklyToolCatalog } = await load('blockly/tools/definitions.js');
  const { WorkspaceHistoryRuntime } = await load('extensions/pi-workspace-history/runtime.js');
  history = new WorkspaceHistoryRuntime(project);
  const catalog = createBlocklyToolCatalog(project, history);
  const call = async (name, parameters = {}) => {
    const result = (await catalog.find(tool => tool.name === name).execute({ project, ...parameters })).structuredContent;
    report.calls.push({ name, result }); save();
    console.log(JSON.stringify({ name, ok: result?.ok, code: result?.code }));
    if (result?.targetPid) assert.equal(result.targetPid, report.hostPid);
    return result;
  };
  const exported = await call('abs_export', { initialize: true });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  const before = mirrors(project);
  const applied = await call('abs_apply', { abs: candidate, generation: exported.generation });
  if (args['expect-failure']) {
    assert.equal(applied.ok, false);
    assert.equal(applied.code, 'ABS_NATIVE_EFFECT_UNSUPPORTED');
    assert.equal(applied.diagnostic.reason, 'projectService.currentProjectPath');
    assert.deepEqual(mirrors(project), before);
    report.checks.push('Original candidate failed before publication; project files unchanged');
  } else {
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.publication.status, 'COMMITTED');
    assert.equal(applied.applyVerification.ok, true);
    report.after = await snapshot();
    assert.deepEqual(report.after.audio, report.before.audio);
    const command = Number(args.variant) === 0 ? '打开灯光' : '大声一点';
    assert.ok(fs.readFileSync(path.join(project, 'project.abs'), 'utf8').includes(command));
    assert.ok(report.after.code.includes(command));
    assert.ok(report.after.code.includes(report.before.audio[0].value.audioPath));
    const after = mirrors(project);
    await page.evaluate(async project => {
      if (!await window.audioRegressionProject.close() || !await window.audioRegressionProject.projectOpen(project)) throw Error('Reopen failed');
    }, project);
    await ready();
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-blockly-editor'))
      ?.blocklyService.getGeneratedCode()?.length > 0);
    report.reopened = await snapshot();
    assert.deepEqual(report.reopened, report.after);
    assert.deepEqual(mirrors(project), after);
    await page.evaluate(() => {
      const w = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService.workspace;
      const b = w.getAllBlocks(false).find(b => b.type === 'chipintelli_audio_local_audio');
      w.centerOnBlock(b.id);
      b.getField('AUDIO').getSvgRoot().setAttribute('data-audio-regression', 'true');
    });
    await page.locator('[data-audio-regression]').click();
    await page.waitForFunction(() => {
      const field = window.Blockly.DropDownDiv.getOwner();
      return field?.getValue()?.audioPath && field.statusElement?.textContent.includes('kbps')
        && field.sourceWaveform?.some(value => value > 0) && field.outputWaveform?.some(value => value > 0);
    }, undefined, { timeout: 30000 });
    await page.screenshot({ path: path.join(root, 'audio-editor.png') });
    await page.keyboard.press('Escape');
    for (const [relative, digest] of Object.entries(audioFiles)) assert.equal(hash(fs.readFileSync(path.join(project, relative))), digest);
    assert.deepEqual(mirrors(project), after);
    assert.deepEqual(report.errors, []);
    report.checks.push('Original complete candidate committed with audio IDs, values and bytes retained',
      'Reopen preserved published files and generated code', 'Real audio field click loaded file status and both waveforms');
  }
  assert.deepEqual(mirrors(args.source), sourceBefore);
  report.success = true;
}
main().catch(async error => {
  report.failure = error.stack; console.error(error); process.exitCode = 1;
  if (page) {
    report.failureUi = await page.locator('body').innerText().catch(() => 'Unavailable');
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  }
})
  .finally(async () => {
    report.completedAt = new Date().toISOString(); save();
    await history?.dispose();
    // Only this fixture's copied project/profile is owned here; do not wait on a
    // close-time save dialog after verifying the exact published bytes above.
    if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => app.process().kill());
  });
