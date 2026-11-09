const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  GUIDE_CHANNEL,
  inspectMacosLaunchLocation,
  renderInstallGuideHtml,
  showMacosInstallGuide,
  loadAppIcon,
} = require('../../electron/macos-launch-location');

const translocated = '/private/var/folders/ab/xyz/T/AppTranslocation/8E2C1C4A-1234-5678-9ABC-DEF012345678/d/aily blockly.app/Contents/MacOS/aily blockly';
const installed = '/Applications/aily blockly.app/Contents/MacOS/aily blockly';
const diskImage = '/Volumes/aily blockly/aily blockly.app/Contents/MacOS/aily blockly';
const externalApplications = '/Volumes/External/Applications/aily blockly.app/Contents/MacOS/aily blockly';

test('ignores non-macOS launches', () => {
  assert.equal(inspectMacosLaunchLocation({ platform: 'win32', paths: [translocated] }).unsafe, false);
});

test('accepts apps launched from an Applications folder', () => {
  for (const location of [installed, externalApplications]) {
    const report = inspectMacosLaunchLocation({ platform: 'darwin', paths: [location] });
    assert.equal(report.unsafe, false, location);
    assert.equal(report.status, 'ok');
  }
});

test('detects AppTranslocation and DMG launches', () => {
  const moved = inspectMacosLaunchLocation({ platform: 'darwin', paths: [translocated], locale: 'zh-CN' });
  assert.equal(moved.status, 'app-translocation');
  assert.equal(moved.evidencePath, translocated);
  assert.match(moved.copy.reason, /运行环境/);

  const mounted = inspectMacosLaunchLocation({ platform: 'darwin', paths: [diskImage], locale: 'zh-CN' });
  assert.equal(mounted.status, 'disk-image');
});

test('renders the full install page with only open and quit actions', () => {
  const report = inspectMacosLaunchLocation({
    platform: 'darwin', paths: [translocated], appName: 'aily blockly', locale: 'zh-Hans-CN',
  });
  const html = renderInstallGuideHtml(report);
  assert.match(html, /请先将 aily blockly 安装到「应用程序」/);
  assert.match(html, /拖入「应用程序（Applications）」文件夹/);
  assert.match(html, /推出安装镜像/);
  assert.match(html, /重试开发板安装和编译/);
  assert.deepEqual([...html.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]), ['open-applications', 'quit']);
  assert.doesNotMatch(html, /仍要继续|Continue/);
  assert.doesNotMatch(html, /<image /, 'falls back to the drawn app mark');
});

test('embeds only PNG data URLs as the app icon', () => {
  const report = inspectMacosLaunchLocation({ platform: 'darwin', paths: [translocated], locale: 'zh-CN' });
  assert.match(renderInstallGuideHtml(report, 'data:image/png;base64,iVBORw0KGgo='), /<image href="data:image\/png;base64,iVBORw0KGgo="/);
  assert.doesNotMatch(renderInstallGuideHtml(report, 'javascript:alert(1)'), /javascript:/);
});

test('names the product and bundle separately for Blockly and Coder', () => {
  const coderPath = '/private/var/folders/x/T/AppTranslocation/1/d/aily coder.app/Contents/MacOS/aily coder';
  const coder = inspectMacosLaunchLocation({ platform: 'darwin', paths: [coderPath], appName: 'Aily Coder', product: 'coder', locale: 'zh-CN' });
  assert.equal(coder.product, 'coder');
  assert.equal(coder.bundleName, 'aily coder');
  const coderHtml = renderInstallGuideHtml(coder);
  assert.match(coderHtml, /请先将 Aily Coder 安装到「应用程序」/);
  assert.match(coderHtml, /「aily coder\.app」拖入/);
  assert.doesNotMatch(coderHtml, /aily blockly/);

  const blockly = inspectMacosLaunchLocation({ platform: 'darwin', paths: [diskImage], product: 'blockly', locale: 'zh-CN' });
  const blocklyHtml = renderInstallGuideHtml(blockly);
  assert.equal(blockly.appName, 'aily blockly');
  assert.match(blocklyHtml, /「aily blockly\.app」拖入/);
  assert.doesNotMatch(blocklyHtml, /Coder/);
});

