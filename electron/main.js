// Electron 主进程入口，负责应用生命周期、窗口和核心模块初始化。
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const { spawn, exec } = require("child_process");
const url = require("url");
const WinState = require('electron-win-state').default;
const { app, BrowserWindow, ipcMain, dialog, screen, shell, Menu, powerMonitor } = require("electron");

const { isWin32, isDarwin, isLinux } = require("./platform");
const projectLock = require("./project-lock");
const { startCliBridge } = require("./cli-bridge");
const builder = require("./builder");
const linter = require("./linter");
const { createPackagedRendererServer } = require("./packaged-renderer-server");
const {
  markInstalledForAppVersion,
  shouldInstallForAppVersion,
} = require("./aily-tools-install-state");
const ORIGINAL_PROCESS_PATH = process.env.PATH || process.env.Path || "";

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
const packagedRendererServer = createPackagedRendererServer();

async function ensurePackagedRendererServerStarted() {
  if (serve) return null;
  return packagedRendererServer.start({
    rootDirectory: path.join(__dirname, "..", "renderer"),
  });
}

function resolveAppRendererUrl(hash = "") {
  if (!serve) {
    return packagedRendererServer.rendererUrl(hash);
  }
  if (hash === undefined || hash === null || hash === "") {
    return "http://localhost:4200";
  }
  if (
    typeof hash !== "string"
    || hash.length > 16 * 1024
    || /[\u0000-\u001f\u007f]/.test(hash)
  ) {
    throw new TypeError("Renderer hash is invalid.");
  }
  return `http://localhost:4200/${hash.startsWith("#") ? hash : `#${hash}`}`;
}

function loadAppRenderer(targetWindow, hash = "") {
  return targetWindow.loadURL(resolveAppRendererUrl(hash));
}

// Angular dev server 会把依赖预构建到 .angular/cache 下；重启后路径可能变化。
// 开发态若继续复用 Electron 的 HTTP cache，容易命中已失效的旧 chunk URL
if (serve) {
  app.commandLine.appendSwitch('disable-http-cache');
}

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

/** 内嵌 coder：开发态挂 child/coder 的 Vite；生产态本地静态 child/coder/dist */
let coderEmbedHttpServer = null;
/** 防止并发多次进入启动逻辑（重复 spawn Vite） */
let coderEmbedEnsureInFlight = null;

const CODER_EMBED_VITE_PORT_MIN = 5174;
const CODER_EMBED_VITE_PORT_RANGE = 24;

function getCoderEmbedPackageDir() {
  const childRoot = serve
    ? path.join(__dirname, "..", "child")
    : path.join(process.resourcesPath, "child");
  return path.join(childRoot, "aily-coder");
}

function getCoderEmbedDistPath() {
  return path.join(getCoderEmbedPackageDir(), "dist");
}

function probeCoderEmbedViteListening(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function findListeningCoderEmbedDevPort() {
  for (let i = 0; i < CODER_EMBED_VITE_PORT_RANGE; i++) {
    const port = CODER_EMBED_VITE_PORT_MIN + i;
    if (await probeCoderEmbedViteListening(port)) {
      return port;
    }
  }
  return null;
}

function spawnCoderEmbedViteDevServer(coderDir) {
  // Windows 上直接 spawn npm.cmd 会 EINVAL（Node 22+）；与 electron/npm.js 一致需 shell: true
  if (isWin32) {
    return spawn("npm run start", {
      cwd: coderDir,
      env: process.env,
      stdio: "inherit",
      shell: true,
      windowsHide: true,
    });
  }
  return spawn("npm", ["run", "start"], {
    cwd: coderDir,
    env: process.env,
    stdio: "inherit",
  });
}

function killCoderEmbedSpawnedDevProcess(devProcess) {
  if (!devProcess || typeof devProcess.pid !== "number") {
    return;
  }
  try {
    if (isWin32) {
      exec(`taskkill /pid ${devProcess.pid} /T /F`, () => {});
    } else {
      devProcess.kill("SIGTERM");
    }
  } catch (e) {
    console.warn("kill coder vite dev:", e.message);
  }
}

function coderEmbedMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".map": "application/json; charset=utf-8",
  };
  return map[ext] || "application/octet-stream";
}

