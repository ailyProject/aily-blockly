const path = require("path");
const os = require("os");
const fs = require("fs");
const WinState = require('electron-win-state').default;
const { app, BrowserWindow, ipcMain, dialog, screen, shell, net, Menu } = require("electron");

const { isWin32, isDarwin, isLinux } = require("./platform");
const projectLock = require("./project-lock");

// 设置应用名称，用于 Windows 系统通知显示
app.setName("aily blockly");
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
// 禁用 GPU 着色器磁盘缓存，避免 GPUCache 累积导致启动变慢
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// 限制 HTTP 磁盘缓存为 100MB，防止无限增长
app.commandLine.appendSwitch('disk-cache-size', '104857600');
// Windows 系统中设置 AppUserModelID，用于通知分组和显示
if (isWin32) {
  app.setAppUserModelId("pro.aily.blockly");
}

const PROTOCOL = "abis";

// OAuth实例管理
const OAUTH_STATE_FILE = 'oauth-instances.json';

// 获取OAuth状态文件路径
function getOAuthStateFilePath() {
  // 获取原始用户数据路径（在设置实例隔离之前的路径）
  let originalUserDataPath;

  if (shouldUseMultiInstance()) {
    // 在多实例模式下，需要获取原始的用户数据路径
    const currentPath = app.getPath('userData');
    const instancesMatch = currentPath.match(/(.*)[/\\]instances[/\\][^/\\]+$/);
    if (instancesMatch) {
      originalUserDataPath = instancesMatch[1];
    } else {
      // 如果路径不包含 instances，可能是第一次运行或路径格式不同
      originalUserDataPath = currentPath;
    }
  } else {
    originalUserDataPath = app.getPath('userData');
  }

  return path.join(originalUserDataPath, OAUTH_STATE_FILE);
}

// 注册当前实例为OAuth发起者
function registerOAuthInstance(state) {
  try {
    const stateFilePath = getOAuthStateFilePath();
    const currentUserDataPath = app.getPath('userData');

    const instanceInfo = {
      instanceId: process.pid, // 使用进程ID作为实例标识
      userDataPath: currentUserDataPath,
      timestamp: Date.now(),
      state: state
    };

    // console.log('注册OAuth实例信息:', {
    //   state,
    //   instanceId: instanceInfo.instanceId,
    //   userDataPath: currentUserDataPath,
    //   stateFilePath
    // });

    let oauthStates = {};
    if (fs.existsSync(stateFilePath)) {
      try {
        oauthStates = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      } catch (error) {
        console.warn('读取OAuth状态文件失败，将创建新文件:', error);
        oauthStates = {};
      }
    }

    oauthStates[state] = instanceInfo;

    // 清理超过10分钟的过期状态
    const now = Date.now();
    Object.keys(oauthStates).forEach(key => {
      if (now - oauthStates[key].timestamp > 10 * 60 * 1000) {
        delete oauthStates[key];
      }
    });

    // 确保状态文件目录存在
    const stateFileDir = path.dirname(stateFilePath);
    if (!fs.existsSync(stateFileDir)) {
      fs.mkdirSync(stateFileDir, { recursive: true });
    }

    fs.writeFileSync(stateFilePath, JSON.stringify(oauthStates, null, 2));
    // console.log('已注册OAuth状态:', state, '实例ID:', instanceInfo.instanceId);
    // console.log('OAuth状态文件内容:', oauthStates);

    return instanceInfo;
  } catch (error) {
    console.error('注册OAuth实例失败:', error);
    return null;
  }
}

// 查找OAuth回调对应的实例
function findOAuthInstance(state) {
  try {
    const stateFilePath = getOAuthStateFilePath();
    console.log('查找OAuth实例，状态文件路径:', stateFilePath);

    if (!fs.existsSync(stateFilePath)) {
      console.log('OAuth状态文件不存在:', stateFilePath);
      return null;
    }

    const oauthStates = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    console.log('OAuth状态文件内容:', oauthStates);
    console.log('查找状态:', state);

    const instanceInfo = oauthStates[state];

    if (instanceInfo) {
      console.log('找到匹配的实例信息:', instanceInfo);

      // 检查实例是否仍然存在（通过检查用户数据目录）
      if (fs.existsSync(instanceInfo.userDataPath)) {
        console.log('目标实例目录存在:', instanceInfo.userDataPath);
        return instanceInfo;
      } else {
        console.log('目标实例目录不存在，清理状态:', instanceInfo.userDataPath);
        // 清理不存在的实例
        delete oauthStates[state];
        fs.writeFileSync(stateFilePath, JSON.stringify(oauthStates, null, 2));
      }
    } else {
      console.log('未找到匹配的实例信息，可用状态:', Object.keys(oauthStates));
    }

    return null;
  } catch (error) {
    console.error('查找OAuth实例失败:', error);
    return null;
  }
}

// 向指定实例发送OAuth回调数据
function sendOAuthCallbackToInstance(instanceInfo, callbackData) {
  try {
    // 创建一个临时文件来传递回调数据给目标实例
    const callbackFilePath = path.join(instanceInfo.userDataPath, 'oauth-callback.json');
    fs.writeFileSync(callbackFilePath, JSON.stringify({
      ...callbackData,
      timestamp: Date.now()
    }));

    console.log('已将OAuth回调数据写入目标实例文件:', callbackFilePath);
    return true;
  } catch (error) {
    console.error('发送OAuth回调数据失败:', error);
    return false;
  }
}

// 检查指定 PID 的进程是否仍在运行
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 清理实例目录中导致启动变慢的 Chromium 缓存（保留 HTTP 缓存）
function clearSlowCaches(instancePath) {
  const slowCacheDirs = ['GPUCache', 'Code Cache'];
  for (const dir of slowCacheDirs) {
    const dirPath = path.join(instancePath, dir);
    if (fs.existsSync(dirPath)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch (e) {
        console.warn(`清理 ${dir} 失败:`, e.message);
      }
    }
  }
}

/** 当前进程持有的实例锁文件路径，用于退出时清理 */
let heldInstanceLockPath = null;

// 实例目录复用池：复用空闲实例目录，保留 HTTP 缓存（图片等），清理导致启动慢的缓存
function setupPooledUserDataPath() {
  const originalUserDataPath = app.getPath('userData');
  const instancesDir = path.join(originalUserDataPath, 'instances');

  // 确保 instances 目录存在
  if (!fs.existsSync(instancesDir)) {
    fs.mkdirSync(instancesDir, { recursive: true });
  }

  // 扫描现有实例目录，查找空闲的可复用目录
  let reusedPath = null;
  let maxIndex = -1;

  try {
    const entries = fs.readdirSync(instancesDir);
    for (const entry of entries) {
      // 只处理 instance-N 格式的目录
      const match = entry.match(/^instance-(\d+)$/);
      if (!match) continue;

      const index = parseInt(match[1], 10);
      if (index > maxIndex) maxIndex = index;

      if (reusedPath) continue; // 已找到可复用目录，只继续统计 maxIndex

      const instancePath = path.join(instancesDir, entry);
      const lockFilePath = path.join(instancePath, 'instance.lock');

      if (fs.existsSync(lockFilePath)) {
        try {
          const lockData = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
          if (lockData.pid && isProcessRunning(lockData.pid)) {
            // 进程仍在运行，该目录被占用
            continue;
          }
        } catch {
          // 锁文件损坏，视为空闲
        }
      }

      // 该目录空闲，可以复用
      reusedPath = instancePath;
    }
  } catch (e) {
    console.warn('扫描实例目录失败:', e.message);
  }

  // 如果没有可复用目录，创建新的 instance-N
  if (!reusedPath) {
    const newIndex = maxIndex + 1;
    reusedPath = path.join(instancesDir, `instance-${newIndex}`);
    fs.mkdirSync(reusedPath, { recursive: true });
    console.log('创建新实例目录:', reusedPath);
  } else {
    console.log('复用空闲实例目录:', reusedPath);
  }

  // 清理导致启动慢的缓存（GPUCache、Code Cache），保留 HTTP Cache
  clearSlowCaches(reusedPath);

  // 写入锁文件
  const lockFilePath = path.join(reusedPath, 'instance.lock');
  try {
    fs.writeFileSync(lockFilePath, JSON.stringify({
      pid: process.pid,
      startTime: Date.now()
    }));
    heldInstanceLockPath = lockFilePath;
  } catch (e) {
    console.warn('写入实例锁文件失败:', e.message);
  }

  // 设置 userData 到复用的目录
  app.setPath('userData', reusedPath);
  console.log('实例用户数据目录:', reusedPath);

  return reusedPath;
}

// 检查是否需要多实例模式
function shouldUseMultiInstance() {
  // 启用多实例模式，允许同时运行多个实例
  return true;
}

// 只有在需要多实例时才设置独立的用户数据目录
if (shouldUseMultiInstance()) {
  // 检查是否是协议启动
  const isProtocolLaunch = process.argv.some(arg => arg.startsWith(`${PROTOCOL}://`));

  if (!isProtocolLaunch) {
    // 只有非协议启动才设置实例隔离
    setupPooledUserDataPath();
  } else {
    console.log('协议启动，跳过实例隔离设置');
  }
}

app.removeAsDefaultProtocolClient(PROTOCOL);

const args = process.argv.slice(1);
const serve = args.some((val) => val === "--serve");
process.env.DEV = serve;

// 注册协议处理
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// 文件关联处理
let pendingFileToOpen = null;
let pendingRoute = null;
let pendingQueryParams = null;
/** 当前主进程已持有的项目锁（规范化路径） */
let heldProjectLockNormalized = null;

