const { contextBridge, ipcRenderer, shell } = require("electron");
const { SerialPort } = require("serialport");
const { exec } = require("child_process");
const { existsSync } = require("fs");

contextBridge.exposeInMainWorld("electronAPI", {
  ipcRenderer: {
    send: (channel, data) => ipcRenderer.send(channel, data),
    on: (channel, callback) => ipcRenderer.on(channel, callback),
    invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  },
  path: {
    getUserHome: () => require("os").homedir(),
    getAppData: () => process.env.AILY_APPDATA_PATH,
    getUserDocuments: () => {
      let path = require("os").homedir() + "\\Documents\\aily-project";
      if (!require("fs").existsSync(path)) {
        require("fs").mkdirSync(path, { recursive: true });
      }
      return path;
    },
    isExists: (path) => {
      return require("fs").existsSync(path);
    },
  },
  versions: () => process.versions,
  SerialPort: {
    list: async () => await SerialPort.list(),
    create: (options) => new SerialPort(options),
  },
  platform: {
    type: () => process.platform,
    isWindows: () => process.platform === "win32",
    isMacOS: () => process.platform === "darwin",
    isLinux: () => process.platform === "linux",
  },
  terminal: {
    init: (data) => ipcRenderer.invoke("terminal-create", data),
    onData: (callback) => {
      ipcRenderer.on("terminal-inc-data", (event, data) => {
        callback(data);
      });
    },
    sendInput: (data) => ipcRenderer.send("terminal-to-pty", data),
    sendInputAsync: (data) => ipcRenderer.invoke("terminal-to-pty-async", data),
    close: (data) => ipcRenderer.send("terminal-close", data),
    resize: (data) => ipcRenderer.send("terminal-resize", data)
  },
  iWindow: {
    minimize: () => ipcRenderer.send("window-minimize"),
    maximize: () => ipcRenderer.send("window-maximize"),
    close: () => ipcRenderer.send("window-close"),
    // 子窗口收回到主窗口事件
    goMain: (data) => ipcRenderer.send("window-go-main", data),
    // 向其他窗口发送消息
    send: (data) => ipcRenderer.invoke("window-send", data),
    onReceive: (callback) => ipcRenderer.on("window-receive", callback),
  },
  subWindow: {
    open: (options) => ipcRenderer.send("window-open", options),
    close: () => ipcRenderer.send("window-close"),
  },
  project: {
    new: (data) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("project-new", data)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
    open: (path) => ipcRenderer.invoke("project-open", path),
    save: () => ipcRenderer.invoke("project-save"),
    saveAs: (path) => ipcRenderer.invoke("project-saveAs", path),
    // update: (data) => ipcRenderer.send("project-update", data),
    // newTmp: () => ipcRenderer.invoke("project-newTmp"),
  },
  dependencies: {
    init: (data) => ipcRenderer.invoke("dependencies-init", data),
    install: (data) => ipcRenderer.invoke("dependencies-install", data),
    boardList: () => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("board-list")
          .then((result) => resolve(result["boards"]))
          .catch((error) => reject(error));
      });
    },
    installedList: () => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("installed-dependencies")
          .then((result) => resolve(result["deps"]))
          .catch((error) => reject(error));
      });
    }
  },
  builder: {
    init: (data) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("builder-init", data)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
    codeGen: (data) => ipcRenderer.invoke("builder-codeGen", data),
    build: (data) => ipcRenderer.invoke("builder-build", data),
  },
  uploader: {
    upload: (data) => ipcRenderer.invoke("uploader-upload", data),
  },
  file: {
    readFileSync: (path) => require("fs").readFileSync(path, "utf8"),
    writeFileSync: (path, data) => require("fs").writeFileSync(path, data),
    mkdirSync: (path) => require("fs").mkdirSync(path, { recursive: true }),
    copySync: (src, dest) => require("fs-extra").copySync(src, dest),
    existsSync: (path) => require("fs").existsSync(path),
  },
  ble: {

  },
  wifi: {

  },
  other: {
    // 通过资源管理器打开 
    openByExplorer: (path) => {
      if (process.platform === 'win32') {
        exec(`explorer.exe "${path}"`, (error) => { });
      } else {
        shell.openPath(path)
      }
    },
    // 通过浏览器打开
    openByBrowser: (url) => shell.openExternal(url),
    exitApp: () => ipcRenderer.send("window-close"),
  },
  env: {
    set: (data) => ipcRenderer.invoke("env-set", data),
    get: (key) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("env-get", key)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
  },
  npm: {
    run: (data) => ipcRenderer.invoke("npm-run", data),
  }
});