function ensureCoderEmbedServerStartedImpl() {
  if (serve) {
    const coderDir = getCoderEmbedPackageDir();
    const pkgJson = path.join(coderDir, "package.json");
    if (!fs.existsSync(pkgJson)) {
      return Promise.reject(new Error(`Coder 开发目录无效，缺少 package.json: ${coderDir}`));
    }
    return findListeningCoderEmbedDevPort().then((existingPort) => {
      if (existingPort != null) {
        coderEmbedHttpServer = {
          kind: "dev",
          port: existingPort,
          devProcess: null,
          spawned: false,
        };
        return existingPort;
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const devProcess = spawnCoderEmbedViteDevServer(coderDir);
        const deadline = Date.now() + 120000;
        const fail = (err) => {
          if (settled) {
            return;
          }
          settled = true;
          killCoderEmbedSpawnedDevProcess(devProcess);
          reject(err);
        };
        devProcess.on("error", (err) => {
          fail(new Error(`无法启动 child/coder 开发服务器: ${err.message}`));
        });
        devProcess.once("exit", (code) => {
          if (!settled) {
            fail(new Error(`child/coder Vite 异常退出，代码: ${code}`));
          }
        });
        const poll = () => {
          if (settled) {
            return;
          }
          findListeningCoderEmbedDevPort()
            .then((port) => {
              if (port != null) {
                if (settled) {
                  return;
                }
                settled = true;
                coderEmbedHttpServer = {
                  kind: "dev",
                  port,
                  devProcess,
                  spawned: true,
                };
                resolve(port);
                return;
              }
              if (Date.now() > deadline) {
                fail(new Error("等待 child/coder Vite 就绪超时"));
                return;
              }
              setTimeout(poll, 400);
            })
            .catch((e) => fail(e || new Error(String(e))));
        };
        devProcess.once("spawn", () => poll());
      });
    });
  }
  const dist = getCoderEmbedDistPath();
  if (!fs.existsSync(dist)) {
    return Promise.reject(new Error(`Coder 静态资源未找到: ${dist}`));
  }
  const distResolved = path.resolve(dist);
  const distPrefix = distResolved.endsWith(path.sep) ? distResolved : distResolved + path.sep;

  const server = http.createServer((req, res) => {
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const parsed = url.parse(req.url);
    let pathname = decodeURIComponent(parsed.pathname || "/");
    if (pathname.includes("\0")) {
      res.writeHead(400);
      res.end();
      return;
    }
    pathname = path.posix.normalize("/" + pathname.replace(/\\/g, "/"));
    if (pathname.includes("..")) {
      res.writeHead(403);
      res.end();
      return;
    }
    let rel = pathname.replace(/^\//, "");
    if (!rel || rel.endsWith("/")) {
      rel = path.posix.join(rel || ".", "index.html");
    }
    const filePath = path.join(distResolved, rel);
    const fileResolved = path.resolve(filePath);
    if (fileResolved !== distResolved && !fileResolved.startsWith(distPrefix)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.stat(fileResolved, (err, st) => {
      if (!err && st.isFile()) {
        if (req.method === "HEAD") {
          res.writeHead(200, { "Content-Type": coderEmbedMimeType(fileResolved) });
          res.end();
          return;
        }
        fs.readFile(fileResolved, (e2, data) => {
          if (e2) {
            res.writeHead(500);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": coderEmbedMimeType(fileResolved) });
          res.end(data);
        });
        return;
      }
      const indexPath = path.join(distResolved, "index.html");
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end();
        return;
      }
      fs.readFile(indexPath, (e3, data) => {
        if (e3) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      if (!port) {
        try {
          server.close();
        } catch (_) {}
        reject(new Error("无法为 Coder 嵌入服务分配端口"));
        return;
      }
      coderEmbedHttpServer = { kind: "static", server, port };
      resolve(port);
    });
    server.on("error", reject);
  });
}

function ensureCoderEmbedServerStarted() {
  if (coderEmbedHttpServer) {
    return Promise.resolve(coderEmbedHttpServer.port);
  }
  if (coderEmbedEnsureInFlight) {
    return coderEmbedEnsureInFlight;
  }
  coderEmbedEnsureInFlight = ensureCoderEmbedServerStartedImpl().finally(() => {
    coderEmbedEnsureInFlight = null;
  });
  return coderEmbedEnsureInFlight;
}

/** 主进程读取 i18n JSON：开发态在仓库 public；打包后 Angular 资源在 app.asar/renderer */
function getMainProcessI18nJsonPath(pack) {
  const file = path.join(pack, `${pack}.json`);
  if (app.isPackaged) {
    return path.join(__dirname, "..", "renderer", "i18n", file);
  }
  return path.join(__dirname, "..", "public", "i18n", file);
}

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
    const fp = getMainProcessI18nJsonPath(pack);
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
    const fp = getMainProcessI18nJsonPath(pack);
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

      if (isCurrentRendererGenerationReady()) {
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
const { registerTerminalHandlers, killAllTerminals, getActiveTerminals } = require("./terminal");
const { registerWindowHandlers } = require("./window");
const { registerNpmHandlers, killAllNpmProcesses, getActiveNpmProcesses } = require("./npm");
const { registerUpdaterHandlers } = require("./updater");
const { registerCmdHandlers, killAllCmdProcesses, getActiveCmdProcesses } = require("./cmd");
const { registerAilyServicesStreamHandlers, cancelAllAilyServicesStreams, getActiveAilyServicesStreams } = require("./aily-services-stream");
const { registerWebviewBridgeHandlers } = require("./webview-bridge");
const { registerMCPHandlers } = require("./mcp");
const { registerAppDataResourceLockHandlers, releaseAllAppDataResourceLocks } = require("./appdata-resource-lock");
// debug模块
const { initLogger, registerLoggerHandlers } = require("./logger");
// tools
const { registerToolsHandlers } = require("./tools");
const { registerNotificationHandlers } = require("./notification");
const { registerProbeRsHandlers } = require("./probe-rs");
const { registerBleHandlers, registerWebBluetoothChooser } = require("./ble");
const { registerSubappManagerHandlers } = require("./subapp-manager");
const { resolveAilyAppDataPath } = require("./appdata-path");

let mainWindow;
let userConf;
let isProcessCleanupInProgress = false;
let hasProcessCleanupCompleted = false;
let projectContextState = {
  workspace: null,
  version: 0,
};

// === CLI Bridge：供外部 CLI 通过本地回环接口驱动主程序（附加能力） ===
let cliBridge = null;

/** 导航主窗口到指定 hash（复用 dev/prod 既有加载方式） */
function navigateMainWindowHash(targetHash) {
  if (!mainWindow || !mainWindow.webContents || mainWindow.isDestroyed()) {
    return false;
  }
  void loadAppRenderer(mainWindow, targetHash);
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.show();
  } catch (_) {
    /* ignore */
  }
  return true;
}

/** 从当前窗口 URL 中解析正在打开的项目路径（反映 GUI 打开的项目） */
function getOpenedProjectPathFromWindow() {
  try {
    const currentUrl = mainWindow && mainWindow.webContents ? mainWindow.webContents.getURL() : '';
    const m = currentUrl.match(/[?&]path=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch (_) {
    return null;
  }
}

function requestMainWindow(channel, responseChannel, payload, timeoutMs = 12000, signal) {
  return new Promise((resolve) => {
    if (!mainWindow || !mainWindow.webContents || mainWindow.isDestroyed()) {
      resolve({ ok: false, message: '主窗口不可用' });
      return;
    }
    if (!isCurrentRendererGenerationReady()) {
      resolve({ ok: false, message: '渲染进程尚未就绪' });
      return;
    }

    const requestGeneration = rendererGeneration;
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      ipcMain.removeListener(responseChannel, listener);
      resolve({ ok: false, message: '等待渲染进程响应超时' });
    }, timeoutMs);

    const listener = (event, message) => {
      if (!isCurrentMainRenderer(event.sender)
        || rendererGeneration !== requestGeneration
        || readyRendererGeneration !== requestGeneration
        || !message
        || message.requestId !== requestId
        || Number(message.rendererGeneration) !== requestGeneration) {
        return;
      }
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      ipcMain.removeListener(responseChannel, listener);
      resolve(message);
    };

    const onAbort = () => {
      clearTimeout(timer);
      ipcMain.removeListener(responseChannel, listener);
      resolve({
        ok: false,
        errorCode: 'RENDERER_REQUEST_CANCELLED',
        message: 'Renderer request was cancelled.',
      });
    };

    ipcMain.on(responseChannel, listener);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    mainWindow.webContents.send(channel, {
      ...payload,
      requestId,
      rendererGeneration: requestGeneration,
    });
  });
}

/** 处理来自 CLI 的命令（open/close/reload/refresh） */
async function handleCliBridgeCommand(action, payload) {
  const requestedPath = payload && typeof payload.path === 'string' ? payload.path : '';
  switch (action) {
    case 'open': {
      if (!requestedPath) return { ok: false, message: '缺少 path 参数' };
      if (!fs.existsSync(requestedPath)) return { ok: false, message: `项目目录不存在: ${requestedPath}` };
      const dir = path.resolve(requestedPath);
      const ok = navigateMainWindowHash(`#/main/blockly-editor?path=${encodeURIComponent(dir)}`);
      return { ok, message: ok ? `已打开项目: ${dir}` : '主窗口不可用', project: ok ? dir : null };
    }
    case 'reload':
    case 'refresh': {
      const dir = requestedPath ? path.resolve(requestedPath) : getOpenedProjectPathFromWindow();
      if (!dir) return { ok: false, message: '当前没有打开的项目,且未提供 path' };
      if (!fs.existsSync(dir)) return { ok: false, message: `项目目录不存在: ${dir}` };
      const current = getOpenedProjectPathFromWindow();
      if (current && path.resolve(current) === dir) {
        const result = await requestMainWindow(
          'cli-bridge:blockly-live-operation',
          'cli-bridge:blockly-live-operation:response',
          {
            path: dir,
            operation: 'project_reload',
            params: {},
          },
          120000,
        );
        if (result && typeof result === 'object' && result.ok === true) {
          return { ok: true, message: `已重载项目(刷新库/积木): ${dir}`, project: dir };
        }
      }
      const ok = navigateMainWindowHash(`#/main/blockly-editor?path=${encodeURIComponent(dir)}`);
      return { ok, message: ok ? `已重载项目(刷新库/积木): ${dir}` : '主窗口不可用', project: ok ? dir : null };
    }
    case 'close': {
      const ok = navigateMainWindowHash(`#/main/guide`);
      return { ok, message: ok ? '已关闭当前项目' : '主窗口不可用', project: null };
    }
    case 'blockly-live-operation': {
      const dir = requestedPath ? path.resolve(requestedPath) : getOpenedProjectPathFromWindow();
      const operation = payload && payload.operation;
      const projectOptionalOperations = new Set([
        'search_boards_libraries',
        'project_create',
        'app_info',
        'main_menu_list',
        'main_menu_execute',
        'child_app_list',
        'child_app_get',
        'child_app_open',
        'child_app_control',
        'child_app_window_list',
        'child_app_window_set_bounds',
        'child_app_window_arrange',
        'subapp_agent_call',
      ]);
      if (!dir && !projectOptionalOperations.has(operation)) return { ok: false, message: '当前没有打开的项目,且未提供 path' };
      const liveOperationTimeoutMs = operation === 'project_build'
        ? 620000
        : operation === 'project_create'
          ? 300000
          : operation === 'abs_apply'
            ? 120000
            : operation === 'subapp_agent_call'
              ? 620000
              : operation === 'child_app_control'
              || operation === 'child_app_open'
              || operation === 'child_app_window_set_bounds'
              || operation === 'child_app_window_arrange'
                ? 120000
                : 12000;
      const result = await requestMainWindow(
        'cli-bridge:blockly-live-operation',
        'cli-bridge:blockly-live-operation:response',
        {
          path: dir || '',
          operation,
          params: payload && payload.params,
        },
        liveOperationTimeoutMs,
      );
      return result && typeof result === 'object' ? result : { ok: false, message: '渲染进程返回了无效结果' };
    }
    default:
      return { ok: false, message: `未知命令: ${action}` };
  }
}

function getCliBridgeStatus() {
  return {
    pid: process.pid,
    project: getOpenedProjectPathFromWindow(),
    serve: !!serve,
  };
}

function startCliBridgeIfPossible() {
  if (cliBridge) return;
  try {
    cliBridge = startCliBridge({
      handleCommand: handleCliBridgeCommand,
      getStatus: getCliBridgeStatus,
    });
  } catch (e) {
    console.error('启动 CLI bridge 失败:', e);
  }
}
const DEFAULT_BUILD_FLAVOR = 'cn';
const BUILD_FLAVOR_TO_OFFICIAL_REGION = {
  cn: 'cn',
  global: 'eu'
};
const OFFICIAL_REGION_KEYS = new Set(Object.values(BUILD_FLAVOR_TO_OFFICIAL_REGION));
const ZIP_URL_REGION_KEYS = ['eu', 'cn'];

function normalizeBuildFlavor(flavor) {
  if (typeof flavor !== 'string') {
    return DEFAULT_BUILD_FLAVOR;
  }

  const normalizedFlavor = flavor.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(BUILD_FLAVOR_TO_OFFICIAL_REGION, normalizedFlavor)
    ? normalizedFlavor
    : DEFAULT_BUILD_FLAVOR;
}

let cachedPackagedMetadata;

function getPackagedMetadata() {
  if (cachedPackagedMetadata !== undefined) {
    return cachedPackagedMetadata;
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
      cachedPackagedMetadata = packageJson;
      return cachedPackagedMetadata;
    } catch (error) {
      console.warn('读取打包元数据失败:', error.message || error);
    }
  }

  cachedPackagedMetadata = null;
  return cachedPackagedMetadata;
}

function getPackagedBuildFlavor() {
  return getPackagedMetadata()?.ailyBuildFlavor;
}

function configurePackagedChatExecutionHost() {
  const packageMetadata = getPackagedMetadata();
  const configuredMode = typeof packageMetadata?.ailyChatExecutionHost === 'string'
    ? packageMetadata.ailyChatExecutionHost.trim()
    : '';
  const configuredRuntimeModule = typeof packageMetadata?.ailyChatExecutionHostRuntimeModule === 'string'
    ? packageMetadata.ailyChatExecutionHostRuntimeModule.trim()
    : '';

  if (!configuredMode || !configuredRuntimeModule) {
    return;
  }

  if (!process.env.AILY_CHAT_EXECUTION_HOST) {
    process.env.AILY_CHAT_EXECUTION_HOST = configuredMode;
  }
  if (!process.env.AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE) {
    process.env.AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE = path.resolve(app.getAppPath(), configuredRuntimeModule);
  }
}

configurePackagedChatExecutionHost();

function getBuildFlavor(conf) {
  return normalizeBuildFlavor(process.env.AILY_BUILD_FLAVOR || getPackagedBuildFlavor() || conf?.build_flavor);
}

function getOfficialRegionForFlavor(flavor) {
  return BUILD_FLAVOR_TO_OFFICIAL_REGION[normalizeBuildFlavor(flavor)] || BUILD_FLAVOR_TO_OFFICIAL_REGION[DEFAULT_BUILD_FLAVOR];
}

function isOfficialRegion(regionKey, regions = {}) {
  if (!regionKey || !regions[regionKey]) {
    return false;
  }

  if (typeof regions[regionKey].official === 'boolean') {
    return regions[regionKey].official;
  }

  return OFFICIAL_REGION_KEYS.has(regionKey);
}

function shouldFallbackToOfficialRegion(regionKey, officialRegion, regions = {}) {
  if (!regionKey || !officialRegion || !regions[regionKey]) {
    return true;
  }

  return isOfficialRegion(regionKey, regions) && regionKey !== officialRegion;
}

function normalizeResourceUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function getConfiguredResourceSources(conf = {}) {
  const seenUrls = new Set();
  const configuredSources = Array.isArray(conf.resource_sources) ? conf.resource_sources : [];
  const normalizedConfiguredSources = [];

  for (const source of configuredSources) {
    const url = normalizeResourceUrl(source && source.url);
    if (!url || source?.enabled === false || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    normalizedConfiguredSources.push({
      key: typeof source.key === 'string' && source.key.trim() ? source.key.trim() : `resource_${normalizedConfiguredSources.length + 1}`,
      url,
    });
  }

  if (normalizedConfiguredSources.length > 0) {
    return normalizedConfiguredSources;
  }

  const legacySources = [];
  for (const regionKey of ZIP_URL_REGION_KEYS) {
    const resource = normalizeResourceUrl(conf.regions?.[regionKey]?.resource);
    if (!resource || seenUrls.has(resource)) {
      continue;
    }

    seenUrls.add(resource);
    legacySources.push({ key: regionKey, url: resource });
  }

  return legacySources;
}

function getSelectedResourceSourceKey(conf = {}) {
  return typeof conf.resource_source === 'string' && conf.resource_source.trim()
    ? conf.resource_source.trim()
    : 'auto';
}

function getZipUrlState(conf = {}) {
  const sources = getConfiguredResourceSources(conf);
  if (sources.length === 0) {
    return { currentUrl: '', urls: [] };
  }

  const selectedKey = getSelectedResourceSourceKey(conf);
  if (selectedKey !== 'auto') {
    const selectedSource = sources.find((source) => source.key === selectedKey) || sources[0];
    return {
      currentUrl: selectedSource.url,
      urls: [selectedSource.url],
    };
  }

  return {
    currentUrl: sources[0].url,
    urls: sources.map((source) => source.url),
  };
}

function buildZipUrls(conf = {}) {
  return JSON.stringify(getZipUrlState(conf).urls);
}
let rendererGeneration = 0;
let readyRendererGeneration = 0;
let powerMonitorListenersRegistered = false;

function isCurrentMainRenderer(sender) {
  return !!mainWindow
    && !mainWindow.isDestroyed()
    && !!mainWindow.webContents
    && !mainWindow.webContents.isDestroyed()
    && sender?.id === mainWindow.webContents.id;
}

function isCurrentRendererGenerationReady() {
  return rendererGeneration > 0
    && readyRendererGeneration === rendererGeneration
    && isCurrentMainRenderer(mainWindow?.webContents);
}

function invalidateRendererGeneration(reason) {
  readyRendererGeneration = 0;
  console.info('[RendererLifecycle] unavailable', {
    generation: rendererGeneration,
    reason,
  });
}

function beginRendererGeneration(reason) {
  rendererGeneration += 1;
  invalidateRendererGeneration(reason);
  console.info('[RendererLifecycle] loading', {
    generation: rendererGeneration,
    reason,
  });
  return rendererGeneration;
}

ipcMain.handle('get-renderer-generation', (event) => {
  return isCurrentMainRenderer(event.sender) ? rendererGeneration : 0;
});

// 监听渲染进程就绪事件
ipcMain.on('renderer-ready', (event, payload = {}) => {
  const requestedGeneration = Number(payload?.generation);
  if (!isCurrentMainRenderer(event.sender)
    || !Number.isInteger(requestedGeneration)
    || requestedGeneration !== rendererGeneration) {
    console.warn('[RendererLifecycle] ignored stale renderer-ready', {
      requestedGeneration,
      currentGeneration: rendererGeneration,
      senderId: event.sender?.id,
    });
    return;
  }

  console.log('渲染进程已就绪', { generation: requestedGeneration });
  readyRendererGeneration = requestedGeneration;
  event.sender.send('renderer-ready-ack', { generation: requestedGeneration });

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

function registerPowerMonitorLifecycle() {
  if (powerMonitorListenersRegistered) {
    return;
  }
  powerMonitorListenersRegistered = true;
  powerMonitor.on('suspend', () => {
    if (isCurrentRendererGenerationReady()) {
      mainWindow.webContents.send('renderer-lifecycle', {
        kind: 'suspend',
        generation: rendererGeneration,
      });
    }
  });
  powerMonitor.on('resume', () => {
    if (isCurrentRendererGenerationReady()) {
      mainWindow.webContents.send('renderer-lifecycle', {
        kind: 'resume',
        generation: rendererGeneration,
      });
    }
  });
}

// 检查并解压 child 目录下的平台组件包
function installChildEnv(childPath, options) {
  const child_process = require("child_process");
  const {
    platformDir,
    z7Name,
    extraExtractArgs = [],
    isNodeInstallComplete,
    isProbeRsInstallComplete,
    afterNodeInstall,
  } = options;

  // 从文件名中提取版本号
  function extractVersion(filename, keyword) {
    // node 格式：node-v22.21.0-darwin-arm64.7z → 22.21.0
    // probe-rs 格式：probe-rs-0.31.0.7z → 0.31.0
    if (keyword === "node") {
      const match = filename.match(/node-v(\d+\.\d+\.\d+)/);
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

  function ensure7z() {
    const z7Path = path.join(childPath, z7Name);
    if (fs.existsSync(z7Path)) {
      return z7Path;
    }

    const z7SourcePath = path.join(childPath, platformDir, z7Name);
    if (!fs.existsSync(z7SourcePath)) {
      return null;
    }

    try {
      fs.copyFileSync(z7SourcePath, z7Path);
      if (!isWin32) {
        fs.chmodSync(z7Path, 0o755);
      }
      console.log(`安装 ${z7Name} 成功！`);
      return z7Path;
    } catch (error) {
      console.error(`安装 ${z7Name} 失败，错误码:`, error);
      return null;
    }
  }

  function ensureRg() {
    const rgName = isWin32 ? "rg.exe" : "rg";
    const rgPath = path.join(childPath, rgName);
    if (fs.existsSync(rgPath)) {
      return rgPath;
    }

    const rgSourcePath = path.join(childPath, platformDir, rgName);
    if (!fs.existsSync(rgSourcePath)) {
      return null;
    }

    try {
      fs.copyFileSync(rgSourcePath, rgPath);
      if (!isWin32) {
        fs.chmodSync(rgPath, 0o755);
      }
      console.log(`安装 ${rgName} 成功！`);
      return rgPath;
    } catch (error) {
      console.error(`安装 ${rgName} 失败，错误码:`, error);
      return null;
    }
  }

  function readInstalledVersion(targetPath) {
    const versionFile = path.join(targetPath, ".installed-version");
    if (!fs.existsSync(versionFile)) {
      return null;
    }
    try {
      return fs.readFileSync(versionFile, "utf8").trim() || null;
    } catch (_) {
      return null;
    }
  }

  function writeInstalledVersion(targetPath, version) {
    if (!version) {
      return;
    }
    fs.writeFileSync(path.join(targetPath, ".installed-version"), version);
  }

  function removeInstallDir(targetPath) {
    if (!fs.existsSync(targetPath)) {
      return;
    }
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`清理目录失败: ${targetPath}`, error);
    }
  }

  function run7zExtract(z7Path, extractArgs) {
    const result = child_process.spawnSync(z7Path, extractArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const message = result.stderr?.toString()?.trim() || `exit code ${result.status}`;
      throw new Error(message);
    }
  }

  function extract7zPackage(z7Path, archivePath, targetPath, keyword, validateComplete) {
    const installedVersion = readInstalledVersion(targetPath);
    const isComplete = validateComplete(targetPath);

    if (!archivePath || !fs.existsSync(archivePath)) {
      if (isComplete) {
        return true;
      }
      console.error(`未找到 ${keyword} 压缩包: ${archivePath}`);
      return false;
    }

    const archiveVersion = extractVersion(path.basename(archivePath), keyword);

    if (isComplete) {
      if (!installedVersion && archiveVersion) {
        writeInstalledVersion(targetPath, archiveVersion);
      }
      if (!archiveVersion || !installedVersion || installedVersion === archiveVersion) {
        return true;
      }
      console.warn(`${keyword} 版本不匹配，准备重新解压: ${installedVersion} -> ${archiveVersion}`);
      removeInstallDir(targetPath);
    } else if (fs.existsSync(targetPath)) {
      console.warn(`${keyword} 安装不完整，准备重新解压: ${targetPath}`);
      removeInstallDir(targetPath);
    }

    try {
      fs.mkdirSync(targetPath, { recursive: true });
      const extractArgs = ["x", archivePath, `-o${targetPath}`, "-y", ...extraExtractArgs];
      if (!isWin32) {
        extractArgs.push("-t7z");
      }
      run7zExtract(z7Path, extractArgs);

      if (!validateComplete(targetPath)) {
        throw new Error(`${keyword} 解压后缺少关键文件`);
      }

      writeInstalledVersion(targetPath, archiveVersion);
      console.log(`安装解压 ${keyword}: ${archivePath} 成功！`);
      if (!serve) {
        fs.unlinkSync(archivePath);
      }
      return true;
    } catch (error) {
      console.error(`安装解压 ${keyword}: ${archivePath} 失败，错误码:`, error);
      return false;
    }
  }

  const z7Path = ensure7z();
  const sourceDir = path.join(childPath, serve ? platformDir : "");

  const packages = [
    { name: "node", afterExtract: afterNodeInstall },
    { name: "probe-rs" },
  ];
  const validators = {
    node: isNodeInstallComplete,
    "probe-rs": isProbeRsInstallComplete,
  };

  for (const pkg of packages) {
    const targetPath = path.join(childPath, pkg.name);
    const archivePath =
      findLatestVersionFile(sourceDir, pkg.name) ||
      findLatestVersionFile(path.join(childPath, platformDir), pkg.name);
    if (z7Path) {
      extract7zPackage(z7Path, archivePath, targetPath, pkg.name, validators[pkg.name]);
    } else {
      console.error(`解压 ${pkg.name} 需要 ${z7Name}，但未找到`);
    }
    if (typeof pkg.afterExtract === "function") {
      pkg.afterExtract(targetPath);
    }
  }

  ensureRg();
}

// macos 检查安装环境
function macosInstallEnv(childPath) {
  const NODE_BIN_LINKS = [
    ["corepack", "../lib/node_modules/corepack/dist/corepack.js"],
    ["npm", "../lib/node_modules/npm/bin/npm-cli.js"],
    ["npx", "../lib/node_modules/npm/bin/npx-cli.js"],
  ];

  function isNodeBinEntryValid(binPath, name, relativeTarget) {
    const entryPath = path.join(binPath, name);
    const expectedTarget = path.resolve(binPath, relativeTarget);

    if (!fs.existsSync(entryPath)) {
      return false;
    }

    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      return fs.existsSync(path.resolve(binPath, fs.readlinkSync(entryPath)));
    }

    if (stat.isFile()) {
      return stat.size > 0 && fs.existsSync(expectedTarget);
    }

    return false;
  }

  function repairNodeBinSymlinks(nodePath) {
    const binPath = path.join(nodePath, "bin");
    if (!fs.existsSync(binPath)) {
      return;
    }

    for (const [name, relativeTarget] of NODE_BIN_LINKS) {
      const entryPath = path.join(binPath, name);
      const targetPath = path.join(binPath, relativeTarget);

      if (!fs.existsSync(targetPath)) {
        continue;
      }

      let needsRepair = true;
      if (fs.existsSync(entryPath)) {
        const stat = fs.lstatSync(entryPath);
        if (stat.isSymbolicLink()) {
          const resolvedTarget = path.resolve(binPath, fs.readlinkSync(entryPath));
          needsRepair = resolvedTarget !== path.resolve(targetPath) || !fs.existsSync(resolvedTarget);
        } else if (stat.isFile() && stat.size > 0) {
          needsRepair = false;
        }
      }

      if (!needsRepair) {
        continue;
      }

      try {
        if (fs.existsSync(entryPath)) {
          fs.unlinkSync(entryPath);
        }
        fs.symlinkSync(relativeTarget, entryPath);
        console.log(`已修复 node 软链: ${name} -> ${relativeTarget}`);
      } catch (error) {
        console.warn(`修复 node 软链失败: ${name}`, error);
      }
    }
  }

  function ensureNodeBinExecutable(nodePath) {
    const binPath = path.join(nodePath, "bin");
    if (!fs.existsSync(binPath)) {
      return;
    }

    repairNodeBinSymlinks(nodePath);

    const chmodExecutable = (entryPath, dirent) => {
      try {
        if (dirent.isSymbolicLink()) {
          return;
        }
        if (dirent.isDirectory()) {
          fs.chmodSync(entryPath, 0o755);
          for (const child of fs.readdirSync(entryPath, { withFileTypes: true })) {
            chmodExecutable(path.join(entryPath, child.name), child);
          }
          return;
        }
        fs.chmodSync(entryPath, 0o755);
      } catch (error) {
        console.warn(`设置可执行权限失败: ${entryPath}`, error);
      }
    };

    for (const entry of fs.readdirSync(binPath, { withFileTypes: true })) {
      chmodExecutable(path.join(binPath, entry.name), entry);
    }
  }

  installChildEnv(childPath, {
    platformDir: "macos",
    z7Name: "7zz",
    extraExtractArgs: ["-snld20"],
    isNodeInstallComplete(targetPath) {
      const binPath = path.join(targetPath, "bin");
      if (!fs.existsSync(path.join(binPath, "node"))) {
        return false;
      }

      return NODE_BIN_LINKS.every(([name, relativeTarget]) => (
        isNodeBinEntryValid(binPath, name, relativeTarget)
      ));
    },
    isProbeRsInstallComplete(targetPath) {
      return fs.existsSync(path.join(targetPath, "probe-rs"));
    },
    afterNodeInstall: ensureNodeBinExecutable,
  });
}

// windows 检查安装环境
function windowsInstallEnv(childPath) {
  installChildEnv(childPath, {
    platformDir: "windows",
    z7Name: "7za.exe",
    isNodeInstallComplete(targetPath) {
      return fs.existsSync(path.join(targetPath, "node.exe"));
    },
    isProbeRsInstallComplete(targetPath) {
      return fs.existsSync(path.join(targetPath, "probe-rs.exe"));
    },
  });
}

// 路径转义
function escapePath(path) {
  if (isWin32) {
    return path;
  }
  return path.replace(/(\s|[()&|;<>`$\\])/g, '\\$1');
}

function appendPathSegment(pathValue, segment, options = {}) {
  const { requireExists = true } = options;
  if (!segment || (requireExists && !fs.existsSync(segment))) {
    return pathValue;
  }
  return `${pathValue}${path.delimiter}${segment}`;
}

function normalizeWindowsPathValue(value) {
  if (!isWin32 || !value || typeof value !== 'string') {
    return value;
  }

  let normalized = value.trim().replace(/\//g, '\\');
  normalized = normalized.replace(/^([a-zA-Z]):(?!\\)/, '$1:\\');
  return normalized;
}

function appendExecutableDirIfExists(pathValue, segment, executableName) {
  if (!segment || !executableName) {
    return pathValue;
  }
  const executablePath = path.join(segment, executableName);
  if (!fs.existsSync(executablePath)) {
    return pathValue;
  }
  return appendPathSegment(pathValue, segment);
}

function uniquePathSegments(segments) {
  const seen = new Set();
  const result = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== "string") {
      continue;
    }
    const normalized = segment.trim();
    if (!normalized) {
      continue;
    }
    const key = isWin32 ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function appendGitToolPaths(pathValue) {
  const envGitPath = process.env.AILY_GIT_PATH || process.env.GIT_EXECUTABLE || "";
  if (envGitPath) {
    const gitPathStatTarget = fs.existsSync(envGitPath) ? envGitPath : "";
    if (gitPathStatTarget) {
      try {
        const stat = fs.statSync(gitPathStatTarget);
        const gitDir = stat.isDirectory() ? gitPathStatTarget : path.dirname(gitPathStatTarget);
        pathValue = appendExecutableDirIfExists(pathValue, gitDir, isWin32 ? "git.exe" : "git");
      } catch (_) {}
    }
  }

  if (isWin32) {
    const pathGitDirs = uniquePathSegments(
      ORIGINAL_PROCESS_PATH
        .split(path.delimiter)
        .filter(segment => segment && fs.existsSync(path.join(segment, "git.exe")))
    );
    for (const gitDir of pathGitDirs) {
      pathValue = appendExecutableDirIfExists(pathValue, gitDir, "git.exe");
    }

    const programFilesRoots = uniquePathSegments([
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : "",
      "C:\\Program Files",
      "C:\\Program Files (x86)",
    ]);
    for (const root of programFilesRoots) {
      pathValue = appendExecutableDirIfExists(pathValue, path.join(root, "Git", "cmd"), "git.exe");
      pathValue = appendExecutableDirIfExists(pathValue, path.join(root, "Git", "bin"), "git.exe");
    }
    return pathValue;
  }

  if (isDarwin) {
    for (const gitDir of ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]) {
      pathValue = appendExecutableDirIfExists(pathValue, gitDir, "git");
    }
    return pathValue;
  }

  if (isLinux) {
    for (const gitDir of ["/usr/bin", "/usr/local/bin", "/snap/bin"]) {
      pathValue = appendExecutableDirIfExists(pathValue, gitDir, "git");
    }
  }

  return pathValue;
}

// child 工具解压完成后再注入 PATH 与相关环境变量
function applyChildToolEnv(childPath) {
  const nodeBinPath = path.join(childPath, isDarwin ? "node/bin" : "node");
  let customPath = childPath;

  if (fs.existsSync(nodeBinPath)) {
    customPath = `${nodeBinPath}${path.delimiter}${customPath}`;
  }

  if (isWin32) {
    const systemRoot = normalizeWindowsPathValue(process.env.SystemRoot || process.env.windir || 'C:\\Windows');
    const programFiles = normalizeWindowsPathValue(process.env.ProgramFiles || 'C:\\Program Files');
    const systemPaths = [
      path.join(systemRoot, 'System32'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      path.join(programFiles, 'PowerShell', '7'),
      systemRoot
    ];
    systemPaths.forEach((sysPath) => {
      customPath = appendPathSegment(customPath, sysPath);
    });
    process.env.SystemRoot = systemRoot;
    process.env.windir = normalizeWindowsPathValue(process.env.windir || systemRoot);
    process.env.ComSpec = normalizeWindowsPathValue(process.env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe'));
  } else if (isDarwin) {
    ['/bin', '/usr/bin'].forEach((sysPath) => {
      customPath = appendPathSegment(customPath, sysPath);
    });
  } else if (isLinux) {
    customPath = appendPathSegment(customPath, '/bin');
  }

  const probeRsDir = path.join(childPath, "probe-rs");
  const z7Path = path.join(childPath, isWin32 ? "7za.exe" : "7zz");
  const rgPath = path.join(childPath, isWin32 ? "rg.exe" : "rg");
  const probeRsPath = path.join(probeRsDir, `probe-rs${isWin32 ? ".exe" : ""}`);

  customPath = appendPathSegment(customPath, probeRsDir);
  customPath = appendGitToolPaths(customPath);

  process.env.PATH = customPath;
  builder.applyCommandEnv(childPath);
  process.env.AILY_CHILD_PATH = childPath;
  process.env.AILY_7ZA_PATH = fs.existsSync(z7Path) ? z7Path : path.join(childPath, isWin32 ? "7za.exe" : "7zz");
  process.env.AILY_RG_PATH = fs.existsSync(rgPath) ? rgPath : path.join(childPath, isWin32 ? "rg.exe" : "rg");
  process.env.AILY_PROBE_RS_PATH = probeRsPath;
}

function runInstallEnv(childPath) {
  try {
    if (isDarwin) {
      macosInstallEnv(childPath);
    } else if (isWin32) {
      windowsInstallEnv(childPath);
    }
  } catch (error) {
    console.error("installEnv error: ", error);
  }
  applyChildToolEnv(childPath);
}

// 环境变量加载
function loadEnv() {
  let childPath = serve
    ? path.join(__dirname, "..", "child")
    : path.join(process.resourcesPath, "child");

  if (!fs.existsSync(childPath)) {
    const devChildPath = path.join(__dirname, "..", "child");
    if (fs.existsSync(devChildPath)) {
      console.warn(`child 工具目录不存在，回退到开发目录: ${childPath} -> ${devChildPath}`);
      childPath = devChildPath;
    }
  }

  // 读取config.json文件
  const configPath = path.join(__dirname, 'config', "config.json");
  const conf = JSON.parse(fs.readFileSync(configPath));

  // 显式 AILY_APPDATA_PATH 用于受控开发、E2E 和便携部署；仅在未提供时
  // 才使用平台默认配置。不能在启动中途覆盖调用方已选定的数据根目录。
  process.env.AILY_APPDATA_PATH = resolveAilyAppDataPath({
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    config: conf,
  });
  builder.configureCacheEnvironment();

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

  registerAppDataResourceLockHandlers();

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

  const cnRegionUrlKeys = [
    "api_server",
    "web",
    "ucenter_web",
    "tool_web",
    "npm_registry",
    "resource",
    "updater",
  ];
  const defaultCnRegion = (conf.regions && conf.regions.cn) || {};
  const forcedCnRegionUrls = cnRegionUrlKeys.reduce((urls, key) => {
    if (typeof defaultCnRegion[key] === 'string') {
      urls[key] = defaultCnRegion[key];
    }
    return urls;
  }, {});
  const hasCnRegionUrlChanges = (region) => {
    if (!region) {
      return true;
    }
    return cnRegionUrlKeys.some((key) => {
      const correctValue = forcedCnRegionUrls[key];
      return typeof correctValue === 'string' && region[key] !== correctValue;
    });
  };

  // 读取用户配置文件
  try {
    userConf = JSON.parse(fs.readFileSync(userConfigPath));

    // TODO: 下一版删除，统一修正 regions.cn 下所有地址为标准地址
    let needSave = false;
    if (userConf.regions && userConf.regions.cn) {
      for (const key of cnRegionUrlKeys) {
        const correctValue = forcedCnRegionUrls[key];
        if (typeof correctValue !== 'string') {
          continue;
        }

        const currentValue = userConf.regions.cn[key];
        if (currentValue !== correctValue) {
          console.log(`检测到需要更新的 cn.${key} 地址: ${currentValue || '(空)'} → ${correctValue}`);
          userConf.regions.cn[key] = correctValue;
          needSave = true;
        }
      }
    }

    // 合并配置文件
    Object.assign(conf, userConf);

    const buildFlavor = getBuildFlavor(conf);
    const officialRegion = getOfficialRegionForFlavor(buildFlavor);
    const configuredRegion = conf.region || officialRegion;

    if (shouldFallbackToOfficialRegion(configuredRegion, officialRegion, conf.regions)) {
      conf.region = officialRegion;
      userConf.region = officialRegion;
      needSave = true;
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
  } catch (error) {
    console.error("读取用户配置文件失败:", error);
    userConf = {}; // 确保userConf是一个对象
  }

  // TODO 下一版本删除，强制将 cn 区域所有地址设置为标准地址
  if (hasCnRegionUrlChanges(conf.regions && conf.regions["cn"])) {
    Object.assign(conf.regions["cn"], forcedCnRegionUrls);
  }
  const buildFlavor = getBuildFlavor(conf);
  const officialRegion = getOfficialRegionForFlavor(buildFlavor);
  const currentRegion = shouldFallbackToOfficialRegion(conf.region, officialRegion, conf.regions)
    ? officialRegion
    : (conf.region || officialRegion);
  const regionConfig = conf.regions && conf.regions[currentRegion] ? conf.regions[currentRegion] : conf.regions[officialRegion];
  const zipUrlState = getZipUrlState(conf);

  // 当前区域
  process.env.AILY_REGION = currentRegion;
  process.env.AILY_BUILD_FLAVOR = buildFlavor;
  process.env.AILY_OFFICIAL_REGION = officialRegion;
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
  // aily-builder / aily-linter 使用独立的 npm 全局 prefix。
  // AppData 根目录本身是开发板、SDK 和工具包的普通 npm 项目；两者共用
  // node_modules 时，开发板依赖的 npm install/uninstall 会清理掉全局工具。
  process.env.AILY_NPM_PREFIX = path.join(process.env.AILY_APPDATA_PATH, "npm-global");
  try {
    fs.mkdirSync(process.env.AILY_NPM_PREFIX, { recursive: true });
  } catch (error) {
    console.error("创建应用 npm 全局目录失败:", error);
  }
  process.env.npm_config_prefix = process.env.AILY_NPM_PREFIX;
  // 默认全局编译器路径
  process.env.AILY_COMPILERS_PATH = path.join(process.env.AILY_APPDATA_PATH, "tools",);
  // 默认全局烧录器路径
  process.env.AILY_TOOLS_PATH = path.join(process.env.AILY_APPDATA_PATH, "tools");
  // 默认全局SDK路径
  process.env.AILY_SDK_PATH = path.join(process.env.AILY_APPDATA_PATH, "sdk");
  // zip包下载镜像地址：auto 模式输出完整列表，手动模式仅输出选中地址
  process.env.AILY_ZIP_URLS = buildZipUrls(conf);
  // zip包下载地址
  process.env.AILY_ZIP_URL = zipUrlState.currentUrl || regionConfig.resource;
  // API服务器地址
  process.env.AILY_API_SERVER = regionConfig.api_server;
  process.env.AILY_TOOL_WEB = regionConfig.tool_web || '';

  process.env.AILY_PROJECT_PATH = conf["project_path"];
  // child 目录只管理 Node、7z、probe-rs 等随应用分发的工具；
  // aily-builder 与 aily-linter 由 npm 安装到应用专用的全局 prefix。

  // 必须先让 child Node 可用。首次启动和应用版本变化时安装 latest，
  // 同一应用版本复用现有工具；两个 npm 全局安装串行执行。
  runInstallEnv(childPath);
  const appVersion = app.getVersion();
  const isE2E = process.env.AILY_E2E === "1";
  const allowE2ERefresh = process.env.AILY_E2E_ALLOW_TOOL_REFRESH === "1";
  const installLatest = shouldInstallForAppVersion(userConf, appVersion, {
    isE2E,
    allowE2ERefresh,
  });
  if (isE2E && !allowE2ERefresh) {
    console.log("E2E mode: skipping automatic aily-builder and aily-linter latest refresh");
  }
  if (installLatest) {
    try {
      markInstalledForAppVersion(userConfigPath, appVersion);
      userConf.installed = appVersion;
      console.log(`aily blockly ${appVersion} will refresh aily-builder and aily-linter to latest`);
    } catch (error) {
      console.error("Failed to save aily tools refresh marker:", error);
    }
  }

  const builderInitialization = builder.initialize(childPath, {
    installLatest,
  });
  builderInitialization.then((result) => {
    if (installLatest && !result.startupInstallSucceeded) {
      console.error(`aily-builder@latest startup install failed: ${result.startupInstallError || result.error || "unknown error"}`);
    }
    if (!result.ok) {
      console.error(`aily-builder 初始化失败: ${result.error || "未知错误"}`);
    }
  }).catch((error) => console.error("aily-builder 初始化失败:", error));
  const linterInitialization = linter.initialize(childPath, builderInitialization, {
    installLatest,
  });
  linterInitialization.then((result) => {
    if (installLatest && !result.startupInstallSucceeded) {
      console.error(`aily-linter@latest startup install failed: ${result.startupInstallError || result.error || "unknown error"}`);
    }
    if (!result.ok) {
      console.error(`aily-linter 初始化失败: ${result.error || "未知错误"}`);
    }
  }).catch((error) => console.error("aily-linter 初始化失败:", error));

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
    await loadAppRenderer(mainWindow, targetUrl);
  }
}

function rectsOverlap(a, b) {
  return !(
    a.x + a.width <= b.x ||
    a.x >= b.x + b.width ||
    a.y + a.height <= b.y ||
    a.y >= b.y + b.height
  );
}

/** Windows：持久化坐标可能落在已移除的显示器上；electron-win-state 不会按当前屏幕校验。macOS 不处理。 */
function ensureWinStateOnVisibleDisplay(winState) {
  if (!isWin32) {
    return;
  }
  const s = winState.state;
  const w = Number(s.width);
  const h = Number(s.height);
  const x = Number(s.x);
  const y = Number(s.y);
  if (![w, h].every((n) => Number.isFinite(n) && n > 0) || ![x, y].every((n) => Number.isFinite(n))) {
    return;
  }
  const winRect = { x, y, width: w, height: h };
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => rectsOverlap(winRect, d.workArea));
  if (visible) {
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  let nw = w;
  let nh = h;
  if (nw > wa.width) {
    nw = wa.width;
  }
  if (nh > wa.height) {
    nh = wa.height;
  }
  s.width = nw;
  s.height = nh;
  s.x = Math.round(wa.x + Math.max(0, (wa.width - nw) / 2));
  s.y = Math.round(wa.y + Math.max(0, (wa.height - nh) / 2));
  try {
    winState.saveState();
  } catch (e) {
    console.warn('修正窗口位置后保存状态失败:', e);
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
  });
  ensureWinStateOnVisibleDisplay(winState);

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
      webSecurity: false,
      preload: path.join(__dirname, "preload.js"),
      enableBlinkFeatures: 'WebBluetooth',
      // 启用 Web Serial API 支持
      // enableBlinkFeatures: 'Serial',
      // 禁用后台节流和页面可见性，避免在后台时停止渲染
      backgroundThrottling: false,
      pageVisibility: true,
    },
  });

  registerWebBluetoothChooser(mainWindow);
  mainWindow.webContents.on('did-start-loading', () => {
    beginRendererGeneration('did-start-loading');
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
    void loadAppRenderer(mainWindow, targetUrl);
  } else {
    void loadAppRenderer(mainWindow);
  }

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Renderer process gone:', details.reason, 'exitCode:', details.exitCode);
    invalidateRendererGeneration(`render-process-gone:${details.reason}`);
    if (!serve) return;

    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('Reloading renderer after crash...');
        mainWindow.loadURL("http://localhost:4200");
      }
    }, 1000);
  });

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

    // 开启 DevTools (可选)
    // mainWindow.webContents.openDevTools();
  }

  // 当主窗口被关闭时，进行相应的处理
  mainWindow.on("closed", () => {
    invalidateRendererGeneration('window-closed');
    mainWindow = null;
    app.quit();
  });

  // 注册ipc handlers
  registerUpdaterHandlers(mainWindow);
  registerTerminalHandlers(mainWindow);
  registerWindowHandlers(mainWindow, {
    resolveRendererUrl: resolveAppRendererUrl,
  });
  registerNpmHandlers(mainWindow);
  registerCmdHandlers(mainWindow);
  registerAilyServicesStreamHandlers(mainWindow);
  registerWebviewBridgeHandlers();
  registerMCPHandlers(mainWindow);
  registerToolsHandlers(mainWindow);
  registerNotificationHandlers(mainWindow);
  registerProbeRsHandlers(mainWindow);
  registerBleHandlers();
  registerSubappManagerHandlers(() => mainWindow);
  builder.registerHandlers(() => mainWindow);
  linter.registerHandlers(() => mainWindow);

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
  try {
    await ensurePackagedRendererServerStarted();
  } catch (error) {
    console.error("Failed to start packaged renderer server:", error);
    dialog.showErrorBox(
      "Unable to start aily blockly",
      `The application interface could not be loaded: ${error.message}`,
    );
    app.quit();
    return;
  }

  createWindow();
  registerPowerMonitorLifecycle();

  // 启动 CLI bridge（供外部 CLI 驱动打开/关闭/重载项目）
  startCliBridgeIfPossible();
});

// 退出时关闭 CLI bridge 并清理发现文件
app.on('before-quit', () => {
  try {
    if (cliBridge) cliBridge.close();
  } catch (_) {
    /* ignore */
  }
});

// === Web Serial API 支持 ===
// 渲染端选择串口路径后，通过 IPC 设置首选端口；随后调用 navigator.serial.requestPort()
// 时由主进程 select-serial-port 事件按路径匹配并自动选中，与 ESPConnect 在浏览器内
// 直接用 WebSerial 的体验一致。
const webSerialPreferredPortByContents = new WeakMap();

ipcMain.handle('webserial-set-preferred-port', (event, portPath) => {
  if (event?.sender && typeof portPath === 'string' && portPath) {
    webSerialPreferredPortByContents.set(event.sender, portPath);
  }
  return true;
});

ipcMain.handle('webserial-clear-preferred-port', (event) => {
  if (event?.sender) {
    webSerialPreferredPortByContents.delete(event.sender);
  }
  return true;
});

function normalizePortPath(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[\\/]/g, '') : '';
}

function isAllowedWebDevicePermission(permission) {
  return permission === 'serial' || permission === 'bluetooth' || permission === 'bluetoothScanning';
}

function isAllowedWebDeviceType(deviceType) {
  return deviceType === 'serial' || deviceType === 'bluetooth' || deviceType === 'bluetoothLE';
}

app.on('web-contents-created', (event, contents) => {
  contents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    if (!Array.isArray(portList) || portList.length === 0) {
      callback('');
      return;
    }

    const preferred = webSerialPreferredPortByContents.get(contents);
    if (preferred) {
      const target = normalizePortPath(preferred);
      const match = portList.find(p => normalizePortPath(p.portName) === target || normalizePortPath(p.path) === target);
      if (match) {
        callback(match.portId);
        return;
      }
    }

    // 兜底：优先匹配 ESP 系常见 VID/PID
    const espVids = new Set(['303a', '10c4', '1a86', '0403', '067b']);
    const espMatch = portList.find(p => espVids.has(String(p.vendorId || '').toLowerCase()));
    if (espMatch) {
      callback(espMatch.portId);
      return;
    }

    callback(portList[0].portId);
  });

  contents.session.setPermissionCheckHandler((wc, permission) => {
    return isAllowedWebDevicePermission(permission);
  });

  contents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(isAllowedWebDevicePermission(permission));
  });

  contents.session.setDevicePermissionHandler((details) => {
    return isAllowedWebDeviceType(details.deviceType);
  });
});

// 当所有窗口都被关闭时退出应用（macOS 除外）
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function cleanupRegisteredChildProcesses() {
  console.info('[PROC_TRACE][APP_CLEANUP_START]', {
    cmd: getActiveCmdProcesses(),
    npm: getActiveNpmProcesses(),
    terminals: getActiveTerminals(),
    ailyServicesStreams: getActiveAilyServicesStreams()
  });

  return Promise.allSettled([
    killAllCmdProcesses(),
    killAllNpmProcesses(),
    killAllTerminals(),
    cancelAllAilyServicesStreams(),
    packagedRendererServer.close(),
  ]).then((results) => {
    // console.info('[PROC_TRACE][APP_CLEANUP_DONE]', { results });
  });
}

app.on("before-quit", (event) => {
  if (hasProcessCleanupCompleted) {
    return;
  }

  event.preventDefault();
  if (isProcessCleanupInProgress) {
    return;
  }

  isProcessCleanupInProgress = true;
  cleanupRegisteredChildProcesses()
    .catch((error) => {
      console.warn('[PROC_TRACE][APP_CLEANUP_ERROR]', error?.message || String(error));
    })
    .finally(() => {
      hasProcessCleanupCompleted = true;
      isProcessCleanupInProgress = false;
      app.quit();
    });
});

app.on("will-quit", () => {
  console.info('[PROC_TRACE][APP_WILL_QUIT]', {
    cmd: getActiveCmdProcesses(),
    npm: getActiveNpmProcesses(),
    terminals: getActiveTerminals(),
    ailyServicesStreams: getActiveAilyServicesStreams()
  });

  releaseAllAppDataResourceLocks();

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
  if (coderEmbedHttpServer) {
    if (coderEmbedHttpServer.kind === "static") {
      try {
        coderEmbedHttpServer.server.close();
      } catch (e) {
        console.warn("will-quit coder embed server:", e.message);
      }
    } else if (coderEmbedHttpServer.spawned && coderEmbedHttpServer.devProcess) {
      killCoderEmbedSpawnedDevProcess(coderEmbedHttpServer.devProcess);
    }
    coderEmbedHttpServer = null;
  }
  coderEmbedEnsureInFlight = null;
});

// 在 macOS 上，当应用被激活时（如点击 Dock 图标），重新创建窗口
app.on("activate", async () => {
  if (mainWindow === null) {
    // 先加载环境变量
    try {
      loadEnv();
    } catch (error) {
      console.error("loadEnv error: ", error);
    }
    // 创建主窗口
    try {
      await ensurePackagedRendererServerStarted();
      createWindow();
    } catch (error) {
      console.error("Failed to restart packaged renderer server:", error);
      dialog.showErrorBox(
        "Unable to start aily blockly",
        `The application interface could not be loaded: ${error.message}`,
      );
    }
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

        await loadAppRenderer(mainWindow, `#/${routePath}`);
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

// 内嵌 Coder（开发: child/coder Vite；生产: child/coder/dist）服务根地址
ipcMain.handle("coder-embed-get-base-url", async () => {
  const port = await ensureCoderEmbedServerStarted();
  return `http://127.0.0.1:${port}/`;
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
    const normalizedOptions = {
      ...(options || {}),
      properties: Array.isArray(options?.properties) && options.properties.length > 0
        ? options.properties
        : ["openFile"],
    };
    const result = await dialog.showOpenDialog(senderWindow, normalizedOptions);
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
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send("setting-changed", data);
      }
    } catch (error) {
      console.error("setting-changed broadcast failed:", error.message);
    }
  });
});

ipcMain.on("host-project-context-changed", (event, data = {}) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!mainWindow || senderWindow !== mainWindow) {
    return;
  }

  const rawWorkspace = typeof data.workspace === "string" ? data.workspace : "";
  projectContextState = {
    workspace: rawWorkspace.trim() ? rawWorkspace : null,
    version: projectContextState.version + 1,
  };

  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send("host-project-context-changed", projectContextState);
      }
    } catch (error) {
      console.error("host-project-context-changed broadcast failed:", error.message);
    }
  });
});

