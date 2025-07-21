const path = require("path");
const os = require("os");
const fs = require("fs");
const _ = require("lodash");
const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require("electron");

const { isWin32, isDarwin, isLinux } = require("./platform");

// 隔离用户数据目录：为每个实例生成唯一的用户数据目录。如果此处不隔离，会导致启动第二个实例时，要等待几秒才会出现窗口
function setupUniqueUserDataPath() {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  const instanceId = `${timestamp}-${randomId}`;

  const originalUserDataPath = app.getPath('userData');
  const uniqueUserDataPath = path.join(originalUserDataPath, 'instances', instanceId);

  // 设置唯一的用户数据目录
  app.setPath('userData', uniqueUserDataPath);
  console.log('启用实例隔离，设置实例用户数据目录:', uniqueUserDataPath);

  // 确保目录存在
  if (!fs.existsSync(uniqueUserDataPath)) {
    fs.mkdirSync(uniqueUserDataPath, { recursive: true });
  }
  return uniqueUserDataPath;
}

// 在应用初始化之前设置独立的用户数据目录
setupUniqueUserDataPath();

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
app.commandLine.appendSwitch('enable-features', 'V8LazyCodeGeneration,V8CacheOptions');

const args = process.argv.slice(1);
const serve = args.some((val) => val === "--serve");
process.env.DEV = serve;

// 文件关联处理
let pendingFileToOpen = null;
let pendingRoute = null;
let pendingQueryParams = null;

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

// macOS下处理文件打开
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (filePath.endsWith('.abi') && fs.existsSync(filePath)) {
    const projectDir = path.dirname(path.resolve(filePath));
    console.log('macOS open-file:', filePath);
    console.log('Project directory:', projectDir);

    if (mainWindow && mainWindow.webContents) {
      // 直接导航到对应路由
      const routePath = `main/blockly-editor?path=${encodeURIComponent(projectDir)}`;
      console.log('Navigating to route:', routePath);

      if (serve) {
        mainWindow.loadURL(`http://localhost:4200/#/${routePath}`);
      } else {
        mainWindow.loadFile(`renderer/index.html`, { hash: `#/${routePath}` });
      }
    } else {
      pendingFileToOpen = projectDir;
    }
  }
});

// ipc handlers模块
const { registerTerminalHandlers } = require("./terminal");
const { registerWindowHandlers } = require("./window");
const { registerNpmHandlers } = require("./npm");
const { registerUpdaterHandlers } = require("./updater");
const { registerCmdHandlers } = require("./cmd");
// debug模块
const { initLogger } = require("./logger");

let mainWindow;
let userConf;

// 环境变量加载
function loadEnv() {
  // 将child目录添加到环境变量PATH中
  const childPath = path.join(__dirname, "..", "child")
  const nodePath = path.join(childPath, "node")

  // 只保留PowerShell路径，移除其他系统PATH
  let customPath = nodePath + path.delimiter + childPath;

  if (isWin32) {
    // 添加必要的系统路径
    const systemPaths = [
      'C:\\Windows\\System32',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Program Files\\PowerShell\\7', // PowerShell 7 (如果存在)
      'C:\\Windows'
    ];

    // 检查路径是否存在，只添加存在的路径
    systemPaths.forEach(sysPath => {
      if (fs.existsSync(sysPath)) {
        customPath += path.delimiter + sysPath;
      }
    });
  }

  // 完全替换PATH
  process.env.PATH = customPath;

  // 读取同级目录下的config.json文件
  const configPath = path.join(__dirname, "config.json");
  const conf = JSON.parse(fs.readFileSync(configPath));

  // 设置系统默认的应用数据目录
  if (isWin32) {
    // 设置Windows的环境变量
    process.env.AILY_APPDATA_PATH = conf["appdata_path"]["win32"].replace('%HOMEPATH%', os.homedir());
  } else if (isDarwin) {
    // 设置macOS的环境变量
    process.env.AILY_APPDATA_PATH = conf["appdata_path"]["darwin"];
  } else {
    // 设置Linux的环境变量
    process.env.AILY_APPDATA_PATH = conf["appdata_path"]["linux"];
  }

  // 确保应用数据目录存在
  if (!fs.existsSync(process.env.AILY_APPDATA_PATH)) {
    try {
      fs.mkdirSync(process.env.AILY_APPDATA_PATH, { recursive: true });
    } catch (error) {
      console.error("创建应用数据目录失败:", error);
    }
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
    // 合并配置文件
    Object.assign(conf, userConf);
  } catch (error) {
    console.error("读取用户配置文件失败:", error);
    userConf = {}; // 确保userConf是一个对象
  }

  // npm registry
  process.env.AILY_NPM_REGISTRY = conf["npm_registry"][0];
  // 7za path
  process.env.AILY_7ZA_PATH = path.join(childPath, "7za.exe")
  // 全局npm包路径
  process.env.AILY_NPM_PREFIX = process.env.AILY_APPDATA_PATH;
  // 默认全局编译器路径
  process.env.AILY_COMPILERS_PATH = path.join(
    process.env.AILY_APPDATA_PATH,
    "compiler",
  );
  // 默认全局烧录器路径
  process.env.AILY_TOOLS_PATH = path.join(process.env.AILY_APPDATA_PATH, "tools");
  // 默认全局SDK路径
  process.env.AILY_SDK_PATH = path.join(process.env.AILY_APPDATA_PATH, "sdk");
  // zip包下载地址
  process.env.AILY_ZIP_URL = conf["resource"][0];

  process.env.AILY_PROJECT_PATH = conf["project_path"];
}


