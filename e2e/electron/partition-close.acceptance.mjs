import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Start the host dev renderer on port 4200 before running this script.
// FFS_CLOSE_MODE=window, FFS_CLOSE_QUIT=1 and FFS_CLOSE_ENTRY=host select paths.
// Full host main/preload and live Angular renderer, actual partition UI/server.
// Only the runtime wrapper and account/catalog are isolated fixtures. No device,
// user project, installed subapp or running user-owned Electron is modified.
const hostRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ffsRoot = path.resolve(process.env.FFS_PRODUCT_ROOT || path.join(hostRoot, '../../ZCK/aily-subapp/packages/ffs-manager'));
const chatRoot = path.resolve(process.env.CHAT_PRODUCT_ROOT || path.join(hostRoot, '../../aily-lex-pro/packages/aily-agent'));
const requireHost = createRequire(path.join(hostRoot, 'package.json'));
const requireFfs = createRequire(path.join(ffsRoot, 'package.json'));
const { _electron, expect } = requireHost('@playwright/test');
const { startFfsManagerServer } = requireFfs('./server');
const { appCommand } = await import(pathToFileURL(path.join(chatRoot, 'dist/blockly/services/app/command.js')));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'partition-close-product-'));
const report = { output, product: 'full-blockly-dev-renderer', checks: [] };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const link = (target, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir'); };
async function until(probe, name, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(100); }
  throw new Error('Timed out: ' + name);
}
console.log('Evidence: '+output);
let application, backend, catalog, main;
const logs = fs.createWriteStream(path.join(output, 'process.log'));
try {
  const stage = path.join(output, 'app'), appdata = path.join(output, 'appdata'), appRoot = path.join(appdata, 'npm-global/app');
  fs.cpSync(path.join(hostRoot, 'electron'), path.join(stage, 'electron'), { recursive: true,
    filter: source => !path.relative(path.join(hostRoot, 'electron'), source).split(path.sep).some(part => ['node_modules', 'test', 'tests'].includes(part)) });
  link(path.join(hostRoot, 'node_modules'), path.join(stage, 'node_modules'));
  link(path.join(hostRoot, 'electron/node_modules'), path.join(stage, 'electron/node_modules'));
  link(path.join(hostRoot, 'child'), path.join(stage, 'child'));
  fs.copyFileSync(path.join(hostRoot, 'e2e/electron/fixtures/subapp-product-bootstrap.cjs'), path.join(stage, 'electron/bootstrap.cjs'));
  write(path.join(stage, 'package.json'), { ...requireHost('./package.json'), main: 'electron/bootstrap.cjs' });
  backend = await startFfsManagerServer();
  const descriptor = path.join(output, 'runtime.json');
  write(descriptor, { mode: 'serve', url: backend.url, origin: backend.origin, wsUrl: backend.wsUrl, port: backend.port });
  const fixture = path.join(output, 'ffs-fixture'), manifest = requireFfs('./package.json');
  write(path.join(fixture, 'package.json'), { ...manifest, main: 'index.cjs', aily: { uiIndex: 'ui/index.html' } });
  fs.copyFileSync(path.join(hostRoot, 'e2e/electron/fixtures/subapp-product-runtime.cjs'), path.join(fixture, 'index.cjs'));
  for (const dir of ['agent', 'skill', 'i18n', 'ui']) link(path.join(ffsRoot, dir), path.join(fixture, dir));
  link(fixture, path.join(appRoot, 'node_modules/@aily-project/subapp-ffs-manager'));
  const toolId = 'ffs-manager-child';
  const index = { dev: true, [toolId]: { id: toolId, namespace: 'FFS_MANAGER', titleKey: 'FFS_MANAGER.TITLE',
    package: manifest.name, version: manifest.version, app: { ...manifest.ailySubapp.app, autoInstall: false }, ui: manifest.ailySubapp.ui } };
  write(path.join(appRoot, 'subapp-index.json'), index);
  write(path.join(appRoot, 'package.json'), { name: 'isolated-partition-close', private: true, dependencies: { [manifest.name]: manifest.version } });
  catalog = http.createServer((req,res) => {
    res.setHeader('content-type','application/json'); res.setHeader('access-control-allow-origin',req.headers.origin || '*');
    res.setHeader('access-control-allow-headers','*');
    res.end(JSON.stringify(req.url === '/subapp-index.json' ? index : { status: 200, data: { id: 'partition-close-test', nickname: 'Acceptance', groups: [] } }));
  });
  await new Promise(resolve => catalog.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${catalog.address().port}`;
  const configPath = path.join(stage,'electron/config/config.json'), config = JSON.parse(fs.readFileSync(configPath));
  for (const region of Object.values(config.regions || {})) region.api_server = origin;
  config.project_path = path.join(output,'projects'); write(configPath,config);
  write(path.join(appdata,'auth/blockly.json'), { access_token: 'isolated-partition-test-token' });
  const testHome = path.join(output,'home'); fs.mkdirSync(testHome);
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  application = await _electron.launch({ executablePath: requireHost('electron'), cwd: stage, timeout: 60000,
    args: [stage, '--serve', `--user-data-dir=${path.join(output,'profile')}`],
    env: { ...env, ...(process.platform === 'win32' ? { USERPROFILE: testHome } : { HOME: testHome }),
      AILY_E2E: '1', AILY_APPDATA_PATH: appdata, AILY_PRODUCT_ACCEPTANCE_ROOT: output, AILY_BUILD_PRODUCT: 'blockly',
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
  const mode = process.env.FFS_CLOSE_MODE || 'embedded';
  const offline = process.env.FFS_CLOSE_OFFLINE !== '0';
  report.mode = mode; report.offline = offline; report.quit = process.env.FFS_CLOSE_QUIT === '1';
  report.closeEntry = process.env.FFS_CLOSE_ENTRY || 'child';
  assert.equal((await command('child_app_open',{toolId,mode})).ok,true);
  const view = mode === 'window' ? await until(() => application.windows().find(p => p.url().includes('child-tool/ffs-manager-child')), 'standalone') : main;
  const frame = await until(() => view.frames().find(f => f.url().startsWith(backend.origin)), 'real FFS frame');
  await expect(frame.locator('#preset-xiaozhi')).toBeVisible();
  // Locate controls only after the actual page has loaded, then reproduce the
  // video's changed Flash + Xiaozhi draft through real UI input.
  await frame.locator('#flash').selectOption(String(16*1024*1024));
  await frame.locator('#preset-xiaozhi').click();
  await until(() => backend.core.snapshot().dirty, 'dirty draft');
  await frame.locator('#preset-iot').waitFor();
  report.dirtyRevision = backend.core.snapshot().revision;
  if (offline) {
    await backend.stop();
    await expect(frame.getByText('连接中断，正在重新连接…',{exact:true})).toBeVisible();
  }
  const triggerClose = async () => {
    if (report.closeEntry !== 'host') return frame.locator('[data-action=close]').click();
    if (mode !== 'window') return view.locator('app-tool-container .tool-btns .fa-xmark').click();
    return application.evaluate(({BrowserWindow}) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('child-tool/ffs-manager-child'));
      win.close();
    });
  };
  await expect(frame.locator('[data-action=close]')).toBeEnabled();
  await triggerClose();
  await expect(frame.locator('#confirm-dialog')).toBeVisible();
  await view.screenshot({path:path.join(output,'disconnected-confirm.png')});
  await frame.locator('[data-dialog=cancel]').click();
  await expect(frame.locator('#confirm-dialog')).not.toBeVisible();
  assert.equal(view.isClosed(),false); report.checks.push('child-cancel-preserves-view');
  const quit = process.env.FFS_CLOSE_QUIT === '1';
  if (quit) {
    // app.quit() exercises the actual main-process coordinator, real header
    // confirmation, registry, Penpal and iframe; no confirmation is stubbed.
    await application.evaluate(({app}) => app.quit());
    await expect(frame.locator('#confirm-dialog')).toBeVisible();
    await delay(2000); // longer than the former 1.5 s timeout
    assert.equal(main.isClosed(),false);
    await frame.locator('[data-dialog=cancel]').click();
    await expect(frame.locator('#confirm-dialog')).not.toBeVisible();
    assert.equal(main.isClosed(),false); report.checks.push('main-quit-cancel-keeps-application-alive');
    await application.evaluate(({app}) => app.quit());
    await expect(frame.locator('#confirm-dialog')).toBeVisible();
    const exited = new Promise(resolve => application.process().once('exit', (code,signal)=>resolve({code,signal})));
    await frame.locator('[data-dialog=discard]').click();
    report.exit = await Promise.race([exited,delay(15000).then(()=>{throw new Error('Main process failed to exit');})]);
    assert.equal(report.exit.code,0); report.checks.push('confirmed-disconnected-main-quit-exits-process');
    application = null;
  } else {
    await triggerClose();
    await expect(frame.locator('#confirm-dialog')).toBeVisible();
    await frame.locator('[data-dialog=discard]').click();
    await until(() => mode === 'window' ? view.isClosed() : !main.frames().some(f=>f.url().startsWith(backend.origin)), 'partition view closed');
    assert.equal(main.isClosed(),false);
    if (!offline) assert.equal(backend.core.snapshot().dirty, false);
    report.checks.push('confirmed-child-closes-with-host-alive');
  }
  report.passed=true;
} catch (error) {
  report.error=error.stack; process.exitCode=1;
  if (main && !main.isClosed()) { await main.screenshot({path:path.join(output,'failure.png')}).catch(()=>{}); fs.writeFileSync(path.join(output,'failure.txt'), await main.locator('body').innerText().catch(()=>'')); }
} finally {
  if (application) await application.evaluate(({app}) => app.exit(0)).catch(()=>{}); // only test-owned process cleanup
  await backend?.stop();
  if (catalog) { catalog.closeAllConnections(); await new Promise(resolve=>catalog.close(resolve)); }
  await new Promise(resolve=>logs.end(resolve));
  write(path.join(output,'report.json'),report); console.log(JSON.stringify(report,null,2));
}
