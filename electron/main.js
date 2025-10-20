const path = require("path");
const os = require("os");
const fs = require("fs");
const _ = require("lodash");
const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require("electron");

const { isWin32, isDarwin, isLinux } = require("./platform");

// 设置应用名称，用于 Windows 系统通知显示
app.setName("aily blockly");

// Windows 系统中设置 AppUserModelID，用于通知分组和显示
if (isWin32) {
  app.setAppUserModelId("pro.aily.blockly");
}

PROTOCOL = "ailyblockly";

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
    
    console.log('注册OAuth实例信息:', {
      state,
      instanceId: instanceInfo.instanceId,
      userDataPath: currentUserDataPath,
      stateFilePath
    });
    
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
    console.log('已注册OAuth状态:', state, '实例ID:', instanceInfo.instanceId);
    console.log('OAuth状态文件内容:', oauthStates);
    
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

// 隔离用户数据目录：为指定的多实例生成唯一的用户数据目录
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
    setupUniqueUserDataPath();
  } else {
    console.log('协议启动，跳过实例隔离设置');
  }
}

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
app.commandLine.appendSwitch('enable-features', 'V8LazyCodeGeneration,V8CacheOptions');

app.removeAsDefaultProtocolClient(PROTOCOL);

const args = process.argv.slice(1);
const serve = args.some((val) => val === "--serve");
process.env.DEV = serve;

// 注册协议处理
app.setAsDefaultProtocolClient(PROTOCOL);

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
const { initNotificationHandlers } = require("./notification");
// debug模块
const { initLogger } = require("./logger");
// tools
const { registerToolsHandlers } = require("./tools");

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
  // aily builder path
  process.env.AILY_BUILDER_PATH = path.join(childPath, "aily-builder");
  // 全局npm包路径
  process.env.AILY_NPM_PREFIX = process.env.AILY_APPDATA_PATH;
  // 默认全局编译器路径
  process.env.AILY_COMPILERS_PATH = path.join(
    process.env.AILY_APPDATA_PATH,
    "tools",
  );
  // 默认全局烧录器路径
  process.env.AILY_TOOLS_PATH = path.join(process.env.AILY_APPDATA_PATH, "tools");
  // 默认全局SDK路径
  process.env.AILY_SDK_PATH = path.join(process.env.AILY_APPDATA_PATH, "sdk");
  // zip包下载地址
  process.env.AILY_ZIP_URL = conf["resource"][0];

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
}


// 更新已存在主窗口的内容（用于second-instance处理）
function updateMainWindowWithPendingData() {
  if (!mainWindow || !mainWindow.webContents) {
    console.log('主窗口不存在，无法更新内容');
    return;
  }

  let targetUrl = null;

  if (pendingFileToOpen) {
    const routePath = `main/blockly-editor?path=${encodeURIComponent(pendingFileToOpen)}`;
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
  let windowBounds = getConfWindowBounds();

  mainWindow = new BrowserWindow({
    ...windowBounds,
    show: false,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'default',
    alwaysOnTop: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      webSecurity: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // mainWindow.setMenu(null);

  // 当页面准备好显示时，再显示窗口
  mainWindow.once('ready-to-show', () => {
    // 如果上次窗口是最大化状态，则恢复最大化
    if (windowBounds.isMaximized) {
      mainWindow.maximize();
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
  registerMCPHandlers(mainWindow);
  registerToolsHandlers(mainWindow);
  initNotificationHandlers();

  // 检查是否有待处理的OAuth回调
  if (global.pendingOAuthCallback) {
    // 延迟发送以确保渲染进程已准备好
    setTimeout(() => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('oauth-callback', global.pendingOAuthCallback);
        global.pendingOAuthCallback = null;
      }
    }, 2000);
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
      handleProtocol(protocolUrl);
      
      // 处理协议后不要置前窗口，让具体的处理逻辑决定
      return;
    } else {
      // 处理其他类型的启动参数（如.abi文件、路由参数等）
      handleCommandLineArgs(commandLine);
      
      // 如果有待处理的文件或路由，更新主窗口
      if (pendingFileToOpen || pendingRoute) {
        updateMainWindowWithPendingData();
      }
      
      // 将现有窗口置前
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
        mainWindow.show();
      }
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
        
        // 如果有待处理的文件或路由，更新主窗口
        if (pendingFileToOpen || pendingRoute) {
          updateMainWindowWithPendingData();
        }
      }
      
      // 将现有窗口置前
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
        mainWindow.show();
      }
    });
  }
}