function getProjectLockStringsForMain() {
  const defaults = {
    LOCK_CONFLICT_TITLE: "Project already open",
    LOCK_CONFLICT_MESSAGE: "Another window or version may be editing this project.",
    LOCK_CANCEL: "Cancel",
    LOCK_FOCUS_OTHER: "Bring to front",
    LOCK_FORCE_OPEN: "Open anyway",
  };
  try {
    const loc = (app.getLocale() || "").toLowerCase();
    const pack = loc.startsWith("zh") ? "zh_cn" : "en";
    const fp = path.join(__dirname, `../public/i18n/${pack}/${pack}.json`);
    if (!fs.existsSync(fp)) {
      return defaults;
    }
    const j = JSON.parse(fs.readFileSync(fp, "utf8"));
    const P = j.PROJECT || {};
    return {
      LOCK_CONFLICT_TITLE: P.LOCK_CONFLICT_TITLE || defaults.LOCK_CONFLICT_TITLE,
      LOCK_CONFLICT_MESSAGE: P.LOCK_CONFLICT_MESSAGE || defaults.LOCK_CONFLICT_MESSAGE,
      LOCK_CANCEL: P.LOCK_CANCEL || defaults.LOCK_CANCEL,
      LOCK_FOCUS_OTHER: P.LOCK_FOCUS_OTHER || defaults.LOCK_FOCUS_OTHER,
      LOCK_FORCE_OPEN: P.LOCK_FORCE_OPEN || defaults.LOCK_FORCE_OPEN,
    };
  } catch (e) {
    console.warn("getProjectLockStringsForMain:", e);
    return defaults;
  }
}

function getMenuStringForMain(key, fallback) {
  try {
    const loc = (app.getLocale() || "").toLowerCase();
    const pack = loc.startsWith("zh") ? "zh_cn" : "en";
    const fp = path.join(__dirname, `../public/i18n/${pack}/${pack}.json`);
    if (!fs.existsSync(fp)) {
      return fallback;
    }
    const j = JSON.parse(fs.readFileSync(fp, "utf8"));
    const v = j.MENU && j.MENU[key];
    return v || fallback;
  } catch (e) {
    console.warn("getMenuStringForMain:", e);
    return fallback;
  }
}

/**
 * 打开项目目录前获取锁；冲突时弹出主进程对话框。
 * @returns {Promise<{ proceed: boolean }>}
 */
async function resolveProjectLockOrPrompt(projectDir, parentWindow) {
  const r = projectLock.tryAcquireLock(projectDir);
  if (r.ok) {
    heldProjectLockNormalized = r.normalizedPath;
    return { proceed: true };
  }
  if (r.conflict && r.holder) {
    const s = getProjectLockStringsForMain();
    const detail = `${s.LOCK_CONFLICT_MESSAGE}\nPID: ${r.holder.pid}\n${r.holder.execPath || ""}\n${r.holder.appVersion || ""}`;
    const { response } = await dialog.showMessageBox(parentWindow || undefined, {
      type: "warning",
      title: s.LOCK_CONFLICT_TITLE,
      message: s.LOCK_CONFLICT_TITLE,
      detail,
      buttons: [s.LOCK_CANCEL, s.LOCK_FOCUS_OTHER, s.LOCK_FORCE_OPEN],
      defaultId: 1,
      cancelId: 0,
    });
    if (response === 0) {
      return { proceed: false };
    }
    if (response === 1) {
      projectLock.focusProcessByPid(r.holder.pid);
      return { proceed: false };
    }
    const r2 = projectLock.tryAcquireLock(projectDir, { force: true });
    if (r2.ok) {
      heldProjectLockNormalized = r2.normalizedPath;
      return { proceed: true };
    }
    return { proceed: false };
  }
  console.warn("project lock failed:", r.error || r);
  return { proceed: false };
}

// 处理命令行参数中的 .abi 文件和路由参数
function handleCommandLineArgs(argv) {
  // 处理 .abi 文件
  const abiFile = argv.find(arg => arg.endsWith('.abi') && fs.existsSync(arg));
  if (abiFile) {
    const resolvedPath = path.resolve(abiFile);
    pendingFileToOpen = path.dirname(resolvedPath);
    console.log('Found .abi file to open:', resolvedPath);
    console.log('Project directory:', pendingFileToOpen);
    return true;
  }

  // 处理路由参数
  const routeArg = argv.find(arg => arg.startsWith('--route='));
  if (routeArg) {
    pendingRoute = routeArg.replace('--route=', '');
    console.log('Found route parameter:', pendingRoute);
  }

  // 处理查询参数
  const queryArg = argv.find(arg => arg.startsWith('--query='));
  if (queryArg) {
    try {
      const queryString = queryArg.replace('--query=', '');
      pendingQueryParams = JSON.parse(decodeURIComponent(queryString));
      console.log('Found query parameters:', pendingQueryParams);
    } catch (error) {
      console.error('解析查询参数失败:', error);
    }
  }

  return !!(abiFile || routeArg || queryArg);
}

// 在应用启动时处理命令行参数
handleCommandLineArgs(process.argv);

function handleProtocol(url) {
  console.log('收到协议链接:', url);

  try {
    const urlObj = new URL(url);

    // 自定义协议URL中，hostname 可能包含路径的第一部分
    // 例如 ailyblockly://auth/callback 中，hostname='auth', pathname='/callback'
    // 需要重新构建完整路径
    let fullPath = urlObj.pathname;
    if (urlObj.hostname && urlObj.hostname !== '') {
      fullPath = '/' + urlObj.hostname + urlObj.pathname;
    }

    // 检查是否是OAuth回调（使用完整路径）
    if (fullPath === '/auth/callback') {
      const searchParams = urlObj.searchParams;
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const error = searchParams.get('error');
      const errorDescription = searchParams.get('error_description');

      console.log('OAuth回调参数:', { code, state, error, errorDescription });

      // 构建回调数据
      const callbackData = {
        code,
        state,
        error,
        error_description: errorDescription
      };

      // 如果有state，尝试找到对应的实例
      if (state) {
        const targetInstance = findOAuthInstance(state);
        if (targetInstance) {
          console.log('找到目标实例:', targetInstance.instanceId, '当前实例路径:', app.getPath('userData'));

          // 如果目标实例就是当前实例
          if (targetInstance.userDataPath === app.getPath('userData')) {
            console.log('OAuth回调属于当前实例');
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.send('oauth-callback', callbackData);
              // 将窗口置前显示
              if (mainWindow.isMinimized()) {
                mainWindow.restore();
              }
              mainWindow.focus();
              mainWindow.show();
            } else {
              // 如果窗口不存在，存储回调数据以便稍后处理
              global.pendingOAuthCallback = callbackData;
            }
          } else {
            // OAuth回调属于其他实例，发送数据给目标实例并退出当前进程
            console.log('OAuth回调属于其他实例，转发回调数据到:', targetInstance.userDataPath);
            const success = sendOAuthCallbackToInstance(targetInstance, callbackData);
            if (success) {
              console.log('OAuth回调数据已转发，当前实例将退出');
              // 延迟退出，确保数据写入完成
              setTimeout(() => {
                app.quit();
              }, 100);
            } else {
              console.error('转发OAuth回调数据失败');
              // 转发失败时，也尝试在当前实例处理
              console.warn('转发失败，尝试在当前实例处理OAuth回调');
              if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.send('oauth-callback', callbackData);
                if (mainWindow.isMinimized()) {
                  mainWindow.restore();
                }
                mainWindow.focus();
                mainWindow.show();
              } else {
                global.pendingOAuthCallback = callbackData;
              }
            }
          }
          return;
        } else {
          console.warn('未找到对应的OAuth实例，state:', state, '将在当前实例处理');
        }
      } else {
        console.warn('OAuth回调缺少state参数');
      }

      // 如果没有找到对应实例或没有state，在当前实例处理
      console.log('在当前实例处理OAuth回调');
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('oauth-callback', callbackData);
        // 将窗口置前显示
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
        mainWindow.show();
      } else {
        // 如果窗口不存在，存储回调数据以便稍后处理
        global.pendingOAuthCallback = callbackData;
      }

      return;
    }

    // 检查是否是打开示例列表
    // 移除末尾斜杠以兼容不同情况
    const normalizedPath = fullPath.replace(/\/$/, '');
    if (normalizedPath === '/examples' || normalizedPath === '/open-examples' || normalizedPath === '/open-template') {
      const searchParams = urlObj.searchParams;
      const keyword = searchParams.get('keyword');
      const id = searchParams.get('templateId') || searchParams.get('id');
      const sessionId = searchParams.get('sessionId');
      const params = searchParams.get('params');
      const version = searchParams.get('version');

      // 优先使用 keyword，如果有 id 则作为 keyword
      const searchKeyword = keyword || id || '';

      console.log('打开示例列表:', { keyword, id, params, version, searchKeyword });

      const data = {
        keyword: searchKeyword,
        id: id || '',
        sessionId: sessionId || '',
        params: params || '',
        version: version || ''
      };

      if (mainWindow && mainWindow.webContents && isRendererReady) {
        mainWindow.webContents.send('open-example-list', data);
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
        mainWindow.show();
      } else {
        // 如果窗口不存在或未就绪，存储数据以便稍后处理
        console.log('窗口未就绪，缓存示例列表请求');
        global.pendingExampleListOpen = data;
      }
      return;
    }

    // 处理其他协议链接
    // dialog.showMessageBox({ message: `收到协议：${url}` });
  } catch (error) {
    console.error('解析协议链接失败:', error);
    // dialog.showErrorBox('协议错误', `无法解析协议链接: ${url}`);
  }
}

