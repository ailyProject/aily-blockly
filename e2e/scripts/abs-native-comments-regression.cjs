// Real Electron + current dev renderer + public Agent ABS operations.
// The fixture owns its project, dependencies, profile and Agent state.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { parseArgs } = require('node:util');
const { _electron } = require('playwright');

const { values: args } = parseArgs({ options: {
  agent: { type: 'string' }, libraries: { type: 'string' }, installed: { type: 'string' },
  output: { type: 'string' }, 'expect-failure': { type: 'boolean', default: false },
  compile: { type: 'boolean', default: false },
  'rollback-check': { type: 'boolean', default: false },
  variant: { type: 'string', default: 'scoped' },
} });
assert.ok(['scoped', 'global-root'].includes(args.variant), '--variant must be scoped or global-root');
for (const name of ['agent', 'libraries', 'installed', 'output']) assert.ok(path.isAbsolute(args[name] || ''), `--${name} must be absolute`);
const repo = path.resolve(__dirname, '../..');
const root = args.output;
assert.equal(fs.existsSync(root), false, 'Never overwrite earlier evidence');
fs.mkdirSync(root, { recursive: true });
const project = path.join(root, 'project'), appData = path.join(root, 'app-data');
fs.mkdirSync(project); fs.mkdirSync(appData);
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent-state');
process.env.AILY_APPDATA_PATH = appData;
const board = '@aily-project/board-arduino_uno';
const boardDir = path.join(args.installed, 'node_modules', board);
const manifest = JSON.parse(fs.readFileSync(path.join(boardDir, 'template/package.json')));
manifest.name = 'abs-native-comments-regression';
for (const name of Object.keys(manifest.dependencies)) {
  const source = name === board ? boardDir : path.join(args.libraries, name.replace('@aily-project/lib-', ''));
  const target = path.join(project, 'node_modules', name);
  fs.cpSync(source, target, { recursive: true, dereference: true });
  manifest.dependencies[name] = JSON.parse(fs.readFileSync(path.join(target, 'package.json'))).version;
}
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2));
fs.copyFileSync(path.join(boardDir, 'template/project.abi'), path.join(project, 'project.abi'));
const config = JSON.parse(fs.readFileSync(path.join(repo, 'electron/config/config.json')));
config.project_path = root; config.appdata_path[process.platform] = appData;
fs.writeFileSync(path.join(appData, 'config.json'), JSON.stringify(config));
if (args.compile) {
  // Copy installed tool inputs into this profile; builder outputs/caches must
  // never share the user's mutable SDK or managed npm prefix.
  const dependencies = JSON.parse(fs.readFileSync(path.join(boardDir, 'package.json'))).boardDependencies;
  for (const name of Object.keys(dependencies)) fs.cpSync(path.join(args.installed, 'node_modules', name),
    path.join(appData, 'node_modules', name), { recursive: true, dereference: true, mode: fs.constants.COPYFILE_FICLONE });
  for (const relative of ['tools/avr-gcc@7.3.0', 'tools/avrdude@6.3.0-arduino17', 'tools/ctags@5.8-arduino11',
    'sdk/avr_1.8.6', 'npm-global/lib', 'npm-global/bin']) {
    fs.cpSync(path.join(args.installed, relative), path.join(appData, relative),
      { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  }
  fs.writeFileSync(path.join(appData, 'package.json'), JSON.stringify({ private: true, dependencies }));
}
const hash = data => createHash('sha256').update(data).digest('hex');
const mirrors = () => Object.fromEntries(['project.abi', 'project.abs', 'project.abs.map.json'].map(name =>
  [name, fs.existsSync(path.join(project, name)) ? hash(fs.readFileSync(path.join(project, name))) : null]));
const report = { root, project, variant: args.variant, startedAt: new Date().toISOString(), calls: [], errors: [], checks: [] };
const save = () => fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
let app, page;
async function main() {
  console.log('ROOT=' + root);
  const native = await fetch('http://localhost:4200/blockly/runtime/native-candidate.js').then(r => r.arrayBuffer());
  report.nativeHash = hash(Buffer.from(native));
  assert.equal(report.nativeHash, JSON.parse(fs.readFileSync(path.join(repo, '.generated/blockly-runtime/manifest.json'))).sha256);
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(root, 'profile')}`], cwd: repo,
    env: { ...env, AILY_E2E: '1', AILY_BUILD_PRODUCT: 'blockly', AILY_APPDATA_PATH: appData }, timeout: 60000 });
  report.hostPid = app.process().pid;
  await app.evaluate((_, cache) => { process.env.AILY_BUILDER_PATH = cache; }, path.join(root, 'builder-cache'));
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
    window.commentRegressionProject = window.ng.getComponent(document.querySelector('app-header')).projectService;
  });
  await page.evaluate(async project => {
    await window.commentRegressionProject.initializeProjectDataSchema(project);
    if (!await window.commentRegressionProject.projectOpen(project)) throw Error('Project open failed');
  }, project);
  const ready = () => page.waitForFunction(() => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return c?.projectService.getBlocklyProjectLoadStatus(c.projectService.currentProjectPath)?.ready;
  }, undefined, { timeout: 120000 });
  await ready();
  // Construct the reported invalid program through real Blockly APIs, then save
  // it normally. It deliberately has a setup-local declaration used from loop.
  report.fixture = await page.evaluate(async project => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const B = window.Blockly, w = c.blocklyService.workspace;
    const root = type => w.getTopBlocks(false).find(b => b.type === type);
    const model = w.createVariable('mqttSent', '');
    const create = (type, fields) => { const b = w.newBlock(type); for (const [name, value] of Object.entries(fields)) b.setFieldValue(value, name); b.initSvg(); return b; };
    const declaration = create('variable_define', { VAR: 'mqttSent', TYPE: 'bool' });
    const initial = create('logic_boolean', { BOOL: 'false' });
    declaration.getInput('VALUE').connection.connect(initial.outputConnection);
    root('arduino_setup').getInput('ARDUINO_SETUP').connection.connect(declaration.previousConnection);
    const set = create('variables_set', { VAR: model.getId() });
    const next = create('logic_boolean', { BOOL: 'true' });
    set.getInput('VALUE').connection.connect(next.outputConnection);
    root('arduino_loop').getInput('ARDUINO_LOOP').connection.connect(set.previousConnection);
    root('arduino_setup').setCommentText('Preserve closed comment 中文');
    root('arduino_loop').setCommentText('Preserve open comment 中文');
    await B.renderManagement.finishQueuedRenders();
    const comment = root('arduino_loop').getIcon(B.icons.CommentIcon.TYPE);
    await comment.setBubbleVisible(true);
    comment.setBubbleLocation(new B.utils.Coordinate(440, 340));
    await B.renderManagement.finishQueuedRenders();
    const saved = await window.commentRegressionProject.save(project);
    if (!saved.success) throw Error(saved.error);
    return { state: B.serialization.workspaces.save(w), code: c.blocklyService.getGeneratedCode() };
  }, project);
  const snapshot = () => page.evaluate(() => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return { state: window.Blockly.serialization.workspaces.save(c.blocklyService.workspace), code: c.blocklyService.getGeneratedCode() };
  });
  const comments = state => state.blocks.blocks.filter(b => b.icons?.comment).map(b => ({ id: b.id, comment: b.icons.comment }));
  const load = relative => import(pathToFileURL(path.join(args.agent, 'dist', relative)).href);
  const { createBlocklyToolCatalog } = await load('blockly/tools/definitions.js');
  const { WorkspaceHistoryRuntime } = await load('extensions/pi-workspace-history/runtime.js');
  const history = new WorkspaceHistoryRuntime(project);
  const catalog = createBlocklyToolCatalog(project, history);
  const call = async (name, parameters = {}) => {
    console.log('CALL=' + name);
    const result = (await catalog.find(t => t.name === name).execute({ project, ...parameters })).structuredContent;
    if (name === 'project_build' && result?.resultFile) {
      fs.copyFileSync(result.resultFile, path.join(root, `build-${report.calls.filter(call => call.name === name).length + 1}.txt`));
    }
    report.calls.push({ name, at: new Date().toISOString(), result }); save();
    console.log(JSON.stringify({ name, ok: result?.ok, code: result?.code }));
    if (result?.targetPid) assert.equal(result.targetPid, report.hostPid, 'Only the isolated host may be used');
    return result;
  };
  const exported = await call('abs_export', { initialize: true });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  if (args.compile) {
    const baselineBuild = await call('project_build');
    assert.equal(baselineBuild.ok, false, 'The local variable must fail the original compile');
    const diagnostics = baselineBuild.resultFile ? fs.readFileSync(baselineBuild.resultFile, 'utf8') : JSON.stringify(baselineBuild);
    assert.match(diagnostics, /mqttSent.*not declared|not declared.*mqttSent/);
    report.checks.push('Original setup-local variable reproduced the compiler error');
  }
  const source = fs.readFileSync(path.join(project, 'project.abs'), 'utf8');
  const declaration = '    variable_define("mqttSent", bool, logic_boolean("false"))';
  const candidate = args.variant === 'scoped'
    ? source.replace('variable_define("mqttSent",', 'variable_define_scoped(global, "mqttSent",')
    : source.replace('\n' + declaration, '').replace('arduino_global()', 'arduino_global()\n' + declaration)
      + '\n    time_delay(math_number(1))';
  assert.notEqual(candidate, source);
  fs.writeFileSync(path.join(root, 'candidate.abs'), candidate);
  report.before = mirrors();
  await page.screenshot({ path: path.join(root, 'before.png') });
  if (args['rollback-check']) {
    await page.evaluate(() => {
      const service = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
      const original = service.prepareProjectCode;
      window.restoreCommentRegressionPreparation = () => { service.prepareProjectCode = original; };
      service.prepareProjectCode = () => { throw Error('Injected code preparation failure after comment load'); };
    });
    let rejected;
    try { rejected = await call('abs_apply', { abs: candidate, generation: exported.generation }); }
    finally { await page.evaluate(() => window.restoreCommentRegressionPreparation()); }
    assert.equal(rejected.ok, false);
    assert.equal(rejected.application?.status, 'ROLLED_BACK', JSON.stringify(rejected));
    assert.equal(rejected.publication?.status, 'NOT_COMMITTED');
    assert.deepEqual(mirrors(), report.before);
    assert.deepEqual(comments((await snapshot()).state), comments(report.fixture.state));
    report.checks.push('Injected generation failure rolled back both comments and preserved all published files');
  }
  const applied = await call('abs_apply', { abs: candidate, generation: exported.generation });
  report.after = mirrors();
  if (args['expect-failure']) {
    assert.equal(applied.ok, false); assert.equal(applied.code, 'ABS_NATIVE_EFFECT_UNSUPPORTED');
    assert.match(applied.message || applied.error, /Promise continuations.*final ABI verification/);
    assert.deepEqual(report.after, report.before, 'Failed preparation must preserve all published files');
    report.checks.push('Reproduced original Promise failure; published ABI/ABS/map unchanged');
  } else {
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.publication?.status, 'COMMITTED'); assert.equal(applied.applyVerification?.ok, true);
    report.applied = await snapshot();
    assert.deepEqual(comments(report.applied.state), comments(report.fixture.state));
    const code = report.applied.code;
    assert.ok(code.indexOf('bool mqttSent = false;') < code.indexOf('void setup(') && code.indexOf('bool mqttSent = false;') >= 0);
    assert.match(code.slice(code.indexOf('void loop(')), /mqttSent = true;/);
    report.checks.push('Public ABS apply committed global variable; both comments retained');
    await page.evaluate(async project => {
      if (!await window.commentRegressionProject.close() || !await window.commentRegressionProject.projectOpen(project)) throw Error('Reopen failed');
    }, project);
    await ready(); report.reopened = await snapshot();
    assert.deepEqual(comments(report.reopened.state), comments(report.fixture.state));
    assert.deepEqual(mirrors(), report.after);
    report.checks.push('Reopen retained comments and all published files');
    if (args.compile) { const build = await call('project_build'); assert.equal(build.ok, true, JSON.stringify(build)); }
    await page.screenshot({ path: path.join(root, 'after.png') });
    // Exercise the actual comment icon hit target after reopening the project.
    await page.evaluate(() => {
      const w = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService.workspace;
      w.getTopBlocks(false).find(b => b.type === 'arduino_setup').getSvgRoot()
        .querySelector('.blocklyCommentIcon').setAttribute('data-regression-comment', 'setup');
    });
    await page.locator('[data-regression-comment="setup"]').click();
    await page.waitForFunction(() => {
      const w = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService.workspace;
      const icon = w.getTopBlocks(false).find(b => b.type === 'arduino_setup').getIcon(window.Blockly.icons.CommentIcon.TYPE);
      return icon.bubbleIsVisible() && icon.getBubble()?.getText() === 'Preserve closed comment 中文';
    });
    await page.screenshot({ path: path.join(root, 'comment-click.png') });
    await page.locator('[data-regression-comment="setup"]').click();
    await page.waitForFunction(() => {
      const w = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService.workspace;
      return !w.getTopBlocks(false).find(b => b.type === 'arduino_setup').getIcon(window.Blockly.icons.CommentIcon.TYPE).bubbleIsVisible();
    });
    report.checks.push('Reopened comment responds to real mouse clicks and retains its text');
  }
  report.success = true;
}
main().catch(error => { report.failure = error.stack; console.error(error); process.exitCode = 1; })
  .finally(async () => { report.completedAt = new Date().toISOString(); save(); await app?.close(); });
