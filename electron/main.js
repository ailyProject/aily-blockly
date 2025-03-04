const path = require("path");
const os = require("os");

const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require("electron");


const args = process.argv.slice(1);
const serve = args.some((val) => val === "--serve");
process.env.DEV = serve;

// ipc handlers模块
const { registerTerminalHandlers } = require("./terminal");
const { registerBoardHandlers } = require("./board");
const { registerWindowHandlers } = require("./window");
const { registerNpmHandlers } = require("./npm");
// 这个不知道还用不用  
const { registerProjectHandlers } = require("./project");

let mainWindow;

// 获取系统默认的应用数据目录
function getAppDataPath() {
  let home = os.homedir();
  let path;
  if (process.platform === "win32") {
    path = home + "\\AppData\\Local\\aily-project";
  } else if (process.platform === "darwin") {
    path = home + "/Library/Application Support/aily-project";
  } else {
    path = home + "/.config/aily-project";
  }
  if (!require("fs").existsSync(path)) {
    require("fs").mkdirSync(path, { recursive: true });
  }
  return path;
}

// 环境变量加载
function loadEnv() {
  // 将child目录添加到环境变量PATH中
  process.env.PATH += path.delimiter + path.join(__dirname, "..", "child");
  // TODO 需要配合解压node环境时命名的指定，当前默认为node
  process.env.PATH += path.delimiter + path.join(__dirname, "..", "child", "node");

  // 读取同级目录下的config.json文件
  const confContent = require("fs").readFileSync(
    path.join(__dirname, "config.json"),
  );
  const conf = JSON.parse(confContent);

  console.log("conf: ", conf);

  // app data path
  process.env.AILY_APPDATA_PATH = getAppDataPath();
  // npm registry
  process.env.AILY_NPM_REGISTRY = conf["npm_registry"][0];
  // 全局npm包路径
  process.env.AILY_NPM_PREFIX = process.env.AILY_APPDATA_PATH;
  // 默认全局编译器路径
  process.env.AILY_COMPILER_PATH = path.join(
    process.env.AILY_APPDATA_PATH,
    "compiler",
  );
  // 默认全局烧录器路径
  process.env.AILY_TOOL_PATH = path.join(process.env.AILY_APPDATA_PATH, "tool");
  // 默认全局SDK路径
  process.env.AILY_SDK_PATH = path.join(process.env.AILY_APPDATA_PATH, "sdk");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    frame: false,
    minWidth: 1200,
    minHeight: 780,
    autoHideMenuBar: true,
    transparent: true,
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: true,
      webSecurity: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (serve) {
    mainWindow.loadURL("http://localhost:4200");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(`renderer/index.html`);
    // mainWindow.webContents.openDevTools();
  }

  // 当主窗口被关闭时，进行相应的处理
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });

  try {
    loadEnv();
  } catch (error) {
    console.error("loadEnv error: ", error);
  }

  // 注册ipc handlers
  registerProjectHandlers(mainWindow);
  registerTerminalHandlers(mainWindow);
  registerBoardHandlers(mainWindow);
  registerWindowHandlers(mainWindow);
  registerNpmHandlers(mainWindow);
}

app.on("ready", () => {
  createWindow();
  // 这个用于双击实现窗口最大化，之后调
  // setInterval(() => {
  //   const cursorPos = screen.getCursorScreenPoint(); // 全局鼠标坐标
  //   const winPos = mainWindow.getBounds();             // 窗口在屏幕中的位置和大小

  //   // 计算鼠标在窗口中的位置
  //   const relativeX = cursorPos.x - winPos.x;
  //   const relativeY = cursorPos.y - winPos.y;
  //   // console.log('鼠标在窗口中的位置：', relativeX, relativeY);
  // }, 1000);
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
    createWindow();
  }
});

// 项目管理相关
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

// 环境变量
ipcMain.handle("env-set", (event, data) => {
  process.env[data.key] = data.value;
})

ipcMain.handle("env-get", (event, key) => {
  return process.env[key];
})

// 用于嵌入的iframe打开外部链接
app.on('web-contents-created', (event, contents) => {
  // 处理iframe中的链接点击
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' }; // 阻止在Electron中打开
  });
});