// ipc handlers模块
const { registerTerminalHandlers } = require("./terminal");
const { registerWindowHandlers } = require("./window");
const { registerNpmHandlers } = require("./npm");
const { registerUpdaterHandlers } = require("./updater");
const { registerCmdHandlers } = require("./cmd");
const { registerMCPHandlers } = require("./mcp");
// debug模块
const { initLogger, registerLoggerHandlers } = require("./logger");
// tools
const { registerToolsHandlers } = require("./tools");
const { registerNotificationHandlers } = require("./notification");
const { registerProbeRsHandlers } = require("./probe-rs");

let mainWindow;
let userConf;
let isRendererReady = false;

// 监听渲染进程就绪事件
ipcMain.on('renderer-ready', () => {
  console.log('渲染进程已就绪');
  isRendererReady = true;

  // 检查是否有待处理的OAuth回调
  if (global.pendingOAuthCallback) {
    console.log('发送待处理的OAuth回调');
    mainWindow.webContents.send('oauth-callback', global.pendingOAuthCallback);
    global.pendingOAuthCallback = null;
  }

  // 检查是否有待处理的示例列表打开请求
  if (global.pendingExampleListOpen) {
    console.log('发送待处理的示例列表请求');
    mainWindow.webContents.send('open-example-list', global.pendingExampleListOpen);
    global.pendingExampleListOpen = null;
  }
});

