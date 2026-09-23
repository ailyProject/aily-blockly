// Opt-in regression replay + autonomous Chat acceptance, isolated from user projects.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createPackagedRendererServer } = require('../electron/packaged-renderer-server');
const { prepareLinkedChatProfile, testLinkedChat } = require('./project-data-linked-chat-smoke.cjs');
const { prepareSerialReplay, replaySerialSession, clearWorkspaceForAgent } = require('./abs-session-followup-checks.cjs');
const [sessionFile, sourceAppData, buildInputs] = process.argv.slice(2);
for (const value of [sessionFile, sourceAppData, buildInputs]) assert.ok(value && path.isAbsolute(value));
const repo = path.resolve(__dirname, '..'), codes = path.dirname(repo);
const reuse = process.env.AILY_GROK_REUSE_ROOT;
const root = reuse || fs.mkdtempSync(path.join(codes, '.codex-artifacts/grok-acceptance-'));
assert.equal(path.dirname(path.resolve(root)), path.join(codes, '.codex-artifacts'));
assert.ok(path.basename(root).startsWith('grok-acceptance-'));
const resumeFile = process.env.AILY_GROK_RESUME_REPORT;
const resumed = resumeFile ? JSON.parse(fs.readFileSync(resumeFile, 'utf8')) : undefined;
const clearBeforeSend = process.env.AILY_GROK_CLEAR_THEN_AGENT === '1';
if (clearBeforeSend) assert.ok(resumed, 'Clear/retest mode requires successful replay evidence');
if (resumed) {
  assert.equal(path.dirname(path.resolve(resumeFile)), path.resolve(root));
  assert.equal(path.dirname(path.resolve(resumed.project)), path.resolve(root));
  assert.equal(resumed.root, root);
  assert.ok(resumed.calls.some(call => call.name === 'abs_apply' && call.result.ok && !call.result.warnings?.length));
}
const appData = path.join(root, 'app-data'), project = resumed?.project || path.join(root, process.env.AILY_GROK_FRESH_PROJECT === '1' ? `replay-project-${Date.now()}` : 'replay-project');
const agent = path.join(codes, 'aily-lex-pro/packages/aily-agent');
const board = path.join(codes, 'aily-blockly-boards/oj_ojoy');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true, filter: file => !['.git', 'node_modules'].includes(path.basename(file)) });
const report = { root, project, calls: [], errors: [], ...(resumed ? { resumedFrom: resumeFile, replayEvidence: resumed.calls } : {}) };
const resultFile = path.join(root, 'result.json');
let app, page, client, linked, sessionId, e2e, serialFixture;
const renderer = createPackagedRendererServer();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(name, args = {}) {
  const start = Date.now();
  const response = await client.callTool({ name, arguments: { project, ...args } }, undefined, { timeout: name === 'project_build' ? 650000 : 120000 });
  const result = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  report.calls.push({ name, ms: Date.now() - start, result }); save(resultFile, report);
  console.log(JSON.stringify({ tool: name, ok: result.ok, code: result.code, ms: Date.now() - start }));
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
async function open(projectPath) {
  assert.equal(await page.evaluate(value => window.acceptanceProject.projectOpen(value), projectPath), true);
  await page.waitForFunction(() => {
    const c = window.ng?.getComponent(document.querySelector('app-blockly-editor'));
    return c?.projectService.getBlocklyProjectLoadStatus(c.projectService.currentProjectPath)?.ready;
  }, undefined, { timeout: 120000 });
}
async function main() {
  console.log('ROOT=' + root);
  if (reuse) {
    const prior = json(resultFile); assert.equal(prior.root, root);
    assert.ok(resumed || prior.project !== project || !prior.calls.some(call => call.name === 'abs_apply' && call.result.ok), 'Never reset an accepted project');
    save(path.join(root, `attempt-${Date.now()}.json`), prior);
  }
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(appData, { recursive: true });
  const pkg = json(path.join(board, 'template/package.json'));
  pkg.name = 'grok-regression'; pkg.dependencies['@aily-project/lib-grok-eyes'] = '2.2.1';
  const libs = path.join(codes, 'aily-blockly-libraries');
  const sources = [board, ...fs.readdirSync(libs, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(libs, e.name))];
  const byName = new Map(sources.filter(p => fs.existsSync(path.join(p, 'package.json'))).map(p => [json(path.join(p, 'package.json')).name, p]));
  for (const name of Object.keys(pkg.dependencies)) {
    const source = byName.get(name); assert.ok(source, name);
    pkg.dependencies[name] = json(path.join(source, 'package.json')).version;
    const target = path.join(project, 'node_modules', name);
    if (!fs.existsSync(target)) {
      copy(source, target);
      if (fs.existsSync(path.join(target, 'src.7z'))) assert.equal(spawnSync(path.join(repo, 'child/7za.exe'), ['x', path.join(target, 'src.7z'), '-o' + target, '-y'], { windowsHide: true }).status, 0);
    }
    assert.equal(json(path.join(target, 'package.json')).version, pkg.dependencies[name]);
    if (reuse && !resumed && fs.existsSync(path.join(source, 'readme_ai.md'))) fs.copyFileSync(path.join(source, 'readme_ai.md'), path.join(target, 'readme_ai.md'));
  }
  if (!resumed) {
    save(path.join(project, 'package.json'), pkg);
    fs.copyFileSync(path.join(board, 'template/project.abi'), path.join(project, 'project.abi'));
  }
  report.dependencies = pkg.dependencies;
  if (reuse) {
    const link = path.join(appData, 'npm-global/app/node_modules/@aily-project/subapp-aily-chat');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), path.resolve(agent, '../aily-chat'));
    fs.unlinkSync(link);
  }
  linked = prepareLinkedChatProfile(appData, sourceAppData, agent);
  const config = linked.config;
  config.project_path = root; config.appdata_path[process.platform] = appData;
  save(path.join(appData, 'config.json'), config);
  // Copy writable platform inputs; no junction to the user's installed SDK/tools.
  assert.equal(json(path.join(buildInputs, 'abs-acceptance-build-inputs.json')).completed, true);
  if (!reuse) {
  copy(path.join(buildInputs, 'sdk/esp32_3.3.10'), path.join(appData, 'sdk/esp32_3.3.10'));
  for (const name of ['ctags@5.8.0', 'esptool_py@5.3.0']) copy(path.join(buildInputs, 'tools', name), path.join(appData, 'tools', name));
  for (const name of ['esp-x32@14.2.0', 'esp32s3-libs@3.3.10']) copy(path.join(sourceAppData, 'tools', name), path.join(appData, 'tools', name));
  for (const [name, version] of Object.entries(json(path.join(board, 'package.json')).boardDependencies)) {
    const candidates = [buildInputs, sourceAppData].map(base => path.join(base, 'node_modules', name));
    const source = candidates.find(p => fs.existsSync(path.join(p, 'package.json')) && json(path.join(p, 'package.json')).version === version);
    assert.ok(source, `Missing board dependency ${name}@${version}`); copy(source, path.join(appData, 'node_modules', name));
  }
  const builderSource = path.join(buildInputs, 'npm-global');
  // Builder package is independent from the Chat app installation directory.
  for (const name of fs.readdirSync(builderSource)) if (name !== 'app') fs.cpSync(path.join(builderSource, name), path.join(appData, 'npm-global', name), { recursive: true, dereference: true });
  }
  if (process.env.AILY_SERIAL_REPLAY_SESSION) serialFixture = prepareSerialReplay({
    root, codes, appData, sourceAppData, sessionFile: process.env.AILY_SERIAL_REPLAY_SESSION,
  });
  console.log('PHASE=launch');
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  await renderer.start({ rootDirectory: path.join(repo, 'dist/aily-blockly/browser') });
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(root, 'profile')}`], cwd: repo,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, PI_CODING_AGENT_DIR: path.join(root, 'agent-state') }, timeout: 60000 });
  await app.context().route('http://localhost:4200/**', route => route.fulfill({ status: 302, headers: { location: renderer.rendererUrl('/main/guide') } }));
  for (let i = 0; i < 240 && !page; i++) {
    for (const win of app.windows()) if (await win.locator('app-main-window').count().catch(() => 0)) { page = win; break; }
    if (!page) await sleep(250);
  }
  assert.ok(page, 'Host main window');
  await app.evaluate((_, cache) => { process.env.AILY_BUILDER_PATH = cache; }, path.join(root, 'builder-cache'));
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(renderer.rendererUrl('/main/guide'));
  await page.waitForFunction(() => !!document.querySelector('app-header') && !!window.ng?.getComponent);
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click(); };
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss();
    for (const selector of ['app-header', 'app-guide', 'app-main-window']) {
      const component = window.ng.getComponent(document.querySelector(selector));
      if (component?.projectService?.projectOpen) { window.acceptanceProject = component.projectService; break; }
    }
  });
  await open(project);
  const req = createRequire(path.join(agent, 'package.json'));
  const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = req('@modelcontextprotocol/sdk/client/stdio.js');
  const chat = path.join(linked.chatRoot, 'dist/aily-chat');
  const transport = new StdioClientTransport({ command: path.join(repo, 'child/node/node.exe'), args: [path.join(chat, 'runtime/mcp/cli.js')], cwd: project,
    env: { ...env, AILY_PORTABLE_ROOT: chat, PI_PACKAGE_DIR: path.join(chat, 'runtime/pi-package'), PI_CODING_AGENT_DIR: path.join(root, 'agent-state'), AILY_APPDATA_PATH: appData }, stderr: 'pipe' });
  client = new Client({ name: 'grok-regression', version: '1.0.0' }); await client.connect(transport); transport.stderr?.on('data', () => {});
  if (!resumed) {
  await call('abs_export');
  const installed = await call('lib_add', { packages: ['@aily-project/lib-grok-eyes@2.2.1'] });
  assert.ok(installed.generation && installed.absFile, 'Library lifecycle must return synchronized ABS context');
  const source = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(JSON.parse).flatMap(row => Array.isArray(row.message?.content) ? row.message.content : []).find(part => part.name === 'abs_apply').arguments.abs;
  const abs = source.replace(/logic_boolean\(TRUE\)/g, 'logic_boolean(true)').replace(/logic_boolean\(FALSE\)/g, 'logic_boolean(false)')
    .replace('"480", "480", "-1", "-1", "-1", "-1", "-1", "-1", "-1"', '"480", "480", "-1", "-1", "17", "45", "-1", "7", "-1"');
  report.candidateCorrections = ['core-logic lowercase boolean values', 'hidden SPI SCLK/CS/RST matched to OJoy displayConfig (17/45/7)'];
  const exported = await call('abs_export');
  const before = fs.readFileSync(path.join(project, 'package.json'), 'utf8');
  await call('abs_validate', { abs, generation: exported.generation });
  assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), before, 'Validation must not write project macros');
  await call('abs_apply', { abs, generation: exported.generation });
  }
  report.generatedMacros = json(path.join(project, 'package.json')).MACROS;
  assert.ok(Array.isArray(report.generatedMacros), 'ABS apply did not publish generated project macros; inspect its warnings');
  assert.ok(report.generatedMacros.some(([v]) => v === 'CH13613_DRIVER'));
  assert.ok(report.generatedMacros.some(([v]) => v === 'TFT_WIDTH=480'));
  if (!clearBeforeSend) await call('project_build');
  const sketch = fs.readFileSync(path.join(project, '.temp/sketch/sketch.ino'), 'utf8');
  assert.match(sketch, /grokEyes\s+eyes/);
  assert.match(sketch, /switch\s*\(mood\)/);
  assert.match(sketch, /grok_eyes_wait\(eyes,/);
  report.compiledSketch = { path: path.join(project, '.temp/sketch/sketch.ino'), bytes: Buffer.byteLength(sketch) };
  console.log(clearBeforeSend ? 'PASS=prior-replay-retained' : 'PASS=original-session-replay-and-build');
  if (serialFixture) {
    report.serialReplay = await replaySerialSession(serialFixture, { page, open, call });
    save(resultFile, report); console.log('PASS=second-session-replay-and-build');
  }
  // Fresh empty project: same prompt, no replay code in the model context.
  const llmProject = path.join(root, clearBeforeSend ? `cleared-agent-project-${Date.now()}` : 'agent-project'); fs.mkdirSync(llmProject);
  fs.cpSync(path.join(project, 'node_modules'), path.join(llmProject, 'node_modules'), { recursive: true });
  for (const name of ['@aily-project/lib-grok-eyes', '@aily-project/lib-tft-espi']) {
    fs.copyFileSync(path.join(byName.get(name), 'readme_ai.md'), path.join(llmProject, 'node_modules', name, 'readme_ai.md'));
  }
  save(path.join(llmProject, 'package.json'), pkg);
  fs.copyFileSync(path.join(clearBeforeSend ? project : path.join(board, 'template'), 'project.abi'), path.join(llmProject, 'project.abi'));
  await open(llmProject);
  if (clearBeforeSend) {
    report.clearBeforeSend = await clearWorkspaceForAgent(page, llmProject, root);
    const exported = await call('abs_export', { project: llmProject });
    const emptyAbs = fs.readFileSync(path.join(llmProject, 'project.abs'), 'utf8');
    assert.deepEqual(emptyAbs.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')),
      ['arduino_global()', 'arduino_setup()', 'arduino_loop()']);
    fs.writeFileSync(path.join(root, 'before-send.abs'), emptyAbs);
    report.clearBeforeSend.generation = exported.generation;
    save(resultFile, report); console.log('PASS=workspace-cleared-and-empty-abs-verified');
  }
  await client.close(); client = undefined;
  report.chat = await testLinkedChat(page, root, linked.chatRoot);
  const element = await page.locator('app-main-window nz-sider app-child-tool-host iframe').elementHandle();
  const frame = await element.contentFrame(), url = new URL(frame.url());
  e2e = async (method, args = {}) => {
    const response = await fetch(new URL('/api/agent/e2e', url), { method: 'POST', headers: { authorization: `Bearer ${url.searchParams.get('token')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'aily-agent-e2e', version: 4, method, ...args }), signal: AbortSignal.timeout(15000) });
    const value = await response.json(); assert.equal(value.ok, true); return value.result;
  };
  await frame.locator('.aily-chat-composer-input[role="textbox"]').fill('帮我写一个grokbot表情显示的程序，随机显示各种表情动画。');
  await frame.locator('button.primary-action.send-action').click();
  console.log('PHASE=autonomous-agent');
  const deadline = Date.now() + 15 * 60000; let last = '';
  while (Date.now() < deadline) {
    const sessions = (await e2e('session.list')).sessions;
    sessionId ??= sessions.find(s => path.resolve(s.cwd).toLowerCase() === path.resolve(llmProject).toLowerCase())?.sessionId;
    if (sessionId) {
      const snapshot = (await e2e('session.read', { sessionId })).session;
      save(path.join(root, 'agent-observation.json'), snapshot);
      const status = JSON.stringify({ phase: snapshot.phase, idle: snapshot.isIdle, tools: snapshot.toolExecutions.map(t => ({ name: t.toolName, status: t.status })) });
      if (status !== last) { console.log(status); last = status; }
      if (snapshot.isIdle && snapshot.messages.some(m => m.role === 'assistant') && snapshot.toolExecutions.length) {
        report.agent = { project: llmProject, sessionId, tools: snapshot.toolExecutions, messages: snapshot.messages }; break;
      }
    }
    await sleep(3000);
  }
  assert.ok(report.agent, 'Agent did not finish before the acceptance deadline');
  assert.ok(report.agent.tools.some(t => t.toolName === 'abs_apply' && t.status === 'success'), 'Agent did not successfully apply ABS');
  assert.ok(report.agent.tools.some(t => t.toolName === 'project_build' && t.status === 'success'), 'Agent did not successfully compile the project');
  await page.screenshot({ path: path.join(root, 'agent-final.png'), fullPage: true });
  linked.assertSourceUnchanged(); report.originalProfileUnchanged = true;
}
main().catch(async error => {
  report.failure = error.stack; console.error(error.message); process.exitCode = 1;
  if (app && page) try {
    const pid = await app.evaluate(() => process.pid);
    const bridge = json(path.join(require('node:os').homedir(), '.aily-blockly/cli-bridge', `${pid}.json`));
    const response = await fetch(`http://127.0.0.1:${bridge.port}/command`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: bridge.token, action: 'blockly-live-operation', operation: 'app_info', params: {} }), signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    report.hostDebug = { pid, status: response.status, ok: body.ok, keys: Object.keys(body), developmentMode: body.developmentMode, error: body.error,
      pageState: await page.evaluate(() => ({ url: location.pathname, text: document.body.innerText.slice(-1000) })) };
  } catch (probeError) { report.hostDebug = { error: probeError.message }; }
}).finally(async () => {
  save(resultFile, report); await client?.close().catch(() => {});
  if (page) await page.evaluate(async () => { await window.acceptanceProject?.close(); }).catch(() => {});
  if (app) await app.close().catch(() => {});
  await renderer.close(); linked?.dispose(); console.log('REPORT=' + resultFile);
});
