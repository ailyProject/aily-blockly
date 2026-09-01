// 管理应用更新检查、下载、取消和安装流程。
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require("electron");
const { normalizeBuildProduct } = require('./build-product');
// 添加autoUpdater引入
const { autoUpdater, CancellationToken } = require('electron-updater');
const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');

let cancellationToken = null;
let checkedUpdateInfoAndProvider = null;
let downloadMirrorFallbackInProgress = false;
let activeDownloadAttempt = null;
let forcedUpdateManifestSourceApplied = false;
let cachedPackagedBuildFlavor;
let cachedPackagedBuildProduct;
const LEGACY_MIN_AVERAGE_SPEED_BYTES_PER_SECOND = 65536;
const DEFAULT_MIN_AVERAGE_SPEED_BYTES_PER_SECOND = 262144;
const UPDATE_REQUEST_TRACKER_INSTALLED = Symbol('updateRequestTrackerInstalled');

function logUpdater(message, data) {
  const text = data === undefined
    ? `[Updater] ${message}`
    : `[Updater] ${message} ${JSON.stringify(data)}`;
  if (autoUpdater.logger && typeof autoUpdater.logger.info === 'function') {
    autoUpdater.logger.info(text);
    return;
  }

  console.log(text);
}

function loadMergedConfig() {
  const configPath = path.join(__dirname, 'config', 'config.json');
  let config = {};

  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.warn('读取默认配置失败:', error.message || error);
  }

  const userConfigPath = process.env.AILY_APPDATA_PATH
    ? path.join(process.env.AILY_APPDATA_PATH, 'config.json')
    : '';

  if (userConfigPath && fs.existsSync(userConfigPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
      config = {
        ...config,
        ...userConfig,
        regions: {
          ...(config.regions || {}),
          ...(userConfig.regions || {}),
        },
        update_download_strategy: {
          ...(config.update_download_strategy || {}),
          ...(userConfig.update_download_strategy || {}),
        },
      };
    } catch (error) {
      console.warn('读取用户配置失败:', error.message || error);
    }
  }

  return config;
}

function normalizeBuildFlavor(flavor) {
  return String(flavor || '').trim().toLowerCase() === 'global' ? 'global' : 'cn';
}

function resolveProductUpdaterUrl(baseUrl, product) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized || normalizeBuildProduct(product) !== 'coder') return normalized;
  return /\/blockly$/i.test(normalized)
    ? normalized.replace(/\/blockly$/i, '/coder')
    : `${normalized}/coder`;
}

function getPackagedBuildFlavor() {
  if (cachedPackagedBuildFlavor !== undefined) {
    return cachedPackagedBuildFlavor;
  }

  const candidatePaths = [];
  try {
    candidatePaths.push(path.join(app.getAppPath(), 'package.json'));
  } catch (error) {
    // ignore before app is fully ready
  }
  candidatePaths.push(path.join(__dirname, '..', 'package.json'));

  for (const packageJsonPath of candidatePaths) {
    try {
      if (!packageJsonPath || !fs.existsSync(packageJsonPath)) {
        continue;
      }

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      cachedPackagedBuildFlavor = packageJson.ailyBuildFlavor;
      return cachedPackagedBuildFlavor;
    } catch (error) {
      console.warn('读取构建版型失败:', error.message || error);
    }
  }

  cachedPackagedBuildFlavor = null;
  return cachedPackagedBuildFlavor;
}

function getPackagedBuildProduct() {
  if (cachedPackagedBuildProduct !== undefined) {
    return cachedPackagedBuildProduct;
  }

  const candidatePaths = [];
  try {
    candidatePaths.push(path.join(app.getAppPath(), 'package.json'));
  } catch (error) {
    // ignore before app is fully ready
  }
  candidatePaths.push(path.join(__dirname, '..', 'package.json'));

  for (const packageJsonPath of candidatePaths) {
    try {
      if (!packageJsonPath || !fs.existsSync(packageJsonPath)) {
        continue;
      }

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      cachedPackagedBuildProduct = packageJson.ailyBuildProduct;
      return cachedPackagedBuildProduct;
    } catch (error) {
      console.warn('读取构建产品失败:', error.message || error);
    }
  }

  cachedPackagedBuildProduct = null;
  return cachedPackagedBuildProduct;
}