// macos检查安装环境
function macosInstallEnv(childPath) {
  const child_process = require("child_process");

  // 从文件名中提取版本号
  function extractVersion(filename, keyword) {
    // node 格式：node-v22.21.0-darwin-arm64.7z → 22.21.0
    // aily-builder 格式：aily-builder-1.0.7.7z → 1.0.7
    // probe-rs 格式：probe-rs-0.31.0.7z → 0.31.0
    if (keyword === "node") {
      const match = filename.match(/node-v(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } else if (keyword === "aily-builder") {
      const match = filename.match(/aily-builder-(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } else if (keyword === "probe-rs") {
      const match = filename.match(/probe-rs-(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    }
    return null;
  }

  // 比较语义化版本号
  function compareSemver(version1, version2) {
    if (!version1 || !version2) return 0;

    // 移除可能的 'v' 前缀
    const v1 = version1.replace(/^v/, '').split('.').map(Number);
    const v2 = version2.replace(/^v/, '').split('.').map(Number);

    // 确保两个版本号都有三个部分
    while (v1.length < 3) v1.push(0);
    while (v2.length < 3) v2.push(0);

    // 比较主版本号
    if (v1[0] !== v2[0]) {
      return v1[0] > v2[0] ? 1 : -1;
    }
    // 比较次版本号
    if (v1[1] !== v2[1]) {
      return v1[1] > v2[1] ? 1 : -1;
    }
    // 比较修订版本号
    if (v1[2] !== v2[2]) {
      return v1[2] > v2[2] ? 1 : -1;
    }
    return 0;
  }

  // 查找指定目录下关键字匹配的最新版本文件
  function findLatestVersionFile(directory, keyword) {
    try {
      if (!fs.existsSync(directory)) {
        return null;
      }

      const files = fs.readdirSync(directory);
      const matchingFiles = files.filter(file => {
        return file.startsWith(keyword) && file.endsWith('.7z');
      });

      if (matchingFiles.length === 0) {
        return null;
      }

      // 提取版本号并找到最新版本
      let latestFile = matchingFiles[0];
      let latestVersion = extractVersion(latestFile, keyword);

      for (let i = 1; i < matchingFiles.length; i++) {
        const currentVersion = extractVersion(matchingFiles[i], keyword);
        if (currentVersion && compareSemver(currentVersion, latestVersion) > 0) {
          latestFile = matchingFiles[i];
          latestVersion = currentVersion;
        }
      }

      return path.join(directory, latestFile);
    } catch (error) {
      console.error(`查找${keyword}文件失败:`, error);
      return null;
    }
  }

  const z7Name = "7zz";
  const z7Path = path.join(childPath, z7Name);
  if (serve && !fs.existsSync(z7Path)) {
    const z7SourcePath = path.join(childPath, "macos", z7Name);
    try {
      const escapeZ7SourcePath = escapePath(z7SourcePath);
      const escapeZ7Path = escapePath(z7Path);
      child_process.execSync(`cp ${escapeZ7SourcePath} ${escapeZ7Path}`, { stdio: 'inherit' });
      console.log('安装解压7zz成功！');
    } catch (error) {
      console.error("安装解压7zz失败，错误码:", error);
    }
  }
  const nodeName = "node";
  const nodePath = path.join(childPath, nodeName);
  if (!fs.existsSync(nodePath)) {
    const sourceDir = path.join(childPath, serve ? "macos" : "");
    const nodeZipPath = findLatestVersionFile(sourceDir, nodeName);
    if (nodeZipPath && fs.existsSync(nodeZipPath)) {
      try {
        const escapeNodePath = escapePath(nodePath);
        const escapeNodeZipPath = escapePath(nodeZipPath);
        child_process.execSync(`mkdir -p ${escapeNodePath} && tar -xzf ${escapeNodeZipPath} -C ${escapeNodePath}`, { stdio: 'inherit' });
        console.log(`安装解压 ${nodeName}: ${nodeZipPath}成功！`);
        if (!serve) fs.unlinkSync(nodeZipPath);
      } catch (error) {
        console.error(`安装解压 ${nodeName}: ${nodeZipPath}失败，错误码:`, error);
      }
    } else {
      console.error(`未找到 ${nodeName}: ${nodeZipPath}，搜索目录: ${sourceDir}`);
    }
  }
  const ailyBuilderName = "aily-builder";
  const ailyBuilderPath = path.join(childPath, ailyBuilderName);
  if (!fs.existsSync(ailyBuilderPath)) {
    const sourceDir = path.join(childPath, serve ? "macos" : "");
    const ailyBuilderZipPath = findLatestVersionFile(sourceDir, ailyBuilderName);
    if (ailyBuilderZipPath && fs.existsSync(ailyBuilderZipPath)) {
      try {
        const escapeAilyBuilderPath = escapePath(ailyBuilderPath);
        const escapeAilyBuilderZipPath = escapePath(ailyBuilderZipPath);
        child_process.execSync(`mkdir -p ${escapeAilyBuilderPath} && tar -xzf ${escapeAilyBuilderZipPath} -C ${escapeAilyBuilderPath}`, { stdio: 'inherit' });
        console.log(`安装解压 ${ailyBuilderName}: ${ailyBuilderZipPath}成功！`);
        if (!serve) fs.unlinkSync(ailyBuilderZipPath);
      } catch (error) {
        console.error(`安装解压 ${ailyBuilderName}: ${ailyBuilderZipPath}失败，错误码:`, error);
      }
    } else {
      console.error(`未找到 ${ailyBuilderName}: ${ailyBuilderZipPath}，搜索目录: ${sourceDir}`);
    }
  }
  const probeRsName = "probe-rs";
  const probeRsPath = path.join(childPath, probeRsName);
  if (!fs.existsSync(probeRsPath)) {
    const sourceDir = path.join(childPath, serve ? "macos" : "");
    const probeRsZipPath = findLatestVersionFile(sourceDir, probeRsName);
    if (probeRsZipPath && fs.existsSync(probeRsZipPath)) {
      if (!fs.existsSync(z7Path)) {
        console.error(`解压 ${probeRsName} 需要 7zz，但未找到: ${z7Path}`);
      } else {
        try {
          const escapeProbeRsPath = escapePath(probeRsPath);
          const escapeProbeRsZipPath = escapePath(probeRsZipPath);
          const escapeZ7Path = escapePath(z7Path);
          child_process.execSync(`mkdir -p ${escapeProbeRsPath} && ${escapeZ7Path} x ${escapeProbeRsZipPath} -o${escapeProbeRsPath} -t7z -y`, { stdio: 'inherit' });
          console.log(`安装解压 ${probeRsName}: ${probeRsZipPath}成功！`);
          if (!serve) fs.unlinkSync(probeRsZipPath);
        } catch (error) {
          console.error(`安装解压 ${probeRsName}: ${probeRsZipPath}失败，错误码:`, error);
        }
      }
    } else {
      console.error(`未找到 ${probeRsName}: ${probeRsZipPath}，搜索目录: ${sourceDir}`);
    }
  }
}

// 路径转义
function escapePath(path) {
  if (isWin32) {
    return path;
  }
  return path.replace(/(\s|[()&|;<>`$\\])/g, '\\$1');
}

// 检查URL延迟
function checkLatency(url, resource=false) {
  return new Promise((resolve) => {
    const start = Date.now();
    let pingUrl = url;
    if (!pingUrl.endsWith('/')) {
      pingUrl += '/';
    }
    if (resource) {
      pingUrl += 'boards-ai.json';
    } else {
      pingUrl += 'ping';
    }
    try {
      // console.log('[节点检测] Checking latency for URL:', pingUrl);
      const request = net.request({ method: 'HEAD', url: pingUrl });
      request.on('response', (response) => {
        const end = Date.now();
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ url, latency: end - start });
          } else {
            // console.warn(`[节点检测] ${pingUrl} 返回状态码: ${response.statusCode}`);
            resolve({ url, latency: Infinity, error: `Status ${response.statusCode}` });
          }
        });
        response.on('error', (err) => {
          // console.warn(`[节点检测] ${pingUrl} 响应错误:`, err);
          resolve({ url, latency: Infinity, error: 'Response error' });
        });
        response.resume();
      });
      request.on('error', (error) => {
        console.warn(`[节点检测] ${pingUrl} 请求错误:`, error);
        resolve({ url, latency: Infinity, error: error.message || 'Request error' });
      });
      request.end();
    } catch (e) {
      console.warn(`[节点检测] ${pingUrl} 异常:`, e);
      resolve({ url, latency: Infinity, error: e.message || 'Exception' });
    }
  });
}

// 获取最快URL
async function getFastestUrl(urls, item_key='') {

  console.log('[节点检测] 检测最快URL列表:', urls);
  if (!urls || urls.length === 0) return null;
  if (urls.length === 1) return urls[0];

  const isResource = item_key === 'resource';
  const timeout = isResource ? 8000 : 5000; // resource 检测需要下载文件，给更长超时
  
  try {
    // 使用 Promise.allSettled 确保获取所有结果，不会因为某个失败而中断
    const promises = urls.map(url => checkLatency(url, isResource));
    
    // 创建一个可以提前返回的 Promise
    // 当有任意一个成功的结果时，等待一小段时间收集更多结果后返回
    const results = await Promise.race([
      // 等待所有请求完成
      Promise.allSettled(promises).then(settled => 
        settled
          .filter(r => r.status === 'fulfilled')
          .map(r => r.value)
      ),
      // 超时后返回已完成的结果
      new Promise(resolve => {
        setTimeout(async () => {
          // 超时时，尝试获取已完成的 Promise 结果
          const settledResults = [];
          for (let i = 0; i < promises.length; i++) {
            try {
              // 使用 Promise.race 检查是否已完成
              const result = await Promise.race([
                promises[i],
                new Promise((_, reject) => setTimeout(() => reject(new Error('still pending')), 10))
              ]);
              settledResults.push(result);
            } catch (e) {
              // Promise 还未完成，跳过
            }
          }
          // console.log(`[节点检测] 超时(${timeout}ms)，已完成 ${settledResults.length}/${urls.length} 个检测`);
          resolve(settledResults);
        }, timeout);
      })
    ]);
    
    // console.log('[节点检测] results: ', results);
    
    if (!results || results.length === 0) {
      console.warn(`[节点检测] 超时且无结果，返回第一个节点: ${urls[0]}`);
      return urls[0];
    }
    
    const validResults = results.filter(r => r && r.latency !== Infinity);
    if (validResults.length === 0) {
      // 输出所有失败节点和原因
      // console.warn('[节点检测] 所有已完成的节点检测都失败，详细信息如下:');
      // results.forEach(r => {
      //   if (r) {
      //     console.warn(`  节点: ${r.url}, 错误: ${r.error || '未知'}, latency: ${r.latency}`);
      //   }
      // });
      console.warn(`[节点检测] 所有节点检测失败，返回第一个节点: ${urls[0]}`);
      return urls[0];
    }
    
    validResults.sort((a, b) => a.latency - b.latency);
    // console.log(`[节点检测] 成功检测 ${validResults.length} 个节点，最快: ${validResults[0].url} (${validResults[0].latency}ms)`);
    return validResults[0].url;
  } catch (e) {
    console.error('[节点检测] getFastestUrl error:', e);
    return urls[0];
  }
}

// 初始化最快服务器配置（非阻塞异步方式，不影响启动速度）
// 现在改为基于 region 配置，检测各个区域的服务延迟来自动选择最优区域
function initFastestServersAsync() {
  const configPath = path.join(__dirname, 'config', "config.json");
  if (!fs.existsSync(configPath)) return;
  
  try {
    const conf = JSON.parse(fs.readFileSync(configPath));
    const regions = conf.regions;
    if (!regions || Object.keys(regions).length === 0) return;

    // console.log('[节点检测] 后台开始检测最优区域节点...');
    
    // 获取所有启用区域的 api_server 进行延迟检测（过滤掉未启用的区域、空URL和localhost）
    const regionKeys = Object.keys(regions).filter(key => 
      key !== 'localhost' && regions[key].enabled && regions[key].api_server
    );
    const regionUrls = regionKeys.map(key => regions[key].api_server);
    
    getFastestUrl(regionUrls, 'api_server').then(fastestUrl => {
      if (fastestUrl) {
        // 找到对应的区域
        const fastestRegionKey = regionKeys.find(key => regions[key].api_server === fastestUrl);
        if (fastestRegionKey) {
          const fastestRegion = regions[fastestRegionKey];
          console.log(`[节点检测] 检测到最优区域: ${fastestRegion.name} (${fastestRegionKey})`);
          
          // 设置环境变量
          process.env.AILY_NPM_REGISTRY = fastestRegion.npm_registry;
          process.env.AILY_ZIP_URL = fastestRegion.resource;
          process.env.AILY_API_SERVER = fastestRegion.api_server;
          process.env.AILY_REGION = fastestRegionKey;
          
          // 通知渲染进程区域已更新
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('server-node-updated', { 
              region: fastestRegionKey,
              npm_registry: fastestRegion.npm_registry,
              resource: fastestRegion.resource,
              api_server: fastestRegion.api_server
            });
          }
          // console.log('[节点检测] 区域节点检测完成');
        }
      }
    }).catch(e => {
      console.error('[节点检测] 检测过程出错:', e);
    });
    
  } catch (e) {
    console.error('Error initializing fastest servers:', e);
  }
}

// 环境变量加载
function loadEnv() {
  // 将child目录添加到环境变量PATH中
  const childPath = serve
    ? path.join(__dirname, "..", "child")
    : path.join(process.resourcesPath, "child");
  const nodePath = path.join(childPath, isDarwin ? "node/bin" : "node");

  // 只保留PowerShell路径，移除其他系统PATH
  let customPath = nodePath + path.delimiter + childPath;

  if (isWin32) {
    // 使用环境变量获取系统路径，支持系统安装在任意盘符
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    
    // 添加必要的系统路径
    const systemPaths = [
      path.join(systemRoot, 'System32'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      path.join(programFiles, 'PowerShell', '7'), // PowerShell 7 (如果存在)
      systemRoot
    ];

    // 检查路径是否存在，只添加存在的路径
    systemPaths.forEach(sysPath => {
      if (fs.existsSync(sysPath)) {
        customPath += path.delimiter + sysPath;
      }
    });
  }
  if (isDarwin) {
    const systemPaths = [
      '/bin',
      '/usr/bin'
    ];
    systemPaths.forEach(sysPath => {
      if (fs.existsSync(sysPath)) {
        customPath += path.delimiter + sysPath;
      }
    });
  } else if (isLinux) {
    customPath += path.delimiter + '/bin';
  }

  // 完全替换PATH
  process.env.PATH = customPath;  

  // 读取config.json文件
  const configPath = path.join(__dirname, 'config', "config.json");
  const conf = JSON.parse(fs.readFileSync(configPath));

  // 设置系统默认的应用数据目录
  if (isWin32) {
    // 设置Windows的环境变量
    process.env.AILY_APPDATA_PATH = conf["appdata_path"]["win32"].replace('%HOMEPATH%', os.homedir());
    process.env.AILY_BUILDER_BUILD_PATH = path.join(os.homedir(), "AppData", "Local", "aily-builder", "project");
  } else if (isDarwin) {
    // 设置macOS的环境变量
    process.env.AILY_APPDATA_PATH = conf["appdata_path"]["darwin"].replace('~', os.homedir());
    process.env.AILY_BUILDER_BUILD_PATH = path.join(os.homedir(), "Library", "aily-builder", "project");
  } else {
    // 设置Linux的环境变量
    process.env.AILY_APPDATA_PATH = conf["appdata_path"]["linux"];
    process.env.AILY_BUILDER_BUILD_PATH = path.join(os.homedir(), ".cache", "aily-builder", "project");
  }

  // 确保应用数据目录存在
  if (!fs.existsSync(process.env.AILY_APPDATA_PATH)) {
    try {
      fs.mkdirSync(process.env.AILY_APPDATA_PATH, { recursive: true });
    } catch (error) {
      console.error("创建应用数据目录失败:", error);
    }
  }

  try {
    initLogger(process.env.AILY_APPDATA_PATH);
    registerLoggerHandlers();
  } catch (error) {
    console.error("initLogger error: ", error);
  }

  if (isDarwin) {
    macosInstallEnv(childPath);
  }

  // 检测并读取appdata_path目录下是否有config.json文件
  const userConfigPath = path.join(process.env.AILY_APPDATA_PATH, "config.json");

  // 如果用户配置文件不存在，则复制默认配置文件
  if (!fs.existsSync(userConfigPath)) {
    try {
      fs.copyFileSync(configPath, userConfigPath);
      console.log("已将默认配置文件复制到用户目录:", userConfigPath);
    } catch (error) {
      console.error("复制配置文件失败:", error);
    }
  }

  // 读取用户配置文件
  try {
    userConf = JSON.parse(fs.readFileSync(userConfigPath));
    
    // TODO: 下一版删除，统一修正 regions.cn.api_server 地址为标准地址
    let needSave = false;
    if (userConf.regions && userConf.regions.cn) {
      const correctApiServer = "https://api.yysc.tech";
      const currentApiServer = userConf.regions.cn.api_server;
      
      // 检查当前地址是否需要修正（只要不是正确地址就修正）
      if (currentApiServer !== correctApiServer) {
        console.log(`检测到需要更新的 API 地址: ${currentApiServer || '(空)'} → ${correctApiServer}`);
        userConf.regions.cn.api_server = correctApiServer;
        needSave = true;
      }
    }
    
    // 如果配置被修改，保存回文件
    if (needSave) {
      try {
        fs.writeFileSync(userConfigPath, JSON.stringify(userConf, null, 2));
        console.log("用户配置文件已更新并保存:", userConfigPath);
      } catch (error) {
        console.error("保存用户配置文件失败:", error);
      }
    }
    
    // 合并配置文件
    Object.assign(conf, userConf);
  } catch (error) {
    console.error("读取用户配置文件失败:", error);
    userConf = {}; // 确保userConf是一个对象
  }

  // child Path
  process.env.AILY_CHILD_PATH = childPath;

  // TODO 下一版本删除，强制将cn区域的api_server地址设置为https://api.yysc.tech
  conf.regions["cn"]["api_server"] = "https://api.yysc.tech";
  // console.log("conf: ", conf);
  // 从 regions 配置中获取当前区域的服务地址
  const currentRegion = conf.region || 'cn';
  const regionConfig = conf.regions && conf.regions[currentRegion] ? conf.regions[currentRegion] : conf.regions['cn'];
  
  // 当前区域
  process.env.AILY_REGION = currentRegion;
  // npm registry
  process.env.AILY_NPM_REGISTRY = regionConfig.npm_registry;
  // 设置 npm 使用应用数据目录下的配置文件，忽略系统 .npmrc
  const appNpmrcPath = path.join(process.env.AILY_APPDATA_PATH, ".npmrc");
  // 如果不存在则创建
  if (!fs.existsSync(appNpmrcPath)) {
    try {
      fs.writeFileSync(appNpmrcPath, `@aily-project:registry=\${AILY_NPM_REGISTRY}\naudit=false\nfund=false\n`);
    } catch (error) {
      console.error("创建 .npmrc 文件失败:", error);
    }
  }
  process.env.NPM_CONFIG_USERCONFIG = appNpmrcPath;
  // 清理可能来自系统/终端的代理相关环境变量，避免 npm 在 app 内部使用系统代理
  try {
    const proxyEnvKeys = [
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
      'ALL_PROXY', 'all_proxy', 'PROXY', 'proxy',
      'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'npm_config_proxy', 'npm_config_https_proxy',
      'npm_config_https-proxy', 'npm_config_proxy'
    ];
    proxyEnvKeys.forEach((k) => {
      if (process.env[k]) {
        delete process.env[k];
      }
    });
    // 也清理在 env 配置中以 npm 配置形式存在的 https-proxy/http-proxy
    if (process.env.npm_config_https_proxy) delete process.env.npm_config_https_proxy;
    if (process.env.npm_config_http_proxy) delete process.env.npm_config_http_proxy;
  } catch (e) {
    console.error('清理代理环境变量失败:', e);
  }
  // 7za path
  process.env.AILY_7ZA_PATH = path.join(childPath, isWin32 ? "7za.exe" : "7zz");
  // rg path
  process.env.AILY_RG_PATH = path.join(childPath, isWin32 ? "rg.exe" : "rg");
  // probe-rs path
  process.env.AILY_PROBE_RS_PATH = path.join(childPath, "probe-rs", "probe-rs" + (isWin32 ? ".exe" : ""));
  // aily builder path
  process.env.AILY_BUILDER_PATH = path.join(childPath, "aily-builder");
  // 全局npm包路径
  process.env.AILY_NPM_PREFIX = process.env.AILY_APPDATA_PATH;
  // 默认全局编译器路径
  process.env.AILY_COMPILERS_PATH = path.join(process.env.AILY_APPDATA_PATH, "tools",);
  // 默认全局烧录器路径
  process.env.AILY_TOOLS_PATH = path.join(process.env.AILY_APPDATA_PATH, "tools");
  // 默认全局SDK路径
  process.env.AILY_SDK_PATH = path.join(process.env.AILY_APPDATA_PATH, "sdk");
  // zip包下载地址
  process.env.AILY_ZIP_URL = regionConfig.resource;
  // API服务器地址
  process.env.AILY_API_SERVER = regionConfig.api_server;

  process.env.AILY_PROJECT_PATH = conf["project_path"];

  // 将aily builder以及其中的ninja添加到PATH中
  const ailyBuilderPath = path.join(process.env.AILY_BUILDER_PATH);
  if (fs.existsSync(ailyBuilderPath)) {
    process.env.PATH = `${process.env.PATH}${path.delimiter}${ailyBuilderPath}`;
  }
  const ninjaPath = path.join(process.env.AILY_BUILDER_PATH, 'ninja');
  if (fs.existsSync(ninjaPath)) {
    process.env.PATH = `${process.env.PATH}${path.delimiter}${ninjaPath}`;
  }
  // 将 probe-rs 添加到 PATH 中
  const probeRsDir = path.join(childPath, 'probe-rs');
  if (fs.existsSync(probeRsDir)) {
    process.env.PATH = `${process.env.PATH}${path.delimiter}${probeRsDir}`;
  }

  // 当前系统语言
  process.env.AILY_SYSTEM_LANG = app.getLocale();

  // console.log("====process.env:", process.env)
}


// 更新已存在主窗口的内容（用于second-instance处理）
async function updateMainWindowWithPendingData() {
  if (!mainWindow || !mainWindow.webContents) {
    console.log('主窗口不存在，无法更新内容');
    return;
  }

  let targetUrl = null;

  if (pendingFileToOpen) {
    const dir = pendingFileToOpen;
    const { proceed } = await resolveProjectLockOrPrompt(dir, mainWindow);
    if (!proceed) {
      pendingFileToOpen = null;
      return;
    }
    const routePath = `main/blockly-editor?path=${encodeURIComponent(dir)}`;
    console.log('Updating existing window with project path:', routePath);
    targetUrl = `#/${routePath}`;
    pendingFileToOpen = null;
  } else if (pendingRoute) {
    // 构建路由URL
    let routePath = pendingRoute;

    // 如果有查询参数，添加到路由中
    if (pendingQueryParams) {
      const queryString = new URLSearchParams();
      Object.keys(pendingQueryParams).forEach(key => {
        queryString.append(key, pendingQueryParams[key]);
      });
      routePath += (routePath.includes('?') ? '&' : '?') + queryString.toString();
    }

    console.log('Updating existing window with custom route:', routePath);
    targetUrl = `#/${routePath}`;
    pendingRoute = null;
    pendingQueryParams = null;
  }

  // 如果有目标URL，导航到该页面
  if (targetUrl) {
    if (serve) {
      mainWindow.loadURL(`http://localhost:4200/${targetUrl}`);
    } else {
      mainWindow.loadFile(`renderer/index.html`, { hash: targetUrl });
    }
  }
}

function createWindow() {
  // 检查是否为首次启动（没有窗口状态记录文件）
  const winStateFilePath = path.join(process.env.AILY_APPDATA_PATH, 'window-state.json');
  const isFirstLaunch = !fs.existsSync(winStateFilePath);

  const winState = new WinState({
    defaultWidth: 1200,
    defaultHeight: 780,
    electronStoreOptions: {
      name: 'window-state',
      cwd: process.env.AILY_APPDATA_PATH,
    },
  })

  mainWindow = new BrowserWindow({
    ...winState.winOptions,
    show: false,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: isDarwin ? 'hiddenInset' : 'default',
    alwaysOnTop: false,
    autoHideMenuBar: true,
    icon: serve ? path.join(__dirname, "../public/icon.ico") : path.join(process.resourcesPath, "icon.ico"),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      preload: path.join(__dirname, "preload.js"),
      // 启用 Web Serial API 支持
      // enableBlinkFeatures: 'Serial',
      // 禁用后台节流和页面可见性，避免在后台时停止渲染
      backgroundThrottling: false,
      pageVisibility: true,
    },
  });

  mainWindow.setBounds(winState.state);

  // electron-win-state 未持久化 isMaximized / isFullScreen，关闭前写入 store，供下次 ready-to-show 恢复
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      winState.state.isMaximized = mainWindow.isMaximized();
      winState.state.isFullScreen = mainWindow.isFullScreen();
      winState.saveState();
    }
  });

  winState.manage(mainWindow);

  // mainWindow.setMenu(null);

  // 当页面准备好显示时，再显示窗口（首次启动时最大化）
  mainWindow.once('ready-to-show', () => {
    if (isFirstLaunch || winState.state.isMaximized) {
      mainWindow.maximize();
    }
    if (winState.state.isFullScreen) {
      mainWindow.setFullScreen(true);
    }
    mainWindow.show();
  });

  // 根据是否有待打开的项目路径或路由参数来决定加载的页面
  let targetUrl = null;

  if (pendingFileToOpen) {
    const routePath = `main/blockly-editor?path=${encodeURIComponent(pendingFileToOpen)}`;
    console.log('Loading with project path:', routePath);
    targetUrl = `#/${routePath}`;
    pendingFileToOpen = null;
  } else if (pendingRoute) {
    // 构建路由URL
    let routePath = pendingRoute;

    // 如果有查询参数，添加到路由中
    if (pendingQueryParams) {
      const queryString = new URLSearchParams();
      Object.keys(pendingQueryParams).forEach(key => {
        queryString.append(key, pendingQueryParams[key]);
      });
      routePath += (routePath.includes('?') ? '&' : '?') + queryString.toString();
    }

    console.log('Loading with custom route:', routePath);
    targetUrl = `#/${routePath}`;
    pendingRoute = null;
    pendingQueryParams = null;
  }

  // 加载页面
  if (targetUrl) {
    if (serve) {
      mainWindow.loadURL(`http://localhost:4200/${targetUrl}`);
    } else {
      mainWindow.loadFile(`renderer/index.html`, { hash: targetUrl });
    }
  } else {
    if (serve) {
      mainWindow.loadURL("http://localhost:4200");
    } else {
      mainWindow.loadFile(`renderer/index.html`);
    }
  }

  // 开发环境下的热重载处理
  if (serve) {
    // 处理页面加载失败，支持自动恢复
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // 只处理主框架的加载失败
      if (!isMainFrame) return;
      // -3 (ERR_ABORTED) 是正常的导航中止（如热重载触发新导航），无需处理
      if (errorCode === -3) return;

      console.log(`页面加载失败: errorCode=${errorCode}, description=${errorDescription}, url=${validatedURL}`);

      // 对于开发环境中的各类加载失败，尝试重新加载
      const retryDelay = errorCode === -102 ? 1000 : 500;
      console.log(`${retryDelay}ms 后尝试重新加载...`);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL("http://localhost:4200");
        }
      }, retryDelay);
    });

    // 监听页面加载完成
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('页面加载完成');
    });

    // 处理渲染进程崩溃，自动恢复
    mainWindow.webContents.on('render-process-gone', (event, details) => {
      console.error('渲染进程异常退出:', details.reason, 'exitCode:', details.exitCode);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('尝试重新加载页面...');
          mainWindow.loadURL("http://localhost:4200");
        }
      }, 1000);
    });

    // 开启 DevTools (可选)
    // mainWindow.webContents.openDevTools();
  }

  // 当主窗口被关闭时，进行相应的处理
  mainWindow.on("closed", () => {
    mainWindow = null;
    isRendererReady = false;
    app.quit();
  });

  // 注册ipc handlers
  registerUpdaterHandlers(mainWindow);
  registerTerminalHandlers(mainWindow);
  registerWindowHandlers(mainWindow);
  registerNpmHandlers(mainWindow);
  registerCmdHandlers(mainWindow);
  registerMCPHandlers(mainWindow);
  registerToolsHandlers(mainWindow);
  registerNotificationHandlers(mainWindow);
  registerProbeRsHandlers(mainWindow);

  // 检查是否有待处理的OAuth回调
  // 注意：这里不再使用 setTimeout 自动发送，而是等待 renderer-ready 事件
  // 但为了兼容性（如果 renderer-ready 没触发），保留一个较长时间的超时检查
  if (global.pendingOAuthCallback) {
    setTimeout(() => {
      if (global.pendingOAuthCallback && mainWindow && mainWindow.webContents) {
        console.log('超时检查：发送待处理的OAuth回调');
        mainWindow.webContents.send('oauth-callback', global.pendingOAuthCallback);
        global.pendingOAuthCallback = null;
      }
    }, 5000);
  }

  // 检查是否有待处理的示例列表打开请求
  if (global.pendingExampleListOpen) {
    setTimeout(() => {
      if (global.pendingExampleListOpen && mainWindow && mainWindow.webContents) {
        console.log('超时检查：发送待处理的示例列表请求');
        mainWindow.webContents.send('open-example-list', global.pendingExampleListOpen);
        global.pendingExampleListOpen = null;
      }
    }, 5000);
  }

  // 在多实例模式下，监听OAuth回调文件的变化
  if (shouldUseMultiInstance()) {
    const callbackFilePath = path.join(app.getPath('userData'), 'oauth-callback.json');

    // 检查是否已有OAuth回调文件
    if (fs.existsSync(callbackFilePath)) {
      try {
        const callbackData = JSON.parse(fs.readFileSync(callbackFilePath, 'utf8'));
        // 检查回调数据是否是最近的（5分钟内）
        if (Date.now() - callbackData.timestamp < 5 * 60 * 1000) {
          console.log('发现OAuth回调文件，发送回调数据');
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('oauth-callback', callbackData);
          } else {
            global.pendingOAuthCallback = callbackData;
          }
        }
        // 删除已处理的回调文件
        fs.unlinkSync(callbackFilePath);
      } catch (error) {
        console.error('处理OAuth回调文件失败:', error);
      }
    }

    // 监听OAuth回调文件的创建
    const callbackDir = path.dirname(callbackFilePath);
    if (fs.existsSync(callbackDir)) {
      fs.watch(callbackDir, (eventType, filename) => {
        if (filename === 'oauth-callback.json' && eventType === 'rename') {
          // 延迟一点确保文件写入完成
          setTimeout(() => {
            if (fs.existsSync(callbackFilePath)) {
              try {
                const callbackData = JSON.parse(fs.readFileSync(callbackFilePath, 'utf8'));
                console.log('检测到OAuth回调文件变化，发送回调数据');
                if (mainWindow && mainWindow.webContents) {
                  mainWindow.webContents.send('oauth-callback', callbackData);

                  // 将窗口置前显示
                  if (mainWindow.isMinimized()) {
                    mainWindow.restore();
                  }
                  mainWindow.focus();
                  mainWindow.show();
                }
                // 删除已处理的回调文件
                fs.unlinkSync(callbackFilePath);
              } catch (error) {
                console.error('处理OAuth回调文件变化失败:', error);
              }
            }
          }, 100);
        }
      });
    }
  }
}

