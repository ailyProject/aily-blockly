const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { AppUpdater } = require('electron-updater/out/AppUpdater');
const { CancellationToken } = require('builder-util-runtime');
const { createBuildPlan, createBuilderConfig } = require('../scripts/build-electron');

function fixture({ platform = 'win32', flavor = 'global', product = 'coder' } = {}) {
  const config = structuredClone(require('./config/config.json'));
  config.lang = 'en';
  const plan = createBuildPlan(['--product', product, '--flavor', flavor], config);
  const publish = createBuilderConfig(plan, {}).publish[0];
  const updater = new AppUpdater(null, {
    version: '0.1.6', isPackaged: true, whenReady: async () => {},
  });
  updater._testOnlyOptions = { platform };
  updater.configOnDisk = { value: Promise.resolve(publish) };
  updater.stagingUserIdPromise = { value: Promise.resolve('1b3f8d27-6df2-4ced-8e64-0967262f7804') };
  const requests = [];
  const logs = [];
  const payload = Buffer.from('signed update fixture');
  const sha512 = createHash('sha512').update(payload).digest('base64');
  let offeredVersion = '0.1.7';
  let failGlobalDownload = false;
  // Intercept the HTTP executor boundary: GenericProvider constructs and parses
  // the real request, while this transport never contacts production feeds.
  updater.httpExecutor = {
    createRequest() {},
    async request(options) {
      const url = new URL(`${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ''}${options.path}`);
      url.search = '';
      requests.push(url.href);
      if (url.pathname.endsWith('.yml')) {
        // Domestic sync publishes the CN manifest under the common channel name.
        const targetFlavor = url.hostname === 'dl.yiyu.pro' ? 'CN-' : '';
        const file = platform === 'darwin'
          ? `aily-${product}-${targetFlavor}macos-${offeredVersion}-arm64.zip`
          : `aily-${product}-${targetFlavor}Setup-${offeredVersion}.exe`;
        return JSON.stringify({ version: offeredVersion, files: [{ url: file, sha512, size: payload.length }] });
      }
      if (failGlobalDownload && url.hostname === 'dl.aily.pro') throw new Error('mirror unavailable');
      return payload;
    },
  };
  updater.doDownloadUpdate = async ({ updateInfoAndProvider }) => {
    const file = updateInfoAndProvider.provider.resolveFiles(updateInfoAndProvider.info)[0];
    const bytes = await updater.httpExecutor.request({
      protocol: file.url.protocol, hostname: file.url.hostname, path: file.url.pathname,
    });
    assert.equal(bytes.length, file.info.size);
    assert.equal(createHash('sha512').update(bytes).digest('base64'), file.info.sha512);
    return [file.url.href];
  };
  const handlers = new Map();
  const logger = { info: message => logs.push(message), warn() {}, error() {}, transports: { file: {} } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'updater.js'), 'utf8'), {
    module,
    __dirname,
    process: { platform, arch: platform === 'darwin' ? 'arm64' : 'x64', env: { AILY_BUILD_PRODUCT: product, AILY_BUILD_FLAVOR: flavor } },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Shanghai' }) }) },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout,
    require(id) {
      if (id === 'electron') return {
        app: { getLocale: () => config.lang },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
      };
      if (id === 'electron-updater') return { autoUpdater: updater, CancellationToken };
      if (id === 'electron-log') return logger;
      if (id === 'fs') return {
        ...fs,
        readFileSync: (file, ...args) => file === path.join(__dirname, 'config', 'config.json')
          ? JSON.stringify(config) : fs.readFileSync(file, ...args),
      };
      return require(id);
    },
  }, { filename: path.join(__dirname, 'updater.js') });
  module.exports.registerUpdaterHandlers({ webContents: { send() {} } });
  return {
    config, updater, requests, logs,
    check: () => handlers.get('check-for-updates')(),
    download: () => handlers.get('start-download')(),
    offerVersion: version => { offeredVersion = version; },
    failGlobalDownload: () => { failGlobalDownload = true; },
  };
}

for (const platform of ['win32', 'darwin']) {
  for (const flavor of ['cn', 'global']) {
    test(`Coder ${platform} ${flavor} requests its product manifest and disallows downgrade`, async () => {
      const app = fixture({ platform, flavor });
      const origin = flavor === 'cn' ? 'https://dl.yiyu.pro' : 'https://dl.aily.pro';
      const url = `${origin}/blockly/latest-coder${platform === 'darwin' ? '-mac' : ''}.yml`;
      const result = await app.check();
      assert.equal(result.isUpdateAvailable, true);
      assert.equal(result.updateInfo.files[0].url.includes('-CN-'), flavor === 'cn');
      assert.deepEqual(app.requests, [url]);
      assert.ok(app.logs.some(log => log.startsWith('[Updater] checking update manifest ') && log.includes(url)));
      assert.equal(app.updater.allowDowngrade, false);
      app.offerVersion('0.1.5');
      assert.equal((await app.check()).isUpdateAvailable, false);
    });
  }
}

