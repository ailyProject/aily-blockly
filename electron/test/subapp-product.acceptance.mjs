import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectAgent } from './fixtures/subapp-product-agent.mjs';
import { createProductModel } from './fixtures/subapp-product-model.mjs';
import { installSimulatorFixture, verifySimulatorProduct } from './fixtures/simulator-product-scenarios.mjs';
import { readSimulatorLiveOptions, verifySimulatorLive } from './fixtures/simulator-live-scenarios.mjs';
import { installSimulatorProjects } from './fixtures/simulator-product-projects.mjs';

const hostRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const serialRoot = path.resolve(process.env.SERIAL_PRODUCT_ROOT || path.join(hostRoot, '../aily-subapp/packages/serial-debugger'));
const chatRoot = path.resolve(process.env.CHAT_PRODUCT_ROOT || path.join(hostRoot, '../aily-lex-pro/packages/aily-chat'));
const agentRoot = path.resolve(chatRoot, '../aily-agent');
const developmentMode = process.env.AILY_PRODUCT_MODE || 'blockly';
const liveOptions = readSimulatorLiveOptions();
assert.ok(['blockly', 'coder'].includes(developmentMode));
const requireHost = createRequire(path.join(hostRoot, 'package.json'));
const requireSerial = createRequire(path.join(serialRoot, 'package.json'));
const { _electron, expect } = requireHost('@playwright/test');
const { startSerialDebuggerServer } = requireSerial('./server');
const { FakeSerialPort } = requireSerial('./test/fake-serial-port');
const { appCommand } = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/services/app/command.js')));
const { SubappAgentSession } = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/subapp-agent-session.js')));
const { verifyPortableBuild } = await import(pathToFileURL(path.join(chatRoot, 'server/portable-integrity.ts')));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'subapp-product-'));
const stage = path.join(output, 'app');
const appdata = path.join(output, 'appdata');
const report = { output, checks: [], hardware: 'simulated', product: `full-${developmentMode}-production-renderer` };
const log = fs.createWriteStream(path.join(output, 'process.log'));
const redact = value => liveOptions ? String(value).replaceAll(liveOptions.accessToken, '[redacted]') : String(value);
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, redact(JSON.stringify(value, null, 2))); };
const junction = (target, destination) => { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir'); };
let application, runtime, catalog, main, agent, model;
const scopes = [];
const writes = [];

async function until(probe, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const renderer = path.join(hostRoot, 'dist/aily-blockly/browser');
  const chat = path.join(chatRoot, 'dist/aily-chat');
  for (const file of [path.join(renderer, 'index.html'), path.join(chat, 'package.json'), path.join(serialRoot, 'dist/serial-debugger/ui/index.html')]) {
    assert.ok(fs.existsSync(file), `Build the workspace artifact first: ${file}`);
  }
  report.chatBuild = await verifyPortableBuild(chat);
  // Copy main-process code, but never copy dependency trees, user state or caches.
  fs.cpSync(path.join(hostRoot, 'electron'), path.join(stage, 'electron'), { recursive: true,
    filter: source => !path.relative(path.join(hostRoot, 'electron'), source).split(path.sep).some(part => ['node_modules', 'test', 'tests'].includes(part)) });
  junction(path.join(hostRoot, 'node_modules'), path.join(stage, 'node_modules'));
  if (fs.existsSync(path.join(hostRoot, 'electron/node_modules'))) junction(path.join(hostRoot, 'electron/node_modules'), path.join(stage, 'electron/node_modules'));
  junction(path.join(hostRoot, 'child'), path.join(stage, 'child'));
  junction(renderer, path.join(stage, 'renderer'));
  fs.copyFileSync(path.join(hostRoot, 'electron/test/fixtures/subapp-product-bootstrap.cjs'), path.join(stage, 'electron/bootstrap.cjs'));
  const metadata = JSON.parse(fs.readFileSync(path.join(hostRoot, 'package.json')));
  writeJson(path.join(stage, 'package.json'), { ...metadata, main: 'electron/bootstrap.cjs' });

  FakeSerialPort.reset();
  FakeSerialPort.ports = ['PRODUCT_A', 'PRODUCT_B'].map((name, index) => ({ path: name, serialNumber: `fixture-${index}`, vendorId: 'FFFF', productId: '0001' }));
  FakeSerialPort.onWrite = (port, data) => {
    writes.push({ port: port.path, text: String(data) });
    queueMicrotask(() => port.receive(`${port.path}:${data}`));
  };
  runtime = await startSerialDebuggerServer({ runtimeRoot: path.join(output, 'serial'),
    runtimeConfig: { dtrOnOpen: false }, SerialPortClass: FakeSerialPort,
    uiRoot: path.join(serialRoot, 'dist/serial-debugger/ui') });
  const descriptorFile = path.join(output, 'runtime.json');
  writeJson(descriptorFile, { mode: 'serve', url: runtime.url, origin: runtime.origin, wsUrl: runtime.wsUrl,
    port: runtime.port, sessionId: runtime.core.sessionId });
  const serialFixture = path.join(output, 'serial-fixture');
  const serialManifest = JSON.parse(fs.readFileSync(path.join(serialRoot, 'package.json')));
  writeJson(path.join(serialFixture, 'package.json'), { ...serialManifest, main: 'index.cjs', aily: { uiIndex: 'ui/index.html' } });
  fs.copyFileSync(path.join(hostRoot, 'electron/test/fixtures/subapp-product-runtime.cjs'), path.join(serialFixture, 'index.cjs'));
  for (const dir of ['agent', 'skill', 'i18n']) fs.cpSync(path.join(serialRoot, dir), path.join(serialFixture, dir), { recursive: true });
  junction(path.join(serialRoot, 'dist/serial-debugger/ui'), path.join(serialFixture, 'ui'));
  const appRoot = path.join(appdata, 'npm-global/app');
  junction(serialFixture, path.join(appRoot, 'node_modules/@aily-project/subapp-serial-debugger'));
  junction(chat, path.join(appRoot, 'node_modules/@aily-project/subapp-aily-chat'));
  const chatManifest = JSON.parse(fs.readFileSync(path.join(chat, 'package.json')));
  const index = { dev: true };
  for (const [id, manifest] of [['serial-debugger', serialManifest], ['aily-chat', chatManifest]]) {
    index[id] = { id, namespace: id.replaceAll('-', '_').toUpperCase(), titleKey: id,
      package: manifest.name, version: manifest.version, app: { ...manifest.ailySubapp.app, autoInstall: false } };
  }
  const simulator = installSimulatorFixture({ hostRoot, appRoot, index, junction });
  const projectFixture = await installSimulatorProjects({ hostRoot, appRoot, index, output, developmentMode, writeJson });
  const projects = projectFixture?.projects;
  assert.ok(!projects || simulator && !liveOptions, 'Lifecycle acceptance requires deterministic Simulator product fixtures');
  writeJson(path.join(appRoot, 'subapp-index.json'), index);
  writeJson(path.join(appRoot, 'package.json'), { name: 'isolated-subapp-acceptance', private: true, dependencies: {
    [serialManifest.name]: serialManifest.version, [chatManifest.name]: chatManifest.version,
    ...(simulator ? { [simulator.manifest.name]: simulator.manifest.version } : {}) } });
  catalog = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('access-control-allow-origin', request.headers.origin || '*');
    response.setHeader('access-control-allow-headers', '*');
    if (request.method === 'OPTIONS') { response.end(); return; }
    if (projectFixture?.serve(request, response)) return;
    const body = request.url === '/subapp-index.json' ? index : {
      status: 200, data: { id: 'isolated-fixture', nickname: 'Subapp acceptance', groups: [], quota_info: [] }
    };
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => catalog.listen(0, '127.0.0.1', resolve));
  const fixtureOrigin = `http://127.0.0.1:${catalog.address().port}`;
  // Default authentication stays local. Live mode explicitly pairs an existing
  // access token with its configured region, without refresh or user-state edits.
  const configPath = path.join(stage, 'electron/config/config.json');
  const config = JSON.parse(fs.readFileSync(configPath));
  if (!liveOptions) for (const region of Object.values(config.regions || {})) region.api_server = fixtureOrigin;
  else {
    config.region = liveOptions.region;
    config.regions[liveOptions.region] = liveOptions.regionConfig;
  }
  config.project_path = path.join(output, 'projects');
  if (projectFixture) {
    config.resource_source = 'auto';
    config.resource_sources = [{ key: 'fixture', url: fixtureOrigin, enabled: true }];
    for (const region of Object.values(config.regions || {})) region.resource = fixtureOrigin;
    fs.writeFileSync(path.join(output, 'npmrc'), `registry=${fixtureOrigin}\n@aily-project:registry=${fixtureOrigin}\naudit=false\nfund=false\nupdate-notifier=false\n`);
  }
  writeJson(configPath, config);
  const authPath = path.join(appdata, `auth/${developmentMode}.json`);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ access_token: liveOptions?.accessToken || 'isolated-fixture-token' }), { mode: 0o600 });
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  const testHome = path.join(output, 'home'); fs.mkdirSync(testHome);
  application = await _electron.launch({ executablePath: requireHost('electron'), cwd: stage,
    args: [stage, `--user-data-dir=${path.join(output, 'profile')}`], timeout: 60000,
    env: { ...env, ...(process.platform === 'win32' ? { USERPROFILE: testHome } : { HOME: testHome }),
      AILY_E2E: '1', AILY_APPDATA_PATH: appdata, AILY_PRODUCT_ACCEPTANCE_ROOT: output,
      AILY_BUILD_PRODUCT: developmentMode,
      AILY_SUBAPP_INSTALL_ROOT: appRoot,
      AILY_PRODUCT_RUNTIME_DESCRIPTOR: descriptorFile,
      AILY_SUBAPP_INDEX_URL: `http://127.0.0.1:${catalog.address().port}/subapp-index.json`,
      ...(projectFixture ? { AILY_NPM_REGISTRY: fixtureOrigin, NPM_CONFIG_REGISTRY: fixtureOrigin,
        NPM_CONFIG_USERCONFIG: path.join(output, 'npmrc'), NPM_CONFIG_CACHE: path.join(output, 'npm-cache') } : {}),
      AILY_AGENT_HOME: path.join(output, 'agent-home'), PI_CODING_AGENT_DIR: path.join(output, 'agent-home') } });
  const child = application.process();
  child.stdout?.on('data', data => log.write(redact(data))); child.stderr?.on('data', data => log.write(redact(data)));
  report.launcherPid = child.pid;
  report.pid = await application.evaluate(() => process.pid);
  const discoveryPath = path.join(testHome, '.aily-blockly/cli-bridge', `${report.pid}.json`);
  const target = await until(() => fs.existsSync(discoveryPath) && JSON.parse(fs.readFileSync(discoveryPath)), 'test-owned CLI bridge');
  const command = (operation, params = {}, { path: projectPath, timeoutMs = 30000 } = {}) =>
    appCommand('blockly-live-operation', undefined, { operation, params, ...(projectPath ? { path: projectPath } : {}) }, { target, timeoutMs });
  main = await until(async () => {
    for (const page of application.windows()) if (await page.locator('app-main-window').count().catch(() => 0)) return page;
  }, 'full main renderer', 45000);
  // First-run guides can appear after project-ready. Dismiss through their
  // normal button whenever they would intercept a real user interaction.
  await main.addLocatorHandler(main.getByText('跳过', { exact: true }), locator => locator.click());
  main.on('console', message => log.write(redact(`[renderer:${message.type()}] ${message.text()}\n`)));
  main.on('pageerror', error => log.write(redact(`[renderer:error] ${error.stack}\n`)));
  report.mainUrl = main.url();
  const listed = await until(async () => {
    const result = await command('child_app_list');
    return result.ok && JSON.stringify(result).includes('serial-debugger') && result;
  }, 'installed serial manifest discovery');
  writeJson(path.join(output, 'discovery.json'), listed);
  report.checks.push('full-host-manifest-discovery');
  const chatOpened = await command('child_app_open', { toolId: 'aily-chat', mode: 'embedded' });
  assert.equal(chatOpened.ok, true, JSON.stringify(chatOpened));
  await expect(main.locator('app-child-tool-host iframe').first()).toBeVisible({ timeout: 30000 });
  await main.screenshot({ path: path.join(output, 'chat.png') });
  report.checks.push('current-chat-loaded-in-full-host');
  let chatFrame = await until(() => main.frames().find(frame => frame.parentFrame() && frame.url().includes('token=')), 'Chat frame');
  const chatUrl = new URL(chatFrame.url());
  const wsUrl = new URL('/ws', chatUrl); wsUrl.protocol = 'ws:'; wsUrl.search = chatUrl.search;
  agent = await connectAgent(requireHost('ws'), wsUrl.href);
  const { cwd: workspace } = await agent.call({ type: 'workspace.resolve', mode: 'global' });
  assert.ok(path.resolve(workspace).startsWith(output + path.sep), 'Chat workspace must remain test-owned');
  fs.mkdirSync(workspace, { recursive: true });
  const tools = await agent.call({ type: 'tools.list', cwd: workspace });
  const skills = await agent.call({ type: 'skills.snapshot', cwd: workspace });
  writeJson(path.join(output, 'agent-discovery.json'), { tools, skills });
  assert.ok(JSON.stringify(tools).includes('serial_session_manage'), 'Actual Chat must discover serial tools');
  assert.ok(JSON.stringify(skills).includes('serial-device-debugger'), 'Actual Chat must discover serial skill');
  report.checks.push('chat-agent-tools-and-skill-discovery');
  const skip = main.getByText('跳过', { exact: true });
  if (await skip.isVisible()) await skip.click();
  if (liveOptions) {
    await verifySimulatorLive({ fixture: simulator, liveOptions, agent, workspace, developmentMode,
      until, writeJson, output, report, main, chatFrame });
  } else {
  const sessions = [];
  for (const name of ['Product session A', 'Product session B']) {
    const { snapshot } = await agent.call({ type: 'session.create', options: { cwd: workspace, developmentMode } });
    await agent.call({ type: 'setName', sessionId: snapshot.sessionId, name });
    const scope = new SubappAgentSession((operation, params, options) => appCommand('blockly-live-operation', undefined,
      { operation, params }, { ...options, target }));
    scopes.push(scope);
    sessions.push({ sessionId: snapshot.sessionId, name, scope });
  }
  // Reload through the normal UI bootstrap to refresh the persisted global list.
  await chatFrame.goto(chatFrame.url());
  const resize = main.locator('nz-sider .toolbox-pane__resize-handle--left');
  const bounds = await resize.boundingBox(); assert.ok(bounds);
  await main.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await main.mouse.down(); await main.mouse.move(bounds.x - 500, bounds.y + bounds.height / 2, { steps: 15 }); await main.mouse.up();
  await chatFrame.getByText(sessions[0].name, { exact: true }).filter({ visible: true }).first().click();
  await expect(chatFrame.locator('.chat-session-sidebar')).toBeVisible();
  const invoke = async (session, tool, params) => {
    const result = await session.scope.call({ toolId: 'serial-debugger', tool, params, sessionId: session.sessionId });
    assert.equal(result.ok, true, JSON.stringify(result));
    const bytes = Buffer.byteLength(JSON.stringify(result));
    report.maxToolResponseBytes = Math.max(report.maxToolResponseBytes || 0, bytes);
    assert.ok(bytes <= 49152, 'Tool evidence must remain bounded');
    return result;
  };
  const a = await invoke(sessions[0], 'serial_session_manage', { action: 'open', portPath: 'PRODUCT_A', baudRate: 115200, label: 'Product A' });
  writeJson(path.join(output, 'opened-a.json'), a);
  await expect(main.locator('.subapp-dock')).toBeVisible({ timeout: 30000 });
  await expect(chatFrame.locator('.chat-session-sidebar')).toBeHidden();
  const b = await invoke(sessions[1], 'serial_session_manage', { action: 'open', portPath: 'PRODUCT_B', baudRate: 115200, label: 'Product B' });
  writeJson(path.join(output, 'opened-b.json'), b);
  report.checks.push('two-agent-scopes-open-two-ports', 'dock-auto-opens-in-current-chat');
  const transact = (session, channelId, data) => invoke(session, 'serial_transact', {
    channelId, send: { mode: 'text', data }, expect: { type: 'text', value: data }, timeoutMs: 1000, quietMs: 10
  });
  await Promise.all([transact(sessions[0], a.result.channelId, 'nonce-A'), transact(sessions[1], b.result.channelId, 'nonce-B')]);
  const ambiguous = await sessions[0].scope.call({ toolId: 'serial-debugger', tool: 'serial_transact',
    params: { send: { mode: 'text', data: 'MUST-NOT-SEND' } }, sessionId: sessions[0].sessionId });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.errorCode, 'SERIAL_CHANNEL_AMBIGUOUS');
  assert.ok(!writes.some(item => item.text === 'MUST-NOT-SEND'));
  report.checks.push('parallel-directed-echo', 'ambiguous-send-rejected');
  const compactFrame = () => until(() => main.frames().find(frame => frame.url().includes('surface=compact')), 'compact frame');
  let compact = await compactFrame();
  await expect(compact.getByRole('tab')).toHaveCount(2, { timeout: 30000 });
  await compact.getByRole('tab', { name: /Product A/ }).click();
  await expect(compact.locator('.compact-log')).toContainText('PRODUCT_A:nonce-A');
  await expect(compact.locator('.compact-log')).not.toContainText('nonce-B');
  await main.screenshot({ path: path.join(output, 'dock-a.png') });
  await main.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(chatFrame.locator('.chat-session-sidebar')).toBeVisible();
  await chatFrame.getByText(sessions[1].name, { exact: true }).filter({ visible: true }).first().click();
  await expect(main.locator('.subapp-dock')).toBeVisible();
  await expect(chatFrame.locator('.chat-session-sidebar')).toBeHidden();
  compact = await compactFrame();
  await compact.getByRole('tab', { name: /Product B/ }).click();
  await expect(compact.locator('.compact-log')).toContainText('PRODUCT_B:nonce-B');
  await expect(compact.locator('.compact-log')).not.toContainText('nonce-A');
  const baudFits = await compact.locator('.is-baud select').evaluate(select => {
    const context = document.createElement('canvas').getContext('2d');
    context.font = getComputedStyle(select).font;
    return select.clientWidth >= context.measureText(select.selectedOptions[0].text).width + 20;
  });
  assert.equal(baudFits, true, 'Baud rate must fit alongside the native select arrow');
  report.checks.push('compact-baud-readable-in-narrow-dock');
  report.checks.push('compact-channel-rx-isolation', 'chat-session-switch-and-sidebar-restore');
  await main.screenshot({ path: path.join(output, 'dock-b.png') });
  await sessions[0].scope.close();
  const stateA = runtime.core.status({ channelId: a.result.channelId });
  const stateB = runtime.core.status({ channelId: b.result.channelId });
  assert.equal(stateA.connected, false); assert.equal(stateB.connected, true);
  assert.equal(stateB.connectedAt, b.result.connectedAt);
  await transact(sessions[1], b.result.channelId, 'after-release-A');
  await expect(compact.locator('.compact-log')).toContainText('PRODUCT_B:after-release-A');
  report.checks.push('release-one-owner-keeps-other-channel-connected');
  await main.getByRole('button', { name: 'Open full subapp', exact: true }).click();
  const embeddedFull = await until(() => main.frames().find(frame => frame.url().startsWith(runtime.origin)
    && !frame.url().includes('surface=compact')), 'embedded Full frame');
  await embeddedFull.getByRole('tab', { name: /Product B/ }).click();
  await expect(embeddedFull.locator('.data-list')).toContainText('PRODUCT_B:after-release-A');
  report.checks.push('dock-opens-full-embedded-ui');
  const detached = await command('child_app_control', { toolId: 'serial-debugger', action: 'detach' });
  assert.equal(detached.ok, true, JSON.stringify(detached));
  const serialWindow = await until(async () => {
    for (const page of application.windows()) if (page !== main && page.url().includes('child-tool/serial-debugger')) return page;
  }, 'independent Serial window');
  const full = await until(() => serialWindow.frames().find(frame => frame.url().startsWith(runtime.origin)), 'full Serial frame');
  await full.getByRole('tab', { name: /Product B/ }).click();
  await expect(full.locator('.data-list')).toContainText('PRODUCT_B:after-release-A');
  assert.equal(runtime.core.status({ channelId: b.result.channelId }).ownerCount, 1, 'Observing Full UI must not retain the port');
  await serialWindow.screenshot({ path: path.join(output, 'independent-full.png') });
  await serialWindow.getByRole('button', { name: 'Close', exact: true }).click();
  await until(() => serialWindow.isClosed(), 'independent window close');
  assert.equal(runtime.core.status({ channelId: b.result.channelId }).connected, true);
  await transact(sessions[1], b.result.channelId, 'after-window-close');
  report.checks.push('full-window-shares-runtime-without-owning-port', 'window-close-keeps-agent-channel');
  await sessions[1].scope.close();
  assert.equal(runtime.core.status({ channelId: b.result.channelId }).connected, false);
  report.checks.push('last-owner-releases-final-port');
  // Actual Chat-owned sessions now drive tool_load/tool_invoke through a local
  // deterministic model. No test adapter closes these owners on Chat's behalf.
  model = await createProductModel();
  model.plan('A', { channelId: a.result.channelId, port: 'PRODUCT_A' });
  model.plan('B', { channelId: b.result.channelId, port: 'PRODUCT_B' });
  const { settings } = await agent.call({ type: 'settings.snapshot', cwd: workspace });
  await agent.call({ type: 'settings.save', cwd: workspace, settings: { ...settings, customModels: [{
    model: 'subapp-fixture', name: 'Subapp fixture', enabled: true, isCustom: true,
    baseUrl: model.baseUrl, type: 'openai-compatible', apiKey: 'test-only'
  }] } });
  const { models } = await agent.call({ type: 'models.refresh', cwd: workspace });
  writeJson(path.join(output, 'models.json'), models);
  const customModel = models.find(item => item.id === 'subapp-fixture'); assert.ok(customModel);
  const chatOwned = [];
  for (const marker of ['A', 'B']) {
    const { snapshot } = await agent.call({ type: 'session.create', options: { cwd: workspace, developmentMode,
      model: { provider: customModel.provider, id: customModel.id }, permissionMode: 'full' } });
    chatOwned.push(snapshot.sessionId);
    await agent.call({ type: 'prompt', sessionId: snapshot.sessionId, idempotencyKey: `product-${marker}`,
      text: `PRODUCT-FIXTURE:${marker} Run the serial test through the available tools.`, mode: 'agent' });
    await until(async () => {
      const result = await agent.call({ type: 'session.snapshot', sessionId: snapshot.sessionId });
      writeJson(path.join(output, `chat-owned-${marker}.json`), result);
      return result.isIdle && JSON.stringify(result.messages).includes(`PRODUCT-FIXTURE:${marker} complete`);
    }, `Chat-owned tool sequence ${marker}`, 45000);
  }
  writeJson(path.join(output, 'model-evidence.json'), { requests: model.requests, errors: model.errors });
  assert.deepEqual(model.errors, []);
  for (const channelId of [a.result.channelId, b.result.channelId]) {
    const status = runtime.core.status({ channelId }); assert.equal(status.connected, true); assert.equal(status.ownerCount, 1);
  }
  assert.ok(model.requests.some(item => item.lastToolResult.includes('PRODUCT_A:chat-owned-A')));
  assert.ok(model.requests.some(item => item.lastToolResult.includes('PRODUCT_B:chat-owned-B')));
  report.checks.push('actual-chat-tool-load-invoke-and-echo');
  if (simulator) await verifySimulatorProduct({ fixture: simulator, projects, agent, model, customModel, workspace, developmentMode,
    until, writeJson, output, application, report, main, chatFrame, command, verifySerial: async () => {
      for (const channelId of [a.result.channelId, b.result.channelId]) {
        const status = runtime.core.status({ channelId });
        assert.equal(status.connected, true); assert.equal(status.ownerCount, 1);
      }
    } });
  const connectedAtB = runtime.core.status({ channelId: b.result.channelId }).connectedAt;
  const closeStarted = performance.now();
  await agent.call({ type: 'session.close', sessionId: chatOwned[0] });
  assert.equal(runtime.core.status({ channelId: a.result.channelId }).connected, false);
  assert.equal(runtime.core.status({ channelId: b.result.channelId }).connectedAt, connectedAtB);
  assert.equal(runtime.core.status({ channelId: b.result.channelId }).connected, true);
  report.chatFirstOwnerCloseMs = Math.round(performance.now() - closeStarted);
  model.waitForClose('B', b.result.channelId);
  await agent.call({ type: 'prompt', sessionId: chatOwned[1], idempotencyKey: 'product-close-in-flight',
    text: 'PRODUCT-FIXTURE:B Start a pending serial transaction for the close test.', mode: 'agent' });
  await until(() => writes.some(item => item.port === 'PRODUCT_B' && item.text === 'await-session-close'), 'Chat pending transaction');
  const pendingCloseStarted = performance.now();
  await agent.call({ type: 'session.close', sessionId: chatOwned[1] });
  assert.equal(runtime.core.status({ channelId: b.result.channelId }).connected, false);
  report.chatPendingOwnerCloseMs = Math.round(performance.now() - pendingCloseStarted);
  assert.ok(report.chatPendingOwnerCloseMs < 10000, 'Closing must cancel work rather than wait for its 30-second timeout');
  writeJson(path.join(output, 'model-evidence.json'), { requests: model.requests, errors: model.errors });
  assert.deepEqual(model.errors, []);
  report.checks.push('actual-chat-close-releases-only-its-owner', 'actual-chat-close-cancels-in-flight-transaction');
  report.visibleChat = await chatFrame.locator('body').innerText();
  }
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack || error.message; process.exitCode = 1;
  if (model) writeJson(path.join(output, 'model-evidence.json'), { requests: model.requests, errors: model.errors });
  if (main && !main.isClosed()) {
    await main.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    report.visibleText = await main.locator('body').innerText().catch(() => 'unavailable');
    report.frameText = await Promise.all(main.frames().filter(frame => frame.parentFrame()).map(frame => frame.locator('body').innerText().catch(() => 'unavailable')));
  }
} finally {
  const cleanup = async (name, release) => {
    try { await release(); } catch (error) {
      report.ok = false; process.exitCode = 1;
      (report.cleanupErrors ||= []).push({ name, error: error.message });
    }
  };
  for (const scope of scopes) await cleanup('adapter owner', () => scope.close());
  await cleanup('Chat transport', () => agent?.close());
  if (application) {
    await application.evaluate(({ app }) => app.quit()).catch(() => {});
    await cleanup('Electron', () => application.close());
  }
  await cleanup('Serial Runtime', () => runtime?.stop());
  await cleanup('Model fixture', () => model?.close());
  if (catalog) await cleanup('Catalog fixture', async () => {
    catalog.closeAllConnections(); await new Promise(resolve => catalog.close(resolve));
  });
  if (liveOptions) await cleanup('Isolated access token', async () => {
    // Exact test-owned files only; never remove the input credential file.
    const authDirectory = path.resolve(appdata, 'auth');
    assert.ok(authDirectory.startsWith(path.resolve(output) + path.sep));
    for (const name of [`${developmentMode}.json`, `${developmentMode}-migration.json`]) {
      fs.rmSync(path.join(authDirectory, name), { force: true });
    }
  });
  await new Promise(resolve => log.end(resolve));
  writeJson(path.join(output, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2));
}
