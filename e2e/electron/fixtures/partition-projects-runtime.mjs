import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectAgent } from './subapp-product-agent.mjs';

// Real host dev renderer on port 4200, with isolated profile, project and Agent state.
// Existing authenticated account files are copied privately for real model requests.
// The FFS wrapper only controls process ownership; its backend/UI are product code.
const hostRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const ffsRoot = path.resolve(process.env.FFS_PRODUCT_ROOT || path.join(hostRoot, '../../ZCK/aily-subapp/packages/ffs-manager'));
const chatRoot = path.resolve(process.env.CHAT_PRODUCT_ROOT || path.join(hostRoot, '../../aily-lex-pro/packages/aily-agent'));
const requireHost = createRequire(path.join(hostRoot, 'package.json'));
const requireFfs = createRequire(path.join(ffsRoot, 'package.json'));
const { _electron, expect } = requireHost('@playwright/test');
const { startFfsManagerServer } = requireFfs('./server');
const { appCommand } = await import(pathToFileURL(path.join(chatRoot, 'dist/blockly/services/app/command.js')));
const { SubappAgentSession } = await import(pathToFileURL(path.join(chatRoot, 'dist/blockly/subapp-agent-session.js')));
const artifactRoot = path.join(hostRoot, 'e2e/.artifacts/partition-projects-20261022');
fs.mkdirSync(artifactRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(artifactRoot, 'run-'));
let testProject;
const report = { output, product: 'full-blockly-dev-renderer', checks: [] };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const link = (target, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir'); };
async function until(probe, name, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(100); }
  throw new Error('Timed out: ' + name);
}
console.log('Evidence: '+output);
let application, backend, catalog, main, agent, scope;
const logs = fs.createWriteStream(path.join(output, 'process.log'));
export async function start() {
  const stage = path.join(output, 'app'), appdata = process.env.PARTITION_APPDATA_REUSE || path.join(output, 'appdata'), appRoot = path.join(appdata, 'npm-global/app');
  if (process.env.PARTITION_APPDATA_REUSE) { assert.ok(appdata.startsWith(artifactRoot + path.sep)); fs.rmSync(appRoot,{recursive:true,force:true}); }
  fs.cpSync(path.join(hostRoot, 'electron'), path.join(stage, 'electron'), { recursive: true,
    filter: source => !path.relative(path.join(hostRoot, 'electron'), source).split(path.sep).some(part => ['node_modules', 'test', 'tests'].includes(part)) });
  link(path.join(hostRoot, 'node_modules'), path.join(stage, 'node_modules'));
  link(path.join(hostRoot, 'electron/node_modules'), path.join(stage, 'electron/node_modules'));
  link(path.join(hostRoot, 'child'), path.join(stage, 'child'));
  if (process.env.FFS_PROJECT_SEED) {
    const source = path.resolve(process.env.FFS_PROJECT_SEED);
    testProject = path.join(output, 'project');
    fs.cpSync(source, testProject, { recursive: true, dereference: true, filter: file =>
      !['.build', '.temp', '.aily', '.log', '.workspace-history'].includes(path.relative(source, file).split(path.sep)[0]) });
    const ts = requireHost('typescript');
    requireHost.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, filename);
    const { seedPlatform } = requireHost('./e2e/fixtures/platform-seed.ts');
    assert.ok(process.env.AILY_E2E_TOOLCHAIN_SEED, 'A matching isolated toolchain seed is required');
    if (!process.env.PARTITION_APPDATA_REUSE) await seedPlatform(testProject, appdata, process.env.AILY_E2E_TOOLCHAIN_SEED);
    if (!process.env.PARTITION_APPDATA_REUSE) for (const relative of ['npm-global/bin', 'npm-global/lib']) fs.cpSync(path.join(process.env.AILY_E2E_TOOLCHAIN_SEED, relative), path.join(appdata, relative), { recursive: true });
  }

  fs.copyFileSync(path.join(hostRoot, 'e2e/electron/fixtures/subapp-product-bootstrap.cjs'), path.join(stage, 'electron/bootstrap.cjs'));
  write(path.join(stage, 'package.json'), { ...requireHost('./package.json'), main: 'electron/bootstrap.cjs' });
  backend = await startFfsManagerServer();
  const descriptor = path.join(output, 'runtime.json');
  write(descriptor, { mode: 'serve', url: backend.url, origin: backend.origin, wsUrl: backend.wsUrl, port: backend.port });
  const fixture = path.join(output, 'ffs-fixture'), manifest = requireFfs('./package.json');
  write(path.join(fixture, 'package.json'), { ...manifest, main: 'index.cjs', aily: { uiIndex: 'ui/index.html' } });
  fs.copyFileSync(path.join(hostRoot, 'e2e/electron/fixtures/subapp-product-runtime.cjs'), path.join(fixture, 'index.cjs'));
  for (const dir of ['agent', 'skill', 'i18n', 'ui']) fs.cpSync(path.join(ffsRoot, dir), path.join(fixture, dir), {recursive:true});
  link(fixture, path.join(appRoot, 'node_modules/@aily-project/subapp-ffs-manager'));
  const toolId = 'ffs-manager-child';
  const index = { dev: true, [toolId]: { id: toolId, namespace: 'FFS_MANAGER', titleKey: 'FFS_MANAGER.TITLE',
    package: manifest.name, version: manifest.version, app: { ...manifest.ailySubapp.app, autoInstall: false }, ui: manifest.ailySubapp.ui } };
  {
    const chatSource = path.resolve(chatRoot, '../aily-chat');
    const chatFixture = path.join(output, 'chat-fixture');
    const chatManifest = JSON.parse(fs.readFileSync(path.join(chatSource, 'package.json')));
    // Same development source as pnpm dev, with isolated state and no dev supervisor.
    fs.mkdirSync(chatFixture);
    for (const entry of fs.readdirSync(chatSource, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'package.json') continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) link(path.join(chatSource, entry.name), path.join(chatFixture, entry.name));
      else fs.copyFileSync(path.join(chatSource, entry.name), path.join(chatFixture, entry.name));
    }
    write(path.join(chatFixture, 'package.json'), { ...chatManifest, name: '@aily-project/subapp-aily-chat' });
    link(chatFixture, path.join(appRoot, 'node_modules/@aily-project/subapp-aily-chat'));
    index['aily-chat'] = { id: 'aily-chat', namespace: 'AILY_CHAT', titleKey: 'AILY_CHAT.TITLE',
      package: '@aily-project/subapp-aily-chat', version: chatManifest.version, app: { ...chatManifest.ailySubapp.app, autoInstall: false } };
  }
  write(path.join(appRoot, 'subapp-index.json'), index);
  write(path.join(appRoot, 'package.json'), { name: 'isolated-partition-close', private: true,
    dependencies: Object.fromEntries(Object.values(index).filter(entry => entry.package).map(entry => [entry.package, entry.version])) });
  const { discoverInstalledSubappAgentCatalog } = await import(pathToFileURL(path.join(chatRoot, 'dist/blockly/subapp-agent-manifest.js')));
  const capabilities = discoverInstalledSubappAgentCatalog({installRoot:appRoot,developmentMode:'blockly'});
  write(path.join(output,'capability-preflight.json'),{tools:capabilities.tools.map(t=>t.name),diagnostics:capabilities.diagnostics});
  assert.equal(capabilities.tools.filter(t=>t.name.startsWith('partition_')).length,11,JSON.stringify(capabilities.diagnostics));
  catalog = http.createServer((req,res) => {
    res.setHeader('content-type','application/json'); res.setHeader('access-control-allow-origin',req.headers.origin || '*');
    res.setHeader('access-control-allow-headers','*');
    res.end(JSON.stringify(req.url === '/subapp-index.json' ? index : { status: 200, data: { id: 'partition-close-test', nickname: 'Acceptance', groups: [] } }));
  });
  await new Promise(resolve => catalog.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${catalog.address().port}`;
  const configPath = path.join(stage,'electron/config/config.json'), config = JSON.parse(fs.readFileSync(configPath));
  // Real account and production project plaza; catalog server only supplies isolated subapps.
  config.project_path = path.join(output,'projects'); config.compile.backend = 'local'; config.blocklyOnboardingCompleted = true; write(configPath,config); write(path.join(appdata,'config.json'),config);
  fs.copyFileSync(path.join(process.env.PARTITION_AUTH_SOURCE || '/Users/downey/Library/aily-project','.aily'), path.join(appdata,'.aily')); fs.chmodSync(path.join(appdata,'.aily'), 0o600);
  fs.mkdirSync(path.join(output,'agent-home'), {recursive:true});
  for (const name of ['models.json', 'auth.json', 'settings.json']) fs.copyFileSync(path.join(process.env.PARTITION_AGENT_CONFIG_SOURCE || '/Users/downey/.aily-chat',name),path.join(output,'agent-home',name));
  const testHome = path.join(output,'home'); fs.mkdirSync(testHome);
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  application = await _electron.launch({ executablePath: requireHost('electron'), cwd: stage, timeout: 60000,
    args: [stage, '--serve', `--user-data-dir=${path.join(output,'profile')}`],
    env: { ...env, ...(process.platform === 'win32' ? { USERPROFILE: testHome } : { HOME: testHome }),
      AILY_E2E: '1', AILY_APPDATA_PATH: appdata, AILY_PRODUCT_ACCEPTANCE_ROOT: output, AILY_BUILD_PRODUCT: 'blockly',
      AILY_AGENT_HOME: path.join(output, 'agent-home'), PI_CODING_AGENT_DIR: path.join(output, 'agent-home'),
      AILY_SUBAPP_INSTALL_ROOT: appRoot, AILY_PRODUCT_RUNTIME_DESCRIPTOR: descriptor, AILY_SUBAPP_INDEX_URL: origin+'/subapp-index.json' } });
  application.process().stdout?.on('data', data => logs.write(data)); application.process().stderr?.on('data', data => logs.write(data));
  const pid = await application.evaluate(() => process.pid); report.pid = pid;
  const discovery = path.join(testHome,'.aily-blockly/cli-bridge',`${pid}.json`);
  const target = await until(() => fs.existsSync(discovery) && JSON.parse(fs.readFileSync(discovery)), 'CLI bridge');
  const command = (operation, params = {}) => appCommand('blockly-live-operation', undefined, { operation, params }, { target, timeoutMs: 30000 });
  main = await until(async () => {
    for (const page of application.windows()) if (await page.locator('app-main-window').count().catch(()=>0)) return page;
  }, 'real main renderer');
  main.on('console', m => logs.write(`[renderer:${m.type()}] ${m.text()}\n`));
  main.on('pageerror', e => logs.write(`[renderer-error] ${e.stack}\n`));
  await main.addLocatorHandler(main.getByText('跳过',{exact:true}), locator => locator.click());
  await until(async () => { const result = await command('child_app_list'); return result.ok && JSON.stringify(result).includes(toolId); }, 'partition discovery');
  console.log('Host ready');

  await until(() => main.evaluate(() => window.ng.getComponent(document.querySelector('app-main-window')).authService.getAuthInitializationState() === 'authenticated'), 'real authentication', 60000);
  const open = async project => {
    await main.evaluate(project => window.ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
    await main.waitForFunction(project => {
      const p = window.ng.getComponent(document.querySelector('app-header')).projectService, s = p.getBlocklyProjectLoadStatus(project);
      if (s?.state === 'error') throw Error(JSON.stringify(s));
      return p.currentProjectPath === project && s?.ready;
    }, project, {timeout:240000});
  };
  const cleanup = async () => {
    await scope?.close().catch(()=>{}); agent?.close();
    const pids = await main.evaluate(async () => (await window.childToolSession?.list?.() || []).map(s=>s.pid ?? s.hostInfo?.pid)).catch(()=>[]);
    await main.evaluate(async () => window.ng.getComponent(document.querySelector('app-blockly-editor'))?.builderService?.stopPreprocess?.()).catch(()=>{});
    await application.evaluate(({app})=>app.exit(0)).catch(()=>{});
    for (const pid of pids) if (Number.isInteger(pid) && pid>0) { try { process.kill(pid,'SIGTERM'); } catch {} }
    await backend.stop(); catalog.closeAllConnections(); await new Promise(r=>catalog.close(r)); logs.end();
    for (const secret of [path.join(appdata,'.aily'),path.join(appdata,'auth'),path.join(output,'agent-home/auth.json'),path.join(output,'agent-home/models.json')]) fs.rmSync(secret,{recursive:true,force:true});
  };
  write(path.join(output,'runtime-public.json'),{pid,output,project:testProject,startedAt:new Date().toISOString()});
  return { output, appdata, application, main, backend, command, target, testProject, open, cleanup, report, write, until, requireHost, chatRoot, appCommand, SubappAgentSession, connectAgent };
}