ipcMain.handle("host-project-context-get", () => ({ ...projectContextState }));

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
const activeRipgrepSearches = new Map();

function createRipgrepSearchController(requestId) {
  const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
  const controller = new AbortController();
  if (normalizedRequestId) {
    activeRipgrepSearches.get(normalizedRequestId)?.abort();
    activeRipgrepSearches.set(normalizedRequestId, controller);
  }
  return {
    controller,
    dispose() {
      if (normalizedRequestId && activeRipgrepSearches.get(normalizedRequestId) === controller) {
        activeRipgrepSearches.delete(normalizedRequestId);
      }
    }
  };
}

ipcMain.on('ripgrep-cancel-search', (_event, requestId) => {
  const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
  if (!normalizedRequestId) return;
  activeRipgrepSearches.get(normalizedRequestId)?.abort();
});

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

// v2 file search: path glob only, backed by `rg --files`.
ipcMain.handle('ripgrep-list-files-v2', async (_event, params = {}) => {
  const search = createRipgrepSearchController(params.requestId);
  try {
    return await ripgrep.listFiles(params, { signal: search.controller.signal });
  } catch (error) {
    return {
      success: false,
      files: [],
      numFiles: 0,
      error: error?.message || String(error)
    };
  } finally {
    search.dispose();
  }
});

// v2 content search: structured, globally bounded `rg --json` results.
ipcMain.handle('ripgrep-search-text-v2', async (_event, params = {}) => {
  const search = createRipgrepSearchController(params.requestId);
  try {
    return await ripgrep.searchText(params, { signal: search.controller.signal });
  } catch (error) {
    return {
      success: false,
      matches: [],
      numMatches: 0,
      error: error?.message || String(error)
    };
  } finally {
    search.dispose();
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

ipcMain.handle("fs-lstat", async (_event, filePath) => {
  const s = await fsPromises.lstat(filePath);
  return {
    size: s.size,
    mtime: s.mtime.toISOString(),
    birthtime: s.birthtime.toISOString(),
    _isDirectory: s.isDirectory(),
    _isFile: s.isFile(),
    _isSymbolicLink: s.isSymbolicLink(),
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