app.on("ready", () => {
  try {
    loadEnv();
  } catch (error) {
    console.error("loadEnv error: ", error);
  }
  
  // 检查是否是协议启动
  const protocolUrl = process.argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
  if (protocolUrl) {
    console.log('应用启动时检测到协议参数:', protocolUrl);
    // 延迟处理协议，确保窗口创建完成
    setTimeout(() => {
      handleProtocol(protocolUrl);
    }, 1000);
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

// 打开新实例
ipcMain.handle("open-new-instance", async (event, data) => {
  try {
    const { route, queryParams } = data || {};

    // 构建命令行参数
    const args = ['--new-instance']; // 添加强制新实例标志

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

// settingChanged
ipcMain.on("setting-changed", (event, data) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  mainWindow.webContents.send("setting-changed", data);
});

// 记录窗口大小和位置，用于下次打开时恢复
function windowMoveResizeListener() {
  const bounds = mainWindow.getBounds();
  const isMaximized = mainWindow.isMaximized();
  // console.log("窗口位置和大小：", bounds, "最大化状态：", isMaximized);

  // 读取配置文件
  const userConfigPath = path.join(process.env.AILY_APPDATA_PATH, "config.json");
  let userConf = JSON.parse(fs.readFileSync(userConfigPath));

  // 确保window配置存在
  if (!userConf["window"]) {
    userConf["window"] = {};
  }

  if (isMaximized) {
    // 如果当前是最大化状态，只更新最大化状态，保留之前的normalBounds
    userConf["window"].isMaximized = true;
    // 如果之前没有记录normalBounds，使用当前bounds作为默认值
    if (!userConf["window"].normalBounds) {
      userConf["window"].normalBounds = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    }
  } else {
    // 如果当前不是最大化状态，记录当前大小为normalBounds
    userConf["window"] = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: false,
      normalBounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }
    };
  }

  fs.writeFileSync(userConfigPath, JSON.stringify(userConf));
}

function listenMoveResize() {
  const listener = _.debounce(windowMoveResizeListener.bind(this), 1000)
  mainWindow.on('resize', listener)
  mainWindow.on('move', listener)

  // 监听窗口最大化事件 - 在最大化前记录当前大小
  mainWindow.on('maximize', () => {
    // 在最大化之前，先记录当前的窗口大小到normalBounds
    const userConfigPath = path.join(process.env.AILY_APPDATA_PATH, "config.json");
    try {
      let userConf = JSON.parse(fs.readFileSync(userConfigPath));
      if (!userConf["window"]) {
        userConf["window"] = {};
      }

      // 只有当窗口当前不是最大化状态时，才记录normalBounds
      if (!mainWindow.isMaximized()) {
        const bounds = mainWindow.getBounds();
        userConf["window"].normalBounds = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      }

      userConf["window"].isMaximized = true;
      fs.writeFileSync(userConfigPath, JSON.stringify(userConf));
    } catch (error) {
      console.error('记录最大化前窗口大小失败:', error);
    }
  });

  // 监听窗口还原事件
  mainWindow.on('unmaximize', () => {
    // 还原到之前记录的大小
    const userConfigPath = path.join(process.env.AILY_APPDATA_PATH, "config.json");
    try {
      const userConf = JSON.parse(fs.readFileSync(userConfigPath));
      if (userConf.window && userConf.window.normalBounds) {
        const normalBounds = userConf.window.normalBounds;
        mainWindow.setBounds({
          x: normalBounds.x,
          y: normalBounds.y,
          width: normalBounds.width,
          height: normalBounds.height
        });
      }
    } catch (error) {
      console.error('恢复窗口大小失败:', error);
    }
    // 延迟保存状态，确保窗口大小已经改变
    setTimeout(() => {
      windowMoveResizeListener();
    }, 100);
  });
}

function getConfWindowBounds() {
  let bounds = userConf.window || {
    width: 1200,
    height: 780,
  };

  // 保存最大化状态
  const isMaximized = bounds.isMaximized || false;

  // 如果有normalBounds且当前不是最大化状态，使用normalBounds
  // 如果是最大化状态，使用normalBounds作为基础窗口大小（用于创建窗口）
  if (bounds.normalBounds) {
    bounds = {
      ...bounds.normalBounds,
      isMaximized: isMaximized
    };
  }

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

  // 添加最大化状态到返回的bounds中
  bounds.isMaximized = isMaximized;

  return bounds;
}

// OAuth状态管理的IPC处理器
ipcMain.handle("oauth-register-state", (event, state) => {
  return registerOAuthInstance(state);
});

ipcMain.handle("oauth-find-instance", (event, state) => {
  return findOAuthInstance(state);
});

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