function createWindow() {
  let windowBounds = getConfWindowBounds();

  mainWindow = new BrowserWindow({
    ...windowBounds,
    show: false,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'default',
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: true,
      webSecurity: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // 当页面准备好显示时，再显示窗口
  mainWindow.once('ready-to-show', () => {
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

  // 当主窗口被关闭时，进行相应的处理
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });

  try {
    initLogger(process.env.AILY_APPDATA_PATH);
  } catch (error) {
    console.error("initLogger error: ", error);
  }

  // 注册ipc handlers
  registerUpdaterHandlers(mainWindow);
  registerTerminalHandlers(mainWindow);
  registerWindowHandlers(mainWindow);
  registerNpmHandlers(mainWindow);
  registerCmdHandlers(mainWindow);
}

app.on("ready", () => {
  try {
    loadEnv();
  } catch (error) {
    console.error("loadEnv error: ", error);
  }
  // 创建主窗口
  createWindow();
  listenMoveResize();
});

// 当所有窗口都被关闭时退出应用（macOS 除外）
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
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
    title: '项目另存为'
  });

  if (result.canceled) {
    return data.path || '';
  }
  // 直接返回用户选择的完整路径，保留文件名部分
  return result.filePath;
});

// 环境变量
ipcMain.handle("env-set", (event, data) => {
  process.env[data.key] = data.value;
})

ipcMain.handle("env-get", (event, key) => {
  return process.env[key];
})

// 打开新实例
ipcMain.handle("open-new-instance", async (event, data) => {
  try {
    const { route, queryParams } = data || {};

    // 构建命令行参数
    const args = [];

    // 如果有路由参数，将其作为环境变量传递
    if (route) {
      args.push(`--route=${route}`);
    }

    // 如果有查询参数，将其序列化后传递
    if (queryParams) {
      args.push(`--query=${encodeURIComponent(JSON.stringify(queryParams))}`);
    }

    // 启动新实例
    const { spawn } = require('child_process');
    const execPath = process.execPath;
    const appPath = __dirname;

    // 构建完整的启动参数
    const spawnArgs = [appPath, ...args];

    console.log('启动新实例:', execPath, spawnArgs);

    const child = spawn(execPath, spawnArgs, {
      detached: true,
      stdio: 'ignore'
    });

    // 分离子进程，使其独立运行
    child.unref();

    return {
      success: true,
      pid: child.pid,
      message: '新实例已启动'
    };

  } catch (error) {
    console.error('启动新实例失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
})

// 用于嵌入的iframe打开外部链接
app.on('web-contents-created', (event, contents) => {
  // 处理iframe中的链接点击
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' }; // 阻止在Electron中打开
  });
});

// settingChanged
ipcMain.on("setting-changed", (event, data) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  mainWindow.webContents.send("setting-changed", data);
});

// 记录窗口大小和位置，用于下次打开时恢复
function windowMoveResizeListener() {
  const bounds = mainWindow.getBounds();
  // console.log("窗口位置和大小：", bounds);
  // 读取配置文件, 将窗口位置和大小保存到配置文件中
  const userConfigPath = path.join(process.env.AILY_APPDATA_PATH, "config.json");
  let userConf = JSON.parse(fs.readFileSync(userConfigPath));
  userConf["window"] = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  fs.writeFileSync(userConfigPath, JSON.stringify(userConf));
}

function listenMoveResize() {
  const listener = _.debounce(windowMoveResizeListener.bind(this), 1000)
  mainWindow.on('resize', listener)
  mainWindow.on('move', listener)
}

function getConfWindowBounds() {
  let bounds = userConf.window || {
    width: 1200,
    height: 780,
  };
  // 确保窗口位置在屏幕范围内
  const screenBounds = screen.getPrimaryDisplay().bounds;
  if (bounds.x < screenBounds.x) {
    bounds.x = screenBounds.x;
  }
  if (bounds.y < screenBounds.y) {
    bounds.y = screenBounds.y;
  }
  if (bounds.width > screenBounds.width) {
    bounds.width = screenBounds.width;
  }
  if (bounds.height > screenBounds.height) {
    bounds.height = screenBounds.height;
  }
  return bounds;
}

// 清理过期的实例目录（可选功能）
function cleanupOldInstances() {
  try {
    const originalUserDataPath = app.getPath('userData').replace(/[/\\]instances[/\\][^/\\]+$/, '');
    const instancesDir = path.join(originalUserDataPath, 'instances');

    if (!fs.existsSync(instancesDir)) {
      return;
    }

    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24小时

    fs.readdirSync(instancesDir).forEach(instanceId => {
      const instancePath = path.join(instancesDir, instanceId);
      const stats = fs.statSync(instancePath);

      // 如果实例目录超过24小时未使用，则删除
      if (now - stats.mtime.getTime() > maxAge) {
        fs.rmSync(instancePath, { recursive: true, force: true });
        console.log('已清理过期实例目录:', instancePath);
      }
    });
  } catch (error) {
    console.error('清理实例目录时出错:', error);
  }
}

cleanupOldInstances();