function getCurrentBuildFlavor(config) {
  return normalizeBuildFlavor(process.env.AILY_BUILD_FLAVOR || getPackagedBuildFlavor() || config.build_flavor);
}

function getCurrentBuildProduct(config) {
  return normalizeBuildProduct(
    process.env.AILY_BUILD_PRODUCT
    || getPackagedBuildProduct(),
  );
}

function isChinaTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return (
      timezone === 'Asia/Shanghai' ||
      timezone === 'Asia/Chongqing' ||
      timezone === 'Asia/Urumqi' ||
      timezone === 'Asia/Harbin'
    );
  } catch {
    return new Date().getTimezoneOffset() === -480;
  }
}

function isSimplifiedChineseLanguage(config) {
  const rawLanguage = String(
    config.selectedLanguage ||
    config.lang ||
    app.getLocale() ||
    ''
  ).trim();
  const normalizedLanguage = rawLanguage.replace('-', '_').toLowerCase();

  return normalizedLanguage === 'zh_cn';
}

function getForcedUpdateManifestSource() {
  const config = loadMergedConfig();

  if (getCurrentBuildFlavor(config) === 'cn') {
    return null;
  }

  if (!isChinaTimezone() || !isSimplifiedChineseLanguage(config)) {
    return null;
  }

  const updaterUrl = resolveProductUpdaterUrl(
    config.regions && config.regions.cn && config.regions.cn.updater,
    getCurrentBuildProduct(config),
  );
  if (typeof updaterUrl !== 'string' || updaterUrl.trim() === '') {
    return null;
  }

  return {
    provider: 'generic',
    url: updaterUrl.trim().replace(/\/+$/, ''),
    reason: 'china-timezone-and-zh-cn-language',
  };
}

async function applyUpdateManifestSourceBeforeCheck() {
  const source = getForcedUpdateManifestSource();
  if (source) {
    autoUpdater.setFeedURL({
      provider: source.provider,
      url: source.url,
    });
    forcedUpdateManifestSourceApplied = true;
    logUpdater('forced update manifest source', {
      reason: source.reason,
      url: joinUrl(source.url, getChannelFileName()),
    });

    return source;
  }

  if (forcedUpdateManifestSourceApplied) {
    try {
      const config = normalizePublishConfig(await autoUpdater.configOnDisk.value);
      if (config && config.url) {
        autoUpdater.setFeedURL(config);
        logUpdater('restored packaged update manifest source', {
          provider: config.provider || 'generic',
          url: joinUrl(config.url, getChannelFileName()),
        });
      }
    } catch (error) {
      logUpdater('failed to restore packaged update manifest source', {
        error: serializeError(error),
      });
    } finally {
      forcedUpdateManifestSourceApplied = false;
    }
  }

  return null;
}

function getTargetUpdateBuildFlavor(updateInfo) {
  if (!updateInfo) {
    return null;
  }

  const declaredFlavor = String(
    updateInfo.ailyBuildFlavor || updateInfo.buildFlavor || updateInfo.build_flavor || ''
  ).trim().toLowerCase();
  if (declaredFlavor === 'cn' || declaredFlavor === 'global') {
    return declaredFlavor;
  }

  const filePaths = [];
  if (Array.isArray(updateInfo.files)) {
    for (const file of updateInfo.files) {
      const filePath = typeof file === 'string' ? file : file && (file.url || file.path);
      if (filePath) {
        filePaths.push(String(filePath));
      }
    }
  }
  if (updateInfo.path) {
    filePaths.push(String(updateInfo.path));
  }

  const normalizedPaths = filePaths.join('\n').toLowerCase();
  if (normalizedPaths.includes('aily-blockly-cn-')) {
    return 'cn';
  }
  if (normalizedPaths.includes('aily-blockly-')) {
    return 'global';
  }

  return null;
}