test('Coder Global switches to CN then restores its packaged source using the common product channel', async () => {
  const app = fixture({ platform: 'darwin' });
  app.config.lang = 'zh_CN';
  assert.ok((await app.check()).updateInfo.files[0].url.includes('-CN-'));
  assert.equal(app.updater.allowDowngrade, false);
  assert.deepEqual(app.requests, ['https://dl.yiyu.pro/blockly/latest-coder-mac.yml']);
  assert.ok(app.logs.some(log => log.startsWith('[Updater] forced update manifest source ') && log.includes(app.requests[0])));
  app.config.lang = 'en';
  assert.equal((await app.check()).updateInfo.files[0].url.includes('-CN-'), false);
  assert.equal(app.requests[1], 'https://dl.aily.pro/blockly/latest-coder-mac.yml');
  assert.ok(app.logs.some(log => log.startsWith('[Updater] restored packaged update manifest source ') && log.includes(app.requests[1])));
  assert.equal(app.updater.allowDowngrade, false);
  app.offerVersion('0.1.5');
  assert.equal((await app.check()).isUpdateAvailable, false);
});

test('Coder stops checking on restoration failure and retries after the packaged configuration is repaired', async () => {
  const app = fixture();
  const packagedConfig = app.updater.configOnDisk;
  app.config.lang = 'zh_CN';
  await app.check();
  app.config.lang = 'en';

  app.updater.configOnDisk = { get value() { return Promise.reject(new Error('Cannot read packaged updater configuration')); } };
  await assert.rejects(app.check(), /Cannot read packaged/);
  assert.equal(app.requests.length, 1);

  app.updater.configOnDisk = { value: Promise.resolve({ provider: 'generic' }) };
  await assert.rejects(app.check(), /missing a URL/);
  assert.equal(app.requests.length, 1);

  // AppUpdater caches a rejected config read. Replace it explicitly here;
  // the test does not assume that another check automatically rereads disk.
  app.updater.configOnDisk = packagedConfig;
  const setFeedURL = app.updater.setFeedURL;
  app.updater.setFeedURL = () => { throw new Error('Cannot restore packaged feed'); };
  await assert.rejects(app.check(), /Cannot restore packaged feed/);
  assert.equal(app.requests.length, 1);

  app.updater.setFeedURL = setFeedURL;
  assert.equal((await app.check()).updateInfo.files[0].url.includes('-CN-'), false);
  assert.deepEqual(app.requests, [
    'https://dl.yiyu.pro/blockly/latest-coder.yml',
    'https://dl.aily.pro/blockly/latest-coder.yml',
  ]);
  assert.equal(app.updater.allowDowngrade, false);
});

test('Coder mirror failure keeps the checked CN package and checksum without rechecking a manifest', async () => {
  const app = fixture();
  app.config.lang = 'zh_CN';
  await app.check();
  app.failGlobalDownload();
  const result = await app.download();
  assert.deepEqual(app.requests, [
    'https://dl.yiyu.pro/blockly/latest-coder.yml',
    'https://dl.aily.pro/blockly/aily-coder-CN-Setup-0.1.7.exe',
    'https://dl.yiyu.pro/blockly/aily-coder-CN-Setup-0.1.7.exe',
  ]);
  assert.equal(result[0], app.requests[2]);
  assert.equal(app.updater.allowDowngrade, false);
});

test('Coder Global download keeps its selected flavor without entering the CN mirror strategy', async () => {
  const app = fixture();
  await app.check();
  const result = await app.download();
  assert.deepEqual(app.requests, [
    'https://dl.aily.pro/blockly/latest-coder.yml',
    'https://dl.aily.pro/blockly/aily-coder-Setup-0.1.7.exe',
  ]);
  assert.equal(result[0], app.requests[1]);
});

test('Blockly retains its original feed and source switch behavior', async () => {
  const app = fixture({ product: 'blockly', platform: 'darwin' });
  await app.check();
  app.config.lang = 'zh_CN';
  await app.check();
  app.config.lang = 'en';
  await app.check();
  assert.deepEqual(app.requests, [
    'https://dl.aily.pro/blockly/latest-mac.yml',
    'https://dl.yiyu.pro/blockly/latest-mac.yml',
    'https://dl.aily.pro/blockly/latest-mac.yml',
  ]);
  assert.equal(app.updater.allowDowngrade, false);
});