test('embeds only the real PNG app icon and draws no substitute', () => {
  const report = inspectMacosLaunchLocation({ platform: 'darwin', paths: [diskImage], locale: 'zh-CN' });
  assert.match(renderInstallGuideHtml(report, 'data:image/png;base64,AAAA'), /<image href="data:image\/png;base64,AAAA"/);
  for (const icon of ['', 'javascript:alert(1)']) {
    const html = renderInstallGuideHtml(report, icon);
    assert.doesNotMatch(html, /<image /);
    assert.doesNotMatch(html, /dmg-app/);
  }
});

test('reads the icon from the running bundle, trying each source in order', async () => {
  const image = url => ({ isEmpty: () => !url, toDataURL: () => url });
  const calls = [];
  const icon = await loadAppIcon({
    evidencePath: '/private/var/T/AppTranslocation/1/d/aily coder.app/Contents/MacOS/aily coder',
    nativeImage: {
      createThumbnailFromPath: async target => { calls.push(['thumbnail', target]); throw new Error('unavailable'); },
      createFromPath: target => { calls.push(['icns', target]); return image(''); },
    },
    app: { getFileIcon: async target => { calls.push(['file', target]); return image('data:image/png;base64,QQ=='); } },
  });
  assert.equal(icon, 'data:image/png;base64,QQ==');
  assert.deepEqual(calls, [
    ['thumbnail', '/private/var/T/AppTranslocation/1/d/aily coder.app'],
    ['icns', '/private/var/T/AppTranslocation/1/d/aily coder.app/Contents/Resources/icon.icns'],
    ['file', '/private/var/T/AppTranslocation/1/d/aily coder.app'],
  ]);
  assert.equal(await loadAppIcon({ evidencePath: '/tmp/no-bundle', nativeImage: {} }), '');
});

test('escapes the evidence path and uses English for other locales', () => {
  const report = inspectMacosLaunchLocation({
    platform: 'darwin', paths: ['/Volumes/<x>/Aily Coder.app/Contents/MacOS/Aily Coder'], appName: 'Aily Coder', locale: 'en-US',
  });
  const html = renderInstallGuideHtml(report);
  assert.match(html, /Move Aily Coder to Applications first/);
  assert.match(html, /&lt;x&gt;/);
  assert.doesNotMatch(html, /<x>/);
});

test('guide window opens Applications, quits, and quits when closed', async () => {
  const ipcMain = new EventEmitter();
  const opened = [];
  let quits = 0;
  let loaded = '';
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: handler => { this.openHandler = handler; } });
    }
    loadURL(url) { loaded = url; return Promise.resolve(); }
    isDestroyed() { return false; }
    show() {}
  }
  const report = inspectMacosLaunchLocation({ platform: 'darwin', paths: [translocated], locale: 'zh-CN' });
  const win = showMacosInstallGuide({
    BrowserWindow: FakeWindow,
    ipcMain,
    shell: { openPath: async target => { opened.push(target); return ''; } },
    app: { quit: () => { quits += 1; } },
    report,
    log: () => {},
  });

  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.match(decodeURIComponent(loaded), /AppTranslocation/);
  assert.deepEqual(win.openHandler(), { action: 'deny' });

  ipcMain.emit(GUIDE_CHANNEL, { sender: {} }, 'quit');
  assert.equal(quits, 0, 'ignores other senders');
  ipcMain.emit(GUIDE_CHANNEL, { sender: win.webContents }, 'open-applications');
  await new Promise(setImmediate);
  assert.deepEqual(opened, ['/Applications']);
  ipcMain.emit(GUIDE_CHANNEL, { sender: win.webContents }, 'quit');
  assert.equal(quits, 1);

  win.emit('closed');
  assert.equal(quits, 2);
  assert.equal(ipcMain.listenerCount(GUIDE_CHANNEL), 0);
});