function getDownloadMirrorSources(updateInfo) {
  if (getTargetUpdateBuildFlavor(updateInfo) !== 'cn') {
    return [];
  }

  const config = loadMergedConfig();
  const buildProduct = getCurrentBuildProduct(config);
  const strategy = config.update_download_strategy || {};

  if (strategy.enabled === false) {
    return [];
  }

  const regions = config.regions || {};
  const regionOrder = Array.isArray(strategy.mirror_region_order) && strategy.mirror_region_order.length > 0
    ? strategy.mirror_region_order
    : ['eu', 'cn'];

  const seenUrls = new Set();
  return regionOrder
    .map((regionKey) => {
      const updaterUrl = resolveProductUpdaterUrl(
        regions[regionKey] && regions[regionKey].updater,
        buildProduct,
      );
      if (typeof updaterUrl !== 'string' || updaterUrl.trim() === '') {
        return null;
      }

      const url = updaterUrl.trim().replace(/\/+$/, '');
      if (seenUrls.has(url)) {
        return null;
      }

      seenUrls.add(url);
      return { region: regionKey, url };
    })
    .filter(Boolean);
}

function shouldFallbackOnDownloadError() {
  const config = loadMergedConfig();
  const strategy = config.update_download_strategy || {};
  return strategy.fallback_on_error !== false;
}

function getDownloadGuardConfig() {
  const config = loadMergedConfig();
  const strategy = config.update_download_strategy || {};

  const firstByteTimeoutMs = Number(strategy.first_byte_timeout_ms);
  const stallTimeoutMs = Number(strategy.stall_timeout_ms);
  const lowSpeedWindowMs = Number(strategy.low_speed_window_ms);
  const configuredMinAverageSpeedBytesPerSecond = Number(strategy.min_average_speed_bytes_per_second);
  // User config files persist defaults, so migrate only the exact legacy value.
  const minAverageSpeedBytesPerSecond = configuredMinAverageSpeedBytesPerSecond === LEGACY_MIN_AVERAGE_SPEED_BYTES_PER_SECOND
    ? DEFAULT_MIN_AVERAGE_SPEED_BYTES_PER_SECOND
    : configuredMinAverageSpeedBytesPerSecond;

  return {
    firstByteTimeoutMs: Number.isFinite(firstByteTimeoutMs) && firstByteTimeoutMs > 0
      ? firstByteTimeoutMs
      : 0,
    stallTimeoutMs: Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0
      ? stallTimeoutMs
      : 0,
    lowSpeedWindowMs: Number.isFinite(lowSpeedWindowMs) && lowSpeedWindowMs > 0
      ? lowSpeedWindowMs
      : 0,
    minAverageSpeedBytesPerSecond: Number.isFinite(minAverageSpeedBytesPerSecond) && minAverageSpeedBytesPerSecond > 0
      ? minAverageSpeedBytesPerSecond
      : 0,
  };
}

function createMirrorProvider(url) {
  const runtimeOptions = typeof autoUpdater.createProviderRuntimeOptions === 'function'
    ? autoUpdater.createProviderRuntimeOptions()
    : {
        executor: autoUpdater.httpExecutor,
        platform: process.platform,
        isUseMultipleRangeRequest: false,
      };

  return new GenericProvider(
    { provider: 'generic', url },
    autoUpdater,
    {
      ...runtimeOptions,
      isUseMultipleRangeRequest: false,
    }
  );
}

function getPlatformChannelPrefix() {
  if (process.platform === 'darwin') {
    return '-mac';
  }

  if (process.platform === 'linux') {
    const arch = process.env.TEST_UPDATER_ARCH || process.arch;
    return arch === 'x64' ? '-linux' : `-linux-${arch}`;
  }

  return '';
}

function getChannelFileName() {
  const channel = autoUpdater.channel || 'latest';
  return `${channel}${getPlatformChannelPrefix()}.yml`;
}