// 监听 Windows / Linux second-instance 事件
const gotTheLock = app.requestSingleInstanceLock();

if (shouldUseMultiInstance()) {
  // 多实例模式：检查是否是协议启动
  const isProtocolLaunch = process.argv.some(arg => arg.startsWith(`${PROTOCOL}://`));

  if (isProtocolLaunch) {
    // 协议启动时，检查是否已有其他实例能处理
    if (!gotTheLock) {
      // 如果已有实例在运行，让现有实例处理协议
      console.log('检测到协议启动且已有实例运行，让现有实例处理');
      // 不立即退出，而是让second-instance事件处理
    } else {
      // 如果获得了锁但是是协议启动，说明没有现有实例
      console.log('协议启动且获得锁，将创建实例处理协议');
    }
  } else {
    // 非协议启动的多实例模式：释放单实例锁，允许多个实例运行
    if (gotTheLock) {
      app.releaseSingleInstanceLock();
    }
  }

  // 监听second-instance事件，用于处理协议链接
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('收到second-instance事件，命令行参数:', commandLine);

    // 查找协议链接
    const protocolUrl = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`));
    if (protocolUrl) {
      console.log('在second-instance中处理协议链接:', protocolUrl);

      // 检查是否是示例相关的URL，如果是则忽略（由新实例处理）
      try {
        const urlObj = new URL(protocolUrl);
        let fullPath = urlObj.pathname;
        if (urlObj.hostname && urlObj.hostname !== '') {
          fullPath = '/' + urlObj.hostname + urlObj.pathname;
        }
        const normalizedPath = fullPath.replace(/\/$/, '');

        if (normalizedPath === '/examples' || normalizedPath === '/open-examples' || normalizedPath === '/open-template') {
          console.log('检测到示例相关URL，忽略second-instance处理，将由新实例处理');
          return;
        }
      } catch (e) {
        console.error('解析协议URL失败:', e);
      }

      handleProtocol(protocolUrl);

      // 处理协议后不要置前窗口，让具体的处理逻辑决定
      return;
    } else {
      // 处理其他类型的启动参数（如.abi文件、路由参数等）
      handleCommandLineArgs(commandLine);

      void (async () => {
        // 如果有待处理的文件或路由，更新主窗口
        if (pendingFileToOpen || pendingRoute) {
          await updateMainWindowWithPendingData();
        }

        // 将现有窗口置前
        if (mainWindow) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          mainWindow.focus();
          mainWindow.show();
        }
      })();
    }
  });
} else {
  // 单实例模式：保持原有逻辑
  if (!gotTheLock) {
    // 如果无法获取单实例锁，说明已有实例在运行
    // 直接退出，让系统的协议处理机制将协议链接传递给已存在的实例
    app.quit();
  } else {
    // 监听second-instance事件，处理协议链接和其他启动参数
    app.on('second-instance', (event, commandLine, workingDirectory) => {
      // 查找协议链接
      const protocolUrl = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`));
      if (protocolUrl) {
        console.log('在second-instance中处理协议链接:', protocolUrl);
        handleProtocol(protocolUrl);
      } else {
        // 处理其他类型的启动参数（如.abi文件、路由参数等）
        handleCommandLineArgs(commandLine);

        void (async () => {
          // 如果有待处理的文件或路由，更新主窗口
          if (pendingFileToOpen || pendingRoute) {
            await updateMainWindowWithPendingData();
          }

          // 将现有窗口置前
          if (mainWindow) {
            if (mainWindow.isMinimized()) {
              mainWindow.restore();
            }
            mainWindow.focus();
            mainWindow.show();
          }
        })();
      }
    });
  }
}

