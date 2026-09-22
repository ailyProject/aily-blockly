// Manage the standalone aily-linter installation and readiness lifecycle.
const fs = require('node:fs');
const { ipcMain } = require('electron');

const {
  applyManagedCommandEnv,
  createManagedToolLifecycle,
  getManagedNpmPrefix,
  probeManagedCommand,
  resolveManagedBinPath,
  resolveManagedPackage,
} = require('./managed-npm-cli');

const TOOL_KEY = 'aily-linter';
const PACKAGE_NAME = '@aily-project/aily-linter';

let getMainWindow = () => null;
let handlersRegistered = false;

function getAilyLinterCommandPath() {
  return resolveManagedBinPath({
    binKey: TOOL_KEY,
    prefix: getManagedNpmPrefix(),
  });
}

function getAilyLinterEntryPath() {
  return resolveManagedPackage({
    packageName: PACKAGE_NAME,
    binKey: TOOL_KEY,
    prefix: getManagedNpmPrefix(),
  })?.entryPath || '';
}

function probeAilyLinterCommand({ prefix = getManagedNpmPrefix() } = {}) {
  return probeManagedCommand({
    packageName: PACKAGE_NAME,
    binKey: TOOL_KEY,
    prefix,
    commandNotFoundError: 'aily-linter command was not found in the configured npm prefix',
    packageIncompleteError: `${PACKAGE_NAME} is installed but its CLI entry file is missing`,
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

function linterStateFilesExist(state) {
  return !!state.path
    && fs.existsSync(state.path)
    && !!state.entryPath
    && fs.existsSync(state.entryPath);
}

const lifecycle = createManagedToolLifecycle({
  toolKey: TOOL_KEY,
  packageName: PACKAGE_NAME,
  probe: probeAilyLinterCommand,
  emptyState: () => ({
    path: getAilyLinterCommandPath(),
    entryPath: getAilyLinterEntryPath(),
  }),
  missingChildPathError: 'AILY_CHILD_PATH is not configured',
  missingReadyError: 'aily-linter command or entry file is missing',
  installIncompleteError: `${PACKAGE_NAME} installed but the aily-linter command is unavailable`,
  installError: `${PACKAGE_NAME} npm installation failed`,
  statusFields: state => ({
    path: state.path,
    entryPath: state.entryPath,
  }),
  npmLogMessages: {
    runningCommand: 'Running command',
    commandFailed: 'Command failed',
  },
}, {
  prepareEnvironment: ({ prefix }) => applyManagedCommandEnv(prefix),
  afterInstall: ({ prefix }) => applyManagedCommandEnv(prefix),
  onNpmLog: sendNpmLog,
  canReuseReadyState: () => false,
  isStatusStateValid: linterStateFilesExist,
});

function initialize(childPath, prerequisitePromise, options = {}) {
  return lifecycle.initialize(childPath, prerequisitePromise, options);
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

  ipcMain.handle('aily-linter-status', async () => lifecycle.getStatus());
  ipcMain.handle('aily-linter-check-update', async () => lifecycle.checkForUpdate());
  ipcMain.handle('aily-linter-wait-ready', async () => {
    const result = await lifecycle.waitForReady();
    if (!result.ok) {
      throw new Error(result.error || 'aily-linter is not installed or failed to initialize');
    }
    return { version: result.version, path: result.path, entryPath: result.entryPath };
  });
  ipcMain.handle('aily-linter-update', async () => {
    const { installResult, readyResult } = await lifecycle.performInstallMutation({
      force: true,
      reason: 'manual',
    });
    const result = installResult.ok ? readyResult : installResult;
    if (!result.ok) {
      throw new Error(result.error || 'aily-linter npm installation failed');
    }
    return { version: result.version, status: lifecycle.getStatus() };
  });
}

module.exports = {
  initialize,
  registerHandlers,
  waitForReady,
};