function joinUrl(baseUrl, fileName) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${fileName.replace(/^\/+/, '')}`;
}

function normalizePublishConfig(config) {
  if (Array.isArray(config)) {
    return config[0] || null;
  }
  return config || null;
}

async function logDefaultUpdateCheckUrl() {
  try {
    const config = normalizePublishConfig(await autoUpdater.configOnDisk.value);
    if (config && config.url) {
      logUpdater('checking update manifest', {
        provider: config.provider || 'generic',
        url: joinUrl(config.url, getChannelFileName()),
      });
    } else {
      logUpdater('checking update manifest with packaged updater config');
    }
  } catch (error) {
    logUpdater('checking update manifest, but failed to read updater config', {
      error: serializeError(error),
    });
  }
}

function getResolvedDownloadUrls(updateInfoAndProvider) {
  if (!updateInfoAndProvider || !updateInfoAndProvider.info || !updateInfoAndProvider.provider) {
    return [];
  }

  try {
    return updateInfoAndProvider.provider
      .resolveFiles(updateInfoAndProvider.info)
      .map((file) => file.url.href);
  } catch (error) {
    logUpdater('failed to resolve download urls', {
      error: serializeError(error),
    });
    return [];
  }
}

function isCancellationError(error) {
  if (isStrategyCancellationError(error)) {
    return false;
  }

  return Boolean(
    error &&
    (
      error.message === 'cancelled' ||
      error.name === 'CancellationError'
    )
  );
}

function isStrategyCancellationError(error) {
  return Boolean(error && error.name === 'DownloadStrategyCancellationError');
}

function createStrategyCancellationError(reason, mirror) {
  const reasonType = reason && reason.type ? reason.type : 'strategy-cancelled';
  const error = new Error(
    `Download cancelled by strategy (${reasonType})${mirror && mirror.region ? ` for ${mirror.region}` : ''}`
  );
  error.name = 'DownloadStrategyCancellationError';
  error.reason = reason;
  error.mirror = mirror;
  return error;
}

function createUserCancellationError() {
  const error = new Error('cancelled');
  error.name = 'CancellationError';
  return error;
}

function getFallbackReason(error) {
  if (isStrategyCancellationError(error)) {
    return error.reason || null;
  }

  return {
    type: 'download-error',
    error: serializeError(error),
  };
}

function serializeError(error) {
  if (!error) {
    return 'Unknown updater error';
  }
  return error.stack || error.message || error.toString();
}

function installUpdaterRequestTracking() {
  const executor = autoUpdater.httpExecutor;
  if (!executor || typeof executor.createRequest !== 'function') {
    throw new Error('electron-updater HTTP executor does not support request tracking');
  }
  if (executor[UPDATE_REQUEST_TRACKER_INSTALLED]) {
    return;
  }

  const originalCreateRequest = executor.createRequest;
  executor.createRequest = function(...args) {
    const request = originalCreateRequest.apply(this, args);
    const attempt = activeDownloadAttempt;
    if (attempt && request && typeof request.once === 'function') {
      attempt.requests.add(request);
      const abortRequest = () => request.abort();
      request.once('close', () => {
        attempt.cancellationToken.removeListener('cancel', abortRequest);
        attempt.requests.delete(request);
        if (attempt.requests.size === 0) {
          for (const resolve of attempt.requestCloseWaiters) {
            resolve();
          }
          attempt.requestCloseWaiters.clear();
        }
      });
      attempt.cancellationToken.onCancel(abortRequest);
    }
    return request;
  };
  executor[UPDATE_REQUEST_TRACKER_INSTALLED] = true;
}

function waitForTrackedDownloadRequests(attempt) {
  if (!attempt || attempt.requests.size === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    attempt.requestCloseWaiters.add(resolve);
    if (attempt.requests.size === 0) {
      attempt.requestCloseWaiters.delete(resolve);
      resolve();
    }
  });
}

function createDownloadAttemptGuard(mirror, token, options = {}) {
  const {
    firstByteTimeoutMs,
    stallTimeoutMs,
    lowSpeedWindowMs,
    minAverageSpeedBytesPerSecond,
  } = getDownloadGuardConfig();
  let firstByteReceived = false;
  let lastTransferred = 0;
  let lowSpeedWindowStartedAt = 0;
  let lowSpeedWindowStartTransferred = 0;
  let firstByteTimer = null;
  let stallTimer = null;
  let cancelReason = null;
  const shouldCancelOnLowSpeed = options.allowLowSpeedCancel === true
    && lowSpeedWindowMs > 0
    && minAverageSpeedBytesPerSecond > 0;

  function clearFirstByteTimer() {
    if (firstByteTimer) {
      clearTimeout(firstByteTimer);
      firstByteTimer = null;
    }
  }

  function clearStallTimer() {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function triggerStrategyCancel(reason) {
    if (cancelReason || token.cancelled) {
      return;
    }

    cancelReason = reason;
    if (activeDownloadAttempt) {
      activeDownloadAttempt.cancelReason = reason;
    }

    logUpdater('download guard triggered', {
      region: mirror && mirror.region,
      baseUrl: mirror && mirror.url,
      reason,
      transferred: lastTransferred,
    });

    token.cancel();
  }

  function scheduleFirstByteTimer() {
    if (firstByteTimeoutMs <= 0) {
      return;
    }

    firstByteTimer = setTimeout(() => {
      triggerStrategyCancel({
        type: 'first-byte-timeout',
        timeoutMs: firstByteTimeoutMs,
      });
    }, firstByteTimeoutMs);
  }

  function scheduleStallTimer() {
    clearStallTimer();
    if (stallTimeoutMs <= 0 || !firstByteReceived) {
      return;
    }

    stallTimer = setTimeout(() => {
      triggerStrategyCancel({
        type: 'stall-timeout',
        timeoutMs: stallTimeoutMs,
        transferred: lastTransferred,
      });
    }, stallTimeoutMs);
  }

  function resetLowSpeedWindow(transferred) {
    lowSpeedWindowStartedAt = Date.now();
    lowSpeedWindowStartTransferred = transferred;
  }

  function checkLowSpeed(transferred) {
    if (!shouldCancelOnLowSpeed || !firstByteReceived) {
      return;
    }

    if (!lowSpeedWindowStartedAt) {
      resetLowSpeedWindow(transferred);
      return;
    }

    const elapsedMs = Date.now() - lowSpeedWindowStartedAt;
    if (elapsedMs < lowSpeedWindowMs) {
      return;
    }

    const transferredInWindow = Math.max(0, transferred - lowSpeedWindowStartTransferred);
    const averageBytesPerSecond = transferredInWindow / (elapsedMs / 1000);
    if (averageBytesPerSecond < minAverageSpeedBytesPerSecond) {
      triggerStrategyCancel({
        type: 'low-speed',
        windowMs: lowSpeedWindowMs,
        averageBytesPerSecond: Math.round(averageBytesPerSecond),
        thresholdBytesPerSecond: minAverageSpeedBytesPerSecond,
        transferred,
      });
      return;
    }

    resetLowSpeedWindow(transferred);
  }

  function onDownloadProgress(progressObj) {
    const transferred = Number(progressObj && progressObj.transferred);
    const safeTransferred = Number.isFinite(transferred) ? transferred : 0;

    if (!firstByteReceived) {
      firstByteReceived = true;
      clearFirstByteTimer();
      logUpdater('download received first byte', {
        region: mirror && mirror.region,
        baseUrl: mirror && mirror.url,
        transferred: safeTransferred,
      });
      resetLowSpeedWindow(safeTransferred);
    }

    if (safeTransferred > lastTransferred) {
      lastTransferred = safeTransferred;
      scheduleStallTimer();
      checkLowSpeed(safeTransferred);
    }
  }

  autoUpdater.on('download-progress', onDownloadProgress);
  scheduleFirstByteTimer();

  return {
    getCancelReason() {
      return cancelReason;
    },
    dispose() {
      clearFirstByteTimer();
      clearStallTimer();
      autoUpdater.removeListener('download-progress', onDownloadProgress);
    },
  };
}

async function downloadWithCurrentProvider(mirror, options = {}) {
  cancellationToken = new CancellationToken();
  activeDownloadAttempt = {
    mirror,
    cancelReason: null,
    cancellationToken,
    requests: new Set(),
    requestCloseWaiters: new Set(),
  };
  const attemptGuard = createDownloadAttemptGuard(mirror, cancellationToken, options);
  logUpdater('downloading installer', {
    region: mirror && mirror.region,
    baseUrl: mirror && mirror.url,
    urls: getResolvedDownloadUrls(autoUpdater.updateInfoAndProvider),
  });
  try {
    return await autoUpdater.downloadUpdate(cancellationToken);
  } catch (error) {
    const reason = activeDownloadAttempt && activeDownloadAttempt.cancelReason
      ? activeDownloadAttempt.cancelReason
      : attemptGuard.getCancelReason();
    if (reason && reason.type !== 'user-cancelled') {
      throw createStrategyCancellationError(reason, mirror);
    }
    if (reason && !isCancellationError(error)) {
      throw createUserCancellationError();
    }

    throw error;
  } finally {
    attemptGuard.dispose();
    await waitForTrackedDownloadRequests(activeDownloadAttempt);
    activeDownloadAttempt = null;
    cancellationToken = null;
  }
}

async function downloadWithMirrors(mainWindow) {
  const baseUpdateInfoAndProvider = checkedUpdateInfoAndProvider || autoUpdater.updateInfoAndProvider;
  if (!baseUpdateInfoAndProvider || !baseUpdateInfoAndProvider.info) {
    throw new Error('Please check update first');
  }
  installUpdaterRequestTracking();

  const checkedInfo = baseUpdateInfoAndProvider.info;
  const targetBuildFlavor = getTargetUpdateBuildFlavor(checkedInfo);
  const mirrors = getDownloadMirrorSources(checkedInfo);
  if (mirrors.length === 0) {
    logUpdater('download mirror fallback disabled for target', {
      targetBuildFlavor: targetBuildFlavor || 'unknown',
    });
    return await downloadWithCurrentProvider();
  }

  const fallbackEnabled = shouldFallbackOnDownloadError();
  const originalUpdateInfoAndProvider = autoUpdater.updateInfoAndProvider;
  let lastError = null;

  downloadMirrorFallbackInProgress = true;
  try {
    for (let index = 0; index < mirrors.length; index++) {
      const mirror = mirrors[index];
      const mirrorProvider = createMirrorProvider(mirror.url);
      autoUpdater.updateInfoAndProvider = {
        info: checkedInfo,
        provider: mirrorProvider,
      };

      logUpdater('switching update download mirror', {
        region: mirror.region,
        baseUrl: mirror.url,
        urls: getResolvedDownloadUrls(autoUpdater.updateInfoAndProvider),
      });

      if (index > 0) {
        mainWindow?.webContents.send('update-status', {
          status: 'mirror-switching',
          source: mirror,
          index,
          total: mirrors.length,
        });
      }

      try {
        return await downloadWithCurrentProvider(mirror, {
          allowLowSpeedCancel: index < mirrors.length - 1,
        });
      } catch (error) {
        lastError = error;
        if (!isStrategyCancellationError(error) && isCancellationError(error)) {
          throw error;
        }

        const fallbackReason = getFallbackReason(error);
        console.error(`Download from updater mirror failed (${mirror.region}, ${mirror.url}):`, error);
        logUpdater('download attempt failed', {
          region: mirror.region,
          baseUrl: mirror.url,
          reason: fallbackReason,
        });

        const hasNextMirror = index < mirrors.length - 1;
        if (!fallbackEnabled || !hasNextMirror) {
          throw error;
        }
      }
    }
  } finally {
    downloadMirrorFallbackInProgress = false;
    if (lastError) {
      autoUpdater.updateInfoAndProvider = originalUpdateInfoAndProvider || baseUpdateInfoAndProvider;
    }
  }

  throw lastError || new Error('No updater mirror was available');
}

function cancelActiveDownload() {
  if (!cancellationToken) {
    return;
  }
  if (activeDownloadAttempt) {
    activeDownloadAttempt.cancelReason = {
      type: 'user-cancelled',
    };
  }
  cancellationToken.cancel();
}

// 添加自动更新处理函数
function registerUpdaterHandlers(mainWindow) {

  // 强制使用开发环境配置
  // if (process.env.DEV === 'true' || process.env.DEV === true) {
  //   autoUpdater.forceDevUpdateConfig = true;
  //   autoUpdater.allowDowngrade = true;
  //   autoUpdater.logger = require("electron-log");
  //   autoUpdater.logger.transports.file.level = "debug";
  // }

  autoUpdater.autoDownload = false;  // 禁用自动下载
  // autoUpdater.allowDowngrade = true; // 允许版本降级
  autoUpdater.useMultipleRangeRequest = false; // 禁用多范围请求
  autoUpdater.disableDifferentialDownload = true; // 禁用差量下载，使用完整下载

  // 添加IPC处理程序，允许从渲染进程手动检查更新
  ipcMain.handle('check-for-updates', async () => {
    await applyUpdateManifestSourceBeforeCheck();
    await logDefaultUpdateCheckUrl();
    const result = await autoUpdater.checkForUpdates();
    // console.log('检查更新结果:', result);
    return JSON.parse(JSON.stringify(result))
  });

  // 添加IPC处理程序，允许从渲染进程安装更新
  ipcMain.on('quit-and-install', () => {
    autoUpdater.quitAndInstall();
  });

  // 添加IPC处理程序，手动下载更新
  ipcMain.handle('start-download', async () => {
    if (!cancellationToken) { // 防止重复下载
      try {
        const result = await downloadWithMirrors(mainWindow);
        console.log('Download finished:', result);
        return result;
      } catch (error) {
        if (isCancellationError(error)) {
          console.log('Download cancelled by user.');
          mainWindow?.webContents.send('download-cancelled'); // 发送取消事件
        } else {
          console.error('Download error:', error);
          mainWindow?.webContents.send('update-status', { // 使用 update-status 通道报告错误
            status: 'error',
            error: serializeError(error)
          });
        }
      } finally {
        cancellationToken = null; // 出错或取消后重置
      }
    }
  });

  // 添加IPC处理程序，取消下载更新
  ipcMain.handle('cancel-download', () => {
    cancelActiveDownload();
  });

  // 日志设置
  autoUpdater.logger = require("electron-log");
  autoUpdater.logger.transports.file.level = "info";

  // 设置检查更新时发送状态到渲染进程
  autoUpdater.on('checking-for-update', () => {
    mainWindow.webContents.send('update-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    checkedUpdateInfoAndProvider = autoUpdater.updateInfoAndProvider || checkedUpdateInfoAndProvider;
    logUpdater('update available', {
      version: info && info.version,
      urls: getResolvedDownloadUrls(checkedUpdateInfoAndProvider),
    });
    mainWindow.webContents.send('update-status', {
      status: 'available',
      info: info
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    checkedUpdateInfoAndProvider = null;
    logUpdater('update not available', {
      version: info && info.version,
    });
    mainWindow.webContents.send('update-status', {
      status: 'not-available',
      info: info
    });
  });

  autoUpdater.on('error', (err) => {
    // 这个监听器主要处理检查更新阶段或非下载过程中的错误
    // 下载过程中的错误（包括取消）在 downloadUpdate 的 catch 中处理
    console.error('Updater error:', err);
    // 如果下载正在进行中被取消，这里的错误可能也会触发，但我们已经在 catch 中处理了
    // 避免重复发送错误状态，除非 token 已经是 null (表示非下载错误)
    if (!cancellationToken && !downloadMirrorFallbackInProgress) {
        mainWindow.webContents.send('update-status', {
          status: 'error',
          error: serializeError(err)
        });
    }
    // 确保 token 在任何错误后都被重置
    if (!downloadMirrorFallbackInProgress && !activeDownloadAttempt) {
      cancellationToken = null;
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow.webContents.send('update-status', {
      status: 'progress',
      progress: progressObj
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow.webContents.send('update-status', {
      status: 'downloaded',
      info: info
    });
  });

  // 启动时检查更新
  // autoUpdater.checkForUpdates();
}


module.exports = {
  registerUpdaterHandlers,
  __testing: {
    cancelActiveDownload,
    createStrategyCancellationError,
    downloadWithMirrors,
    getDownloadGuardConfig,
    getDownloadMirrorSources,
    getTargetUpdateBuildFlavor,
    resolveProductUpdaterUrl,
    isCancellationError,
    isStrategyCancellationError,
  },
};