// Windows 任务栏跳转列表（Jump List），仅 Windows 有效；macOS 无对应 API，多开见 Dock 菜单「新建实例」或终端 `open -n`。
if (typeof app.setUserTasks === "function") {
  // app.setUserTasks([
  //   {
  //     program: process.execPath,
  //     arguments: "--new-window",
  //     iconPath: process.execPath,
  //     iconIndex: 0,
  //     title: "New Window",
  //     description: "Create a new window",
  //   },
  // ]);
}

// TODO: 最近项目列表

/**
 * Apple Silicon Mac 上若未装 Rosetta，内置 x86_64 子进程无法运行；本机为 arm64 应用时也需要 Rosetta。
 * 已可用则跳过；否则异步触发 softwareupdate，不阻塞窗口创建。
 */
function ensureRosettaIfNeededOnDarwin() {
  if (!isDarwin) {
    return;
  }
  try {
    const { execSync, execFile, execFileSync } = require("child_process");
    const arm64Machine =
      execSync("sysctl -n hw.optional.arm64", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "1";
    if (!arm64Machine) {
      return;
    }
    try {
      execFileSync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" });
      console.log("Rosetta 已就绪，内置 x86 工具可在此 Mac 上运行");
      return;
    } catch {
      // 未安装或 Rosetta 不可用，继续安装流程
    }
    execFile(
      "/usr/sbin/softwareupdate",
      ["--install-rosetta", "--agree-to-license"],
      { stdio: "inherit" },
      (err) => {
        if (err) {
          console.warn(
            "自动安装 Rosetta 未成功，内置 x86 工具可能无法运行，可手动安装 Rosetta:",
            err.message
          );
        } else {
          console.log("Rosetta：自动安装命令执行成功");
        }
      }
    );
  } catch (e) {
    console.warn("检测 Apple Silicon / Rosetta 失败，跳过自动安装:", e.message);
  }
}

app.on("ready", async () => {
  // 检查是否是协议启动
  const protocolUrl = process.argv.find(arg => arg.startsWith(`${PROTOCOL}://`));

  // 判断是否是纯转发型协议（不需要创建窗口的协议路径）
  if (protocolUrl) {
    try {
      const urlObj = new URL(protocolUrl);
      let fullPath = urlObj.pathname;
      if (urlObj.hostname && urlObj.hostname !== '') {
        fullPath = '/' + urlObj.hostname + urlObj.pathname;
      }

      // OAuth 回调：无需创建窗口，直接转发给已运行的实例后退出
      if (fullPath === '/auth/callback') {
        console.log('检测到 OAuth 回调协议启动，跳过窗口创建，直接转发处理');
        handleProtocol(protocolUrl);
        // handleProtocol 内部对找到目标实例的情况会调用 app.quit()
        // 兜底：若未找到目标实例（主窗口已关闭等异常情况），延迟退出
        setTimeout(() => {
          app.quit();
        }, 500);
        return;
      }
    } catch (e) {
      console.error('应用启动时解析协议 URL 失败:', e);
    }
  }

  try {
    ensureRosettaIfNeededOnDarwin();
    loadEnv();
    // 异步检测最优服务器，不阻塞窗口创建
    initFastestServersAsync();
  } catch (error) {
    console.error("loadEnv error: ", error);
  }

  if (isDarwin && app.dock) {
    setupDarwinDockMenu();
  }
  if (isWin32) {
    setupWindowsJumpListTasks();
  }

  if (protocolUrl) {
    console.log('应用启动时检测到协议参数:', protocolUrl);
    // 延迟处理协议，确保窗口创建完成
    setTimeout(() => {
      handleProtocol(protocolUrl);
    }, 1000);
  }

  if (pendingFileToOpen) {
    const { proceed } = await resolveProjectLockOrPrompt(pendingFileToOpen, null);
    if (!proceed) {
      pendingFileToOpen = null;
    }
  }

  // 创建主窗口
  createWindow();
});

// // 处理 Web Serial API 的串口选择请求
// app.on('web-contents-created', (event, contents) => {
//   contents.session.on('select-serial-port', (event, portList, webContents, callback) => {
//     event.preventDefault();
//     console.log('Web Serial API: 可用串口列表', portList);

//     // 如果有可用的串口，选择第一个（或者可以根据 VID/PID 筛选）
//     if (portList && portList.length > 0) {
//       // 查找 ESP32S3 设备 (VID: 0x303a, PID: 0x1001)
//       const esp32Port = portList.find(port =>
//         port.vendorId === '303a' && port.productId === '1001'
//       );

//       if (esp32Port) {
//         console.log('选择 ESP32S3 串口:', esp32Port.portId);
//         callback(esp32Port.portId);
//       } else {
//         // 如果没找到 ESP32S3，选择第一个
//         console.log('未找到 ESP32S3，选择第一个串口:', portList[0].portId);
//         callback(portList[0].portId);
//       }
//     } else {
//       console.log('没有可用的串口');
//       callback('');
//     }
//   });

//   contents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
//     if (permission === 'serial') {
//       return true;
//     }
//     return false;
//   });

//   contents.session.setDevicePermissionHandler((details) => {
//     if (details.deviceType === 'serial') {
//       return true;
//     }
//     return false;
//   });
// });

// 当所有窗口都被关闭时退出应用（macOS 除外）
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  if (heldProjectLockNormalized) {
    try {
      projectLock.releaseLock(heldProjectLockNormalized);
    } catch (e) {
      console.warn("will-quit release project lock:", e);
    }
    heldProjectLockNormalized = null;
  }
  // 释放实例锁文件，使目录可被后续启动复用
  if (heldInstanceLockPath) {
    try {
      fs.unlinkSync(heldInstanceLockPath);
    } catch (e) {
      console.warn('will-quit release instance lock:', e.message);
    }
    heldInstanceLockPath = null;
  }
});

