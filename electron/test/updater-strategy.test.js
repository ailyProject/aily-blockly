const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

class FakeCancellationToken extends EventEmitter {
  constructor() {
    super();
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    this.emit('cancel');
  }

  onCancel(handler) {
    if (this.cancelled) {
      handler();
    } else {
      this.once('cancel', handler);
    }
  }
}

class FakeGenericProvider {
  constructor(configuration) {
    this.configuration = configuration;
  }

  resolveFiles(info) {
    return info.files.map((file) => ({
      url: new URL(file.url, `${this.configuration.url}/`),
    }));
  }
}

function loadUpdaterModule() {
  const autoUpdater = new EventEmitter();
  autoUpdater.channel = null;
  autoUpdater.logger = { info() {} };
  autoUpdater.httpExecutor = { createRequest: () => new EventEmitter() };
  autoUpdater.createProviderRuntimeOptions = () => ({
    executor: autoUpdater.httpExecutor,
    platform: 'win32',
    isUseMultipleRangeRequest: false,
  });

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getLocale: () => 'zh-CN' },
        BrowserWindow: {},
        dialog: {},
        ipcMain: {},
        screen: {},
        shell: {},
      };
    }
    if (request === 'electron-updater') {
      return { autoUpdater, CancellationToken: FakeCancellationToken };
    }
    if (request === 'electron-updater/out/providers/GenericProvider') {
      return { GenericProvider: FakeGenericProvider };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const updaterPath = path.resolve(__dirname, '..', 'updater.js');
  delete require.cache[updaterPath];
  try {
    return {
      autoUpdater,
      updater: require(updaterPath),
    };
  } finally {
    Module._load = originalLoad;
  }
}

function configureCnUpdate(autoUpdater) {
  const info = {
    version: '1.0.0',
    files: [{ url: 'aily-blockly-CN-Setup-1.0.0.exe' }],
  };
  const originalProvider = {
    resolveFiles(updateInfo) {
      return updateInfo.files.map((file) => ({
        url: new URL(file.url, 'https://original.example/'),
      }));
    },
  };
  autoUpdater.updateInfoAndProvider = { info, provider: originalProvider };
  return originalProvider;
}

test('a strategy cancellation switches to the next mirror', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { autoUpdater, updater } = loadUpdaterModule();
  configureCnUpdate(autoUpdater);
  const sources = [];
  const statuses = [];
  const outcomes = [
    updater.__testing.createStrategyCancellationError({ type: 'low-speed' }, { region: 'eu' }),
    ['downloaded.exe'],
  ];
  autoUpdater.downloadUpdate = async () => {
    sources.push(autoUpdater.updateInfoAndProvider.provider.configuration.url);
    const outcome = outcomes.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };

  const result = await updater.__testing.downloadWithMirrors({
    webContents: { send: (_channel, status) => statuses.push(status) },
  });

  assert.deepEqual(result, ['downloaded.exe']);
  assert.deepEqual(sources, ['https://dl.aily.pro/blockly', 'https://dl.yiyu.pro/blockly']);
  assert.deepEqual(
    statuses.filter((status) => status.status === 'mirror-switching'),
    [{
      status: 'mirror-switching',
      source: { region: 'cn', url: 'https://dl.yiyu.pro/blockly' },
      index: 1,
      total: 2,
    }]
  );
});

test('the fallback waits for the previous request to close', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { autoUpdater, updater } = loadUpdaterModule();
  configureCnUpdate(autoUpdater);
  let firstRequest;
  let calls = 0;
  autoUpdater.httpExecutor.createRequest = () => new EventEmitter();
  autoUpdater.downloadUpdate = async () => {
    calls++;
    if (calls === 1) {
      firstRequest = autoUpdater.httpExecutor.createRequest();
      throw updater.__testing.createStrategyCancellationError(
        { type: 'low-speed' },
        { region: 'eu' }
      );
    }
    return ['downloaded.exe'];
  };

  const download = updater.__testing.downloadWithMirrors({ webContents: { send() {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  firstRequest.emit('close');
  assert.deepEqual(await download, ['downloaded.exe']);
  assert.equal(calls, 2);
});

test('a user cancellation never falls back to another mirror', async () => {
  const { autoUpdater, updater } = loadUpdaterModule();
  configureCnUpdate(autoUpdater);
  let calls = 0;
  let started;
  const request = new EventEmitter();
  request.abortCount = 0;
  request.abort = () => {
    request.abortCount++;
    request.emit('close');
  };
  autoUpdater.httpExecutor.createRequest = () => request;
  autoUpdater.downloadUpdate = (token) => {
    calls++;
    autoUpdater.httpExecutor.createRequest();
    started = new Promise((resolve) => {
      token.once('cancel', () => resolve());
    });
    return new Promise((_resolve, reject) => {
      token.once('cancel', () => reject(new Error('net::ERR_ABORTED')));
    });
  };

  const download = updater.__testing.downloadWithMirrors({ webContents: { send() {} } });
  await new Promise((resolve) => setImmediate(resolve));
  updater.__testing.cancelActiveDownload();
  await started;

  await assert.rejects(download, (error) => {
    assert.equal(error.name, 'CancellationError');
    assert.equal(error.message, 'cancelled');
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(request.abortCount, 1);
});

test('the legacy low-speed threshold is migrated while custom values are preserved', () => {
  const { updater } = loadUpdaterModule();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-updater-test-'));
  const previousAppDataPath = process.env.AILY_APPDATA_PATH;

  try {
    process.env.AILY_APPDATA_PATH = configDir;
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      update_download_strategy: {
        min_average_speed_bytes_per_second: 65536,
      },
    }));
    assert.equal(
      updater.__testing.getDownloadGuardConfig().minAverageSpeedBytesPerSecond,
      262144
    );

    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      update_download_strategy: {
        min_average_speed_bytes_per_second: 131072,
      },
    }));
    assert.equal(
      updater.__testing.getDownloadGuardConfig().minAverageSpeedBytesPerSecond,
      131072
    );
  } finally {
    if (previousAppDataPath === undefined) {
      delete process.env.AILY_APPDATA_PATH;
    } else {
      process.env.AILY_APPDATA_PATH = previousAppDataPath;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
