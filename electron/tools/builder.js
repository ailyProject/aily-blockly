// 管理 aily-builder 工具链的安装、环境配置和构建任务调用。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ipcMain } = require('electron');

const {
  applyManagedCommandEnv,
  createManagedToolLifecycle,
  getManagedNpmPrefix,
  probeManagedCommand,
  resolveManagedBinPath,
} = require('./managed-npm-cli');

const AILY_BUILDER_KEY = 'aily-builder';
const PACKAGE_NAME = '@aily-project/aily-builder';

let getMainWindow = () => null;
let handlersRegistered = false;

function configureCacheEnvironment() {
  // Builder data/cache root; npm installation is managed separately by AILY_NPM_PREFIX.
  if (process.platform === 'win32') {
    process.env.AILY_BUILDER_PATH = path.join(os.homedir(), 'AppData', 'Local', 'aily-builder');
  } else if (process.platform === 'darwin') {
    process.env.AILY_BUILDER_PATH = path.join(os.homedir(), 'Library', 'Caches', 'aily-builder');
  } else {
    process.env.AILY_BUILDER_PATH = path.join(os.homedir(), '.cache', 'aily-builder');
  }
}

function getAilyBuilderCommandPath() {
  return resolveManagedBinPath({
    binKey: AILY_BUILDER_KEY,
    prefix: getManagedNpmPrefix(),
  });
}

function probeAilyBuilderCommand({ prefix = getManagedNpmPrefix() } = {}) {
  return probeManagedCommand({
    packageName: PACKAGE_NAME,
    binKey: AILY_BUILDER_KEY,
    prefix,
    commandNotFoundError: 'aily-builder 命令不存在',
    packageIncompleteError: `${PACKAGE_NAME} 未安装完整`,
  });
}

function sendNpmLog(log) {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('window-receive', {
    data: {
      action: 'log',
      log,
    },
  });
}

const lifecycle = createManagedToolLifecycle({
  toolKey: AILY_BUILDER_KEY,
  packageName: PACKAGE_NAME,
  probe: probeAilyBuilderCommand,
  emptyState: () => ({ path: getAilyBuilderCommandPath() }),
  missingChildPathError: 'AILY_CHILD_PATH 未设置',
  missingReadyError: 'aily-builder 命令不存在',
  installIncompleteError: `${PACKAGE_NAME} 安装完成但缺少 CLI 入口`,
  installError: `${PACKAGE_NAME} npm 安装失败`,
  npmLogMessages: {
    runningCommand: '执行命令',
    commandFailed: '命令执行失败',
  },
}, {
  prepareEnvironment: ({ prefix }) => applyManagedCommandEnv(prefix),
  afterInstall: ({ prefix }) => applyManagedCommandEnv(prefix),
  onNpmLog: sendNpmLog,
  isReadyStateCurrent: state => (
    getAilyBuilderCommandPath() === state.path
    && !!state.entryPath
    && fs.existsSync(state.entryPath)
  ),
});

function applyCommandEnv() {
  applyManagedCommandEnv();
}

function initialize(childPath, options = {}) {
  return lifecycle.initialize(childPath, null, options);
}

function waitForReady() {
  return lifecycle.waitForReady();
}

function registerHandlers(mainWindowProvider) {
  getMainWindow = typeof mainWindowProvider === 'function'
    ? mainWindowProvider
    : () => mainWindowProvider;
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle('aily-builder-status', async () => lifecycle.getStatus());
  ipcMain.handle('aily-builder-check-update', async () => lifecycle.checkForUpdate());
  ipcMain.handle('aily-builder-wait-ready', async () => {
    const result = await lifecycle.waitForReady();
    if (!result.ok) {
      throw new Error(result.error || 'aily-builder 未安装或启动初始化失败');
    }
    return { version: result.version };
  });
  ipcMain.handle('aily-builder-update', async () => {
    const { installResult, readyResult } = await lifecycle.performInstallMutation({
      reason: 'manual',
      force: true,
    });
    const result = installResult.ok ? readyResult : installResult;
    if (!result.ok) {
      throw new Error(result.error || 'aily-builder npm 安装失败');
    }
    return { version: result.version, status: lifecycle.getStatus() };
  });
}

module.exports = {
  applyCommandEnv,
  configureCacheEnvironment,
  initialize,
  registerHandlers,
  waitForReady,
};
