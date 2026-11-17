// Prepare an isolated packaged Electron probe for the real native consent UI.
// No real account, application profile or operating-system protocol registration is used.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createPackageWithOptions } = require('@electron/asar');

async function main() {
  if (process.platform !== 'darwin') throw new Error('This interactive native probe runs on macOS');
  const root = path.resolve(__dirname, '../.artifacts/hub-client-login-native');
  const source = path.join(root, 'source'), bundle = path.join(root, 'HubLoginFixture.app');
  const packageResources = process.env.AILY_HUB_FIXTURE_PACKAGE_RESOURCES;
  if (packageResources && (!path.isAbsolute(packageResources) || !fs.existsSync(path.join(packageResources, 'app.asar')))) {
    throw new Error('Expected the final packaged Resources directory');
  }
  require('../../scripts/prepare-window-chrome').prepareWindowChrome();
  fs.mkdirSync(path.join(source, 'electron'), { recursive: true });
  if (!fs.existsSync(bundle)) {
    fs.cpSync(path.resolve(path.dirname(require('electron')), '../..'), bundle, { recursive: true, verbatimSymlinks: true });
    fs.renameSync(path.join(bundle, 'Contents/MacOS/Electron'), path.join(bundle, 'Contents/MacOS/HubLoginFixture'));
    const plist = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier pro.aily.hub-login-fixture',
      '-c', 'Set :CFBundleExecutable HubLoginFixture', '-c', 'Set :CFBundleName HubLoginFixture',
      path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' });
    if (plist.status !== 0) throw new Error(plist.stderr);
  }
  for (const name of ['hub-browser-login.js', 'build-product.js', 'hub-consent-window.js', 'window-chrome.js', 'hub-consent-preload.js', 'hub-consent.html', 'hub-consent.css', 'hub-consent-page.js', 'hub-consent-aily.jpg']) {
    fs.copyFileSync(path.join(__dirname, '../../electron', name), path.join(source, 'electron', name));
  }
  fs.mkdirSync(path.join(source, 'electron/native'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../electron/native/window-chrome.node'), path.join(source, 'electron/native/window-chrome.node'));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'hub-login-fixture', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(source, 'preload.cjs'), `
    const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('fixture', {
      ready: () => ipcRenderer.invoke('hub-client-ready'),
      theme: mode => ipcRenderer.invoke('hub-client-theme', mode),
      request: account => ipcRenderer.invoke('fixture-request', account),
      receive: callback => { ipcRenderer.on('hub-client-authorize', async (_event, request) => {
        const account = await ipcRenderer.invoke('fixture-account');
        const allowed = await ipcRenderer.invoke('hub-client-confirm', { state: request.state, account });
        await ipcRenderer.invoke('hub-client-finish', request.state);
        await ipcRenderer.invoke('fixture-result', { account, allowed });
        callback(allowed);
      }); },
    });
  `);
  fs.writeFileSync(path.join(source, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>客户端授权验证</title>
    <style>body{font:16px system-ui;padding:28px;color:#172033;background:#f7f9fc}h1{font-size:24px}button{font:inherit;border:1px solid #d5deeb;border-radius:8px;padding:10px 16px;background:white;cursor:pointer;margin:8px 6px 8px 0}button:hover{background:#eaf3ff;border-color:#1268e8;color:#1268e8}#result{padding:16px;background:white;border-radius:8px}#theme{position:fixed;right:24px;top:20px}html[data-theme=dark] body{background:#2b2d30;color:#fff}html[data-theme=dark] button,html[data-theme=dark] #result{background:#323437;color:#ccc;border-color:#444}</style>
    <h1>客户端授权验证</h1><p>隔离测试账号，不读取真实账号或用户目录。</p><p id="account">当前账号：测试账号 A</p>
    <button id="theme">切换浅色主题</button><button id="switch">切换为测试账号 B</button><button id="start">请求项目广场登录</button><p id="result">等待发起</p>
    <script>let account='测试账号 A',theme='dark';document.documentElement.dataset.theme=theme;
    document.querySelector('#theme').onclick=()=>{theme=theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;window.fixture.theme(theme);document.querySelector('#theme').textContent=theme==='dark'?'切换浅色主题':'切换深色主题';};
    window.fixture.receive(allowed=>document.querySelector('#result').textContent=allowed?'已允许登录':'已取消登录');
    document.querySelector('#switch').onclick=()=>{account='测试账号 B';document.querySelector('#account').textContent='当前账号：'+account;};
    document.querySelector('#start').onclick=()=>window.fixture.request(account);window.fixture.ready();window.fixture.theme(theme);</script></html>`);
  fs.writeFileSync(path.join(source, 'main.cjs'), `
    const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const { randomBytes } = require('node:crypto');
    const root = ${JSON.stringify(root)};
    const electronRoot = ${packageResources ? JSON.stringify(path.join(packageResources, 'app.asar/electron')) : "path.join(__dirname,'electron')"};
    app.setPath('userData', path.join(root, 'profile')); app.setPath('sessionData', path.join(root, 'profile'));
    app.whenReady().then(async () => {
      assert.equal(app.isPackaged, true);
      for (const name of ['AILY_CHILD_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) assert.equal(process.env[name], undefined);
      let account = '', records = [];
      const window = new BrowserWindow({ width:1000,height:780,title:'客户端授权验证', webPreferences:{preload:path.join(__dirname,'preload.cjs')} });
      window.webContents.on('console-message', event => console.log('fixture-renderer', event.message));
      const bridge = require(path.join(electronRoot,'hub-browser-login')).createHubBrowserBridge({ window, ipcMain, BrowserWindow, product:'blockly', directory:path.join(root,'registry') });
      await bridge.ready;
      let ticks=0;setInterval(()=>{ticks++;},25);
      app.on('browser-window-created',(_event,child)=>{if(child===window)return;child.once('ready-to-show',()=>setTimeout(()=>{
        const start=ticks;setTimeout(()=>{assert.ok(ticks>start);assert.equal(child.getParentWindow(),window);assert.equal(child.isModal(),false);assert.equal(window.isFocusable(),true);
        const native=require(path.join(electronRoot,'native/window-chrome.node'));assert.equal(native.getIgnoresMouseEvents(window.getNativeWindowHandle()),false);
        fs.writeFileSync(path.join(root,'modality.json'),JSON.stringify({parented:true,modal:false,ownerFocusable:window.isFocusable(),ownerIgnoresMouse:false,backgroundProgress:ticks>start}));},150);
      },50));});
      ipcMain.handle('fixture-account', () => account);
      ipcMain.handle('fixture-request', (_event, value) => {
        account=value;
        const url='abis://auth/hub/login?'+new URLSearchParams({state:randomBytes(32).toString('base64url'), code_challenge:randomBytes(32).toString('base64url'),redirect_uri:'https://hub.aily.pro/auth/callback'});
        return bridge.accept(url);
      });
      ipcMain.handle('fixture-result', (_event, result) => {
        assert.equal(window.isFocusable(),true);
        assert.equal(require(path.join(electronRoot,'native/window-chrome.node')).getIgnoresMouseEvents(window.getNativeWindowHandle()),false);
        records.push(result);fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({packaged:app.isPackaged,records},null,2));
      });
      window.once('closed',()=>{bridge.close();app.quit();});
      await window.loadFile(path.join(__dirname,'index.html'));
    }).catch(error=>{fs.writeFileSync(path.join(root,'failure.txt'),String(error.stack));app.exit(1);});
  `);
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  await createPackageWithOptions(source, path.join(bundle, 'Contents/Resources/app.asar'), { unpack: '**/*.node' });
  const env = { ...process.env };
  for (const name of ['AILY_CHILD_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[name];
  const log = fs.openSync(path.join(root, 'native.log'), 'w');
  const child = spawn(path.join(bundle, 'Contents/MacOS/HubLoginFixture'), [], { env, cwd: root, detached: true, stdio: ['ignore', log, log] });
  child.unref(); fs.closeSync(log);
  console.log(JSON.stringify({ root, bundle, pid: child.pid }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