// 在 macOS 上，当应用被激活时（如点击 Dock 图标），重新创建窗口
app.on("activate", () => {
  if (mainWindow === null) {
    // 先加载环境变量
    try {
      loadEnv();
    } catch (error) {
      console.error("loadEnv error: ", error);
    }
    // 创建主窗口
    createWindow();
  }
});
// 用于嵌入的iframe打开外部链接
app.on('web-contents-created', (event, contents) => {
  // 处理iframe中的链接点击
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' }; // 阻止在Electron中打开
  });
});
// macOS下处理文件打开
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (filePath.endsWith('.abi') && fs.existsSync(filePath)) {
    const projectDir = path.dirname(path.resolve(filePath));
    console.log('macOS open-file:', filePath);
    console.log('Project directory:', projectDir);

    if (mainWindow && mainWindow.webContents) {
      void (async () => {
        const { proceed } = await resolveProjectLockOrPrompt(projectDir, mainWindow);
        if (!proceed) {
          return;
        }
        const routePath = `main/blockly-editor?path=${encodeURIComponent(projectDir)}`;
        console.log('Navigating to route:', routePath);

        if (serve) {
          mainWindow.loadURL(`http://localhost:4200/#/${routePath}`);
        } else {
          mainWindow.loadFile(`renderer/index.html`, { hash: `#/${routePath}` });
        }
      })();
    } else {
      pendingFileToOpen = projectDir;
    }
  }
});

// macOS下处理协议链接
app.on('open-url', (event, url) => {
  event.preventDefault();
  console.log('macOS open-url:', url);
  handleProtocol(url);
});

// 文件选择
ipcMain.handle("select-file", async (event, data) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(senderWindow, {
    title: data.title || '选择文件',
    defaultPath: data.path,
    properties: ["openFile"],
  });
  if (result.canceled) {
    return "";
  }
  return result.filePaths[0];
});

// 项目管理相关
// 打开项目用
ipcMain.handle("select-folder", async (event, data) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(senderWindow, {
    defaultPath: data.path,
    properties: ["openDirectory"],
  });
  if (result.canceled) {
    return data.path;
  }
  return result.filePaths[0];
});

// 跨版本项目占用：尝试获取 / 释放锁、前置其他进程窗口
ipcMain.handle("project-lock-try", (event, data) => {
  const { projectPath, force } = data || {};
  const r = projectLock.tryAcquireLock(projectPath, { force: !!force });
  if (r.ok) {
    heldProjectLockNormalized = r.normalizedPath;
  }
  return r;
});

ipcMain.handle("project-lock-release", (event, data) => {
  const { projectPath } = data || {};
  const target = projectPath || heldProjectLockNormalized;
  if (!target) {
    return { ok: true };
  }
  const beforeHeld = heldProjectLockNormalized;
  const r = projectLock.releaseLock(target);
  if (r.ok && beforeHeld) {
    const nt = projectLock.normalizeProjectPathLoose(target);
    const nh = projectLock.normalizeProjectPathLoose(beforeHeld);
    if (nt === nh) {
      heldProjectLockNormalized = null;
    }
  }
  return r;
});

ipcMain.handle("project-lock-focus", (event, data) => {
  const pid = data && data.pid;
  return projectLock.focusProcessByPid(pid);
});

// 另存为用
ipcMain.handle("select-folder-saveAs", async (event, data) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);

  // 构建默认路径，确保包含建议的文件名
  let defaultPath;
  if (data.path) {
    defaultPath = data.path;
    // 如果同时提供了建议名称，则附加到路径上
    if (data.suggestedName) {
      defaultPath = path.join(defaultPath, data.suggestedName);
    }
  } else if (data.suggestedName) {
    defaultPath = path.join(app.getPath('documents'), data.suggestedName);
  } else {
    defaultPath = app.getPath('documents');
  }
  const result = await dialog.showSaveDialog(senderWindow, {
    defaultPath: defaultPath,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
    buttonLabel: '保存',
    title: data.title || '项目另存为',
    filters: data.filters || undefined
  });

  if (result.canceled) {
    return data.path || '';
  }
  // 直接返回用户选择的完整路径，保留文件名部分
  return result.filePath;
});

// 通用对话框处理器（用于chat添加文件或文件夹）
ipcMain.handle("dialog-select-files", async (event, options) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  try {
    const result = await dialog.showOpenDialog(senderWindow, options);
    return result;
  } catch (error) {
    throw error;
  }
});

// 环境变量
ipcMain.handle("env-set", (event, data) => {
  process.env[data.key] = data.value;
})

ipcMain.handle("env-get", (event, key) => {
  return process.env[key];
})

// 移动文件到回收站
ipcMain.handle("move-to-trash", async (event, filePath) => {
  try {
    const result = await shell.trashItem(filePath);
    return { success: true, result };
  } catch (error) {
    console.error('Failed to move item to trash:', error);
    return { success: false, error: error.message };
  }
})

// 启动文件拖拽到外部应用
ipcMain.handle("file-start-drag", async (event, filePaths) => {
  try {
    // 确保 filePaths 是数组
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

    // 验证文件是否存在
    const fs = require('fs');
    const validPaths = paths.filter(p => fs.existsSync(p));

    if (validPaths.length === 0) {
      console.warn('没有有效的文件路径可拖拽');
      return { success: false, error: '没有有效的文件路径' };
    }

    console.log('准备拖拽文件:', validPaths);

    // 获取发送事件的窗口
    const webContents = event.sender;

    // 注意：startDrag 会在后续的 dragstart 事件中被调用
    // 我们需要在这里准备好数据，但实际的拖拽由浏览器事件触发

    // 这个方法实际上不能在 IPC handler 中调用
    // 因为 startDrag 必须在拖拽手势开始时同步调用
    // 所以我们返回成功，实际的拖拽由前端的 dragstart 事件触发

    return { success: true, paths: validPaths };
  } catch (error) {
    console.error('准备拖拽失败:', error);
    return { success: false, error: error.message };
  }
})

function spawnNewAppInstance(data) {
  const { route, queryParams } = data || {};
  const args = ["--new-instance"];
  if (route) {
    args.push(`--route=${route}`);
  }
  if (queryParams) {
    args.push(`--query=${encodeURIComponent(JSON.stringify(queryParams))}`);
  }
  const { spawn } = require("child_process");
  const execPath = process.execPath;
  const appPath = app.getAppPath();
  const spawnArgs = [appPath, ...args];
  console.log("启动新实例:", execPath, spawnArgs);
  const child = spawn(execPath, spawnArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { success: true, pid: child.pid };
}

function setupDarwinDockMenu() {
  if (!isDarwin || !app.dock) {
    return;
  }
  const label = getMenuStringForMain("NEW_INSTANCE", "New Instance");
  app.dock.setMenu(
    Menu.buildFromTemplate([
      {
        label,
        click: () => {
          spawnNewAppInstance({});
        },
      },
    ])
  );
}

/** Windows 任务栏图标右键「跳转列表」中的用户任务，与 macOS Dock 菜单「新实例」对应 */
function setupWindowsJumpListTasks() {
  if (!isWin32) {
    return;
  }
  try {
    const title = getMenuStringForMain("NEW_INSTANCE", "New Instance");
    const appPath = app.getAppPath();
    const arg0 =
      /[\s"]/.test(appPath) ? `"${appPath.replace(/"/g, '\\"')}"` : appPath;
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: `${arg0} --new-instance`,
        title,
        description: title,
        iconPath: process.execPath,
        iconIndex: 0,
      },
    ]);
  } catch (e) {
    console.warn("setupWindowsJumpListTasks:", e);
  }
}

// 打开新实例
ipcMain.handle("open-new-instance", async (event, data) => {
  try {
    const result = spawnNewAppInstance(data);
    return {
      success: true,
      pid: result.pid,
      message: "新实例已启动",
    };
  } catch (error) {
    console.error("启动新实例失败:", error);
    return {
      success: false,
      error: error.message,
    };
  }
})

// settingChanged
ipcMain.on("setting-changed", (event, data) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  mainWindow.webContents.send("setting-changed", data);
});

// OAuth状态管理的IPC处理器
ipcMain.handle("oauth-register-state", (event, state) => {
  return registerOAuthInstance(state);
});

ipcMain.handle("oauth-find-instance", (event, state) => {
  return findOAuthInstance(state);
});

// 清理无主实例目录和基础 userData 中的 Chromium 缓存
function cleanupOldInstances() {
  try {
    const originalUserDataPath = app.getPath('userData').replace(/[/\\]instances[/\\][^/\\]+$/, '');
    const instancesDir = path.join(originalUserDataPath, 'instances');

    // 清理基础 userData 路径下的 GPUCache 和 Code Cache（协议启动时可能累积）
    clearSlowCaches(originalUserDataPath);

    if (!fs.existsSync(instancesDir)) {
      return;
    }

    const currentUserData = app.getPath('userData');

    fs.readdirSync(instancesDir).forEach(entry => {
      const instancePath = path.join(instancesDir, entry);

      // 跳过当前正在使用的实例目录
      if (instancePath === currentUserData) return;

      // 检查是否是 instance-N 格式（新格式）
      const isPooledDir = /^instance-\d+$/.test(entry);

      if (isPooledDir) {
        // 新格式：通过锁文件判断是否空闲
        const lockFilePath = path.join(instancePath, 'instance.lock');
        if (fs.existsSync(lockFilePath)) {
          try {
            const lockData = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
            if (lockData.pid && isProcessRunning(lockData.pid)) {
              return; // 进程仍在运行，跳过
            }
          } catch {
            // 锁文件损坏，继续清理
          }
        }
        // 空闲的池化目录：不删除整个目录，只清理慢缓存
        clearSlowCaches(instancePath);
      } else {
        // 旧格式（时间戳-随机ID）：清理超过 24 小时的旧目录
        try {
          const stats = fs.statSync(instancePath);
          const maxAge = 24 * 60 * 60 * 1000;
          if (Date.now() - stats.mtime.getTime() > maxAge) {
            fs.rmSync(instancePath, { recursive: true, force: true });
            console.log('已清理旧格式实例目录:', instancePath);
          }
        } catch (e) {
          console.warn('清理旧实例目录失败:', entry, e.message);
        }
      }
    });
  } catch (error) {
    console.error('清理实例目录时出错:', error);
  }
}

cleanupOldInstances();

// ============================================
// Ripgrep 搜索功能
// ============================================
const ripgrep = require('./ripgrep');

// 检查 ripgrep 是否可用
ipcMain.handle("ripgrep-check-available", async (event) => {
  try {
    const available = await ripgrep.isRipgrepAvailable();
    return available;
  } catch (error) {
    console.error('检查 ripgrep 可用性失败:', error);
    return false;
  }
});

// 使用 ripgrep 搜索文件内容
ipcMain.handle("ripgrep-search-files", async (event, params) => {
  try {
    const result = await ripgrep.searchFiles(params);
    return result;
  } catch (error) {
    console.error('Ripgrep 搜索失败:', error);
    return {
      success: false,
      numFiles: 0,
      filenames: [],
      error: error.message
    };
  }
});

// 列出所有内容文件
ipcMain.handle("ripgrep-list-files", async (event, searchPath, limit = 1000) => {
  try {
    const result = await ripgrep.listAllContentFiles(searchPath, limit);
    return result;
  } catch (error) {
    console.error('列出文件失败:', error);
    return {
      success: false,
      files: []
    };
  }
});

// 搜索文件内容并返回匹配的行
ipcMain.handle("ripgrep-search-content", async (event, params) => {
  try {
    const result = await ripgrep.searchContent(params);
    return result;
  } catch (error) {
    console.error('搜索内容失败:', error);
    return {
      success: false,
      matches: [],
      error: error.message
    };
  }
});

// ============================================
// 异步文件系统 IPC（在主进程执行，不阻塞渲染进程 UI）
// ============================================
const fsPromises = require('fs').promises;
const fsSync = require('fs');

ipcMain.handle("fs-readFile", async (_event, filePath, encoding) => {
  return await fsPromises.readFile(filePath, encoding || 'utf8');
});

ipcMain.handle("fs-writeFile", async (_event, filePath, data, encoding) => {
  await fsPromises.writeFile(filePath, data, encoding || 'utf8');
});

ipcMain.handle("fs-exists", async (_event, filePath) => {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("fs-stat", async (_event, filePath) => {
  const s = await fsPromises.stat(filePath);
  return {
    size: s.size,
    mtime: s.mtime.toISOString(),
    birthtime: s.birthtime.toISOString(),
    _isDirectory: s.isDirectory(),
    _isFile: s.isFile(),
  };
});

ipcMain.handle("fs-readdir", async (_event, dirPath) => {
  return await fsPromises.readdir(dirPath);
});

ipcMain.handle("fs-readDir", async (_event, dirPath) => {
  const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
  return entries.map(e => ({
    name: e.name,
    _isDirectory: e.isDirectory(),
    _isFile: e.isFile(),
  }));
});

ipcMain.handle("fs-mkdir", async (_event, dirPath, options) => {
  await fsPromises.mkdir(dirPath, options || { recursive: true });
});

ipcMain.handle("fs-unlink", async (_event, filePath) => {
  await fsPromises.unlink(filePath);
});

// ============================================
// Glob IPC（在主进程执行，避免 preload 中 require 解析问题）
// ============================================
ipcMain.handle("glob-search", async (_event, pattern, options) => {
  const glob = require("glob");
  // glob v7: glob.sync exists; glob v10: globSync
  if (typeof glob.sync === 'function') {
    return glob.sync(pattern, options || {});
  } else if (typeof glob.globSync === 'function') {
    return glob.globSync(pattern, options || {});
  }
  throw new Error('glob module API not recognized');
});

ipcMain.handle("glob-search-async", async (_event, pattern, options) => {
  const glob = require("glob");
  // glob v7: default export is callable; glob v10: named export
  if (typeof glob === 'function') {
    return new Promise((resolve, reject) => {
      glob(pattern, options || {}, (err, files) => err ? reject(err) : resolve(files));
    });
  } else if (typeof glob.glob === 'function') {
    return await glob.glob(pattern, options || {});
  }
  throw new Error('glob module API not recognized');
});
