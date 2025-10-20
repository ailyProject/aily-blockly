const { contextBridge, ipcRenderer, shell, safeStorage, webFrame } = require("electron");
const { SerialPort } = require("serialport");
const { exec } = require("child_process");
const { existsSync, statSync } = require("fs");

// 单双杠虽不影响实用性，为了路径规范好看，还是单独使用
const pt = process.platform === "win32" ? "\\" : "/"

contextBridge.exposeInMainWorld("electronAPI", {
  ipcRenderer: {
    send: (channel, data) => ipcRenderer.send(channel, data),
    on: (channel, callback) => ipcRenderer.on(channel, callback),
    invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  },
  path: {
    getUserHome: () => require("os").homedir(),
    getAppDataPath: () => process.env.AILY_APPDATA_PATH,
    getAilyBuilderPath: () => process.env.AILY_BUILDER_PATH,
    getAilyBuilderBuildPath: () => process.env.AILY_BUILDER_BUILD_PATH,
    getUserDocuments: () => require("os").homedir() + `${pt}Documents`,
    isExists: (path) => existsSync(path),
    getElectronPath: () => __dirname,
    isDir: (path) => statSync(path).isDirectory(),
    join: (...args) => require("path").join(...args),
    dirname: (path) => require("path").dirname(path),
    extname: (path) => require("path").extname(path),
    normalize: (path) => require("path").normalize(path),
    resolve: (path) => require("path").resolve(path),
    basename: (path, suffix = undefined) => require("path").basename(path, suffix)
  },
  versions: () => process.versions,
  SerialPort: {
    list: async () => await SerialPort.list(),
    create: (options) => {
      const port = new SerialPort(options);
      return {
        write: (data, callback) => port.write(data, callback),
        open: (callback) => port.open(callback),
        close: (callback) => port.close(callback),
        on: (event, callback) => {
          port.on(event, callback);
          return port; // 允许链式调用
        },
        off: (event, callback) => {
          port.off(event, callback);
          return port;
        },
        set: (options, callback) => port.set(options, callback),
        dtrBool: () => {
          if (typeof port.dtrBool === 'function') {
            return port.dtrBool();
          }
          return false; // 如果方法不存在，返回默认值
        },
        // 添加获取RTS状态的方法
        rtsBool: () => {
          if (typeof port.rtsBool === 'function') {
            return port.rtsBool();
          }
          return false; // 如果方法不存在，返回默认值
        },
        get path() { return port.path; },
        get isOpen() { return port.isOpen; }
      };
    }
  },
  platform: {
    type: process.platform,
    pt,
    isWindows: process.platform === "win32",
    isMacOS: process.platform === "darwin",
    isLinux: process.platform === "linux",
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
    resize: (data) => ipcRenderer.send("terminal-resize", data),
    // 开始流式监听
    startStream: (pid) => {
      const streamId = `stream_${Date.now()}`;
      return ipcRenderer.invoke('terminal-stream-start', { pid, streamId });
    },
    // 停止流式监听
    stopStream: (pid, streamId) => {
      return ipcRenderer.invoke('terminal-stream-stop', { pid, streamId });
    },
    // 监听流数据
    onStreamData: (streamId, callback) => {
      const listener = (event, data) => {
        callback(data.lines, data.complete);
      };
      ipcRenderer.on(`terminal-stream-data-${streamId}`, listener);
      // 返回解除监听函数
      return () => {
        ipcRenderer.removeListener(`terminal-stream-data-${streamId}`, listener);
      };
    },
    // 执行命令并流式获取输出
    executeWithStream: (pid, command) => {
      const streamId = `stream_${Date.now()}`;
      return ipcRenderer.invoke('terminal-to-pty-stream', {
        pid,
        input: command + '\r',
        streamId
      });
    },

    // 中断当前执行的命令（发送 Ctrl+C）
    interrupt: (pid) => ipcRenderer.invoke("terminal-interrupt", { pid }),

    // 强制终止进程（当普通中断无效时）
    killProcess: (pid, processName) => ipcRenderer.invoke("terminal-kill-process", { pid, processName }),
  },
  iWindow: {
    minimize: () => ipcRenderer.send("window-minimize"),
    maximize: () => ipcRenderer.send("window-maximize"),
    isMaximized: () => ipcRenderer.sendSync("window-is-maximized"),
    unmaximize: () => ipcRenderer.send("window-unmaximize"),
    close: () => ipcRenderer.send("window-close"),
    // 子窗口收回到主窗口事件
    goMain: (data) => ipcRenderer.send("window-go-main", data),
    // 向其他窗口发送消息
    send: (data) => ipcRenderer.invoke("window-send", data),
    onReceive: (callback) => ipcRenderer.on("window-receive", callback),
    // 检查窗口是否为活动窗口
    isFocused: () => ipcRenderer.sendSync("window-is-focused"),
    // 监听窗口获得焦点事件
    onFocus: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("window-focus", listener);
      return () => ipcRenderer.removeListener("window-focus", listener);
    },
    // 监听窗口失去焦点事件
    onBlur: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("window-blur", listener);
      return () => ipcRenderer.removeListener("window-blur", listener);
    },
  },
  subWindow: {
    open: (options) => ipcRenderer.send("window-open", options),
    close: () => ipcRenderer.send("window-close"),
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
  fs: {
    readFileSync: (path, encoding = "utf8") => require("fs").readFileSync(path, encoding),
    readDirSync: (path) => require("fs").readdirSync(path, { withFileTypes: true }),
    writeFileSync: (path, data) => require("fs").writeFileSync(path, data),
    mkdirSync: (path) => require("fs").mkdirSync(path, { recursive: true }),
    copySync: (src, dest) => require("fs-extra").copySync(src, dest),
    existsSync: (path) => require("fs").existsSync(path),
    statSync: (path) => require("fs").statSync(path),
    isDirectory: (path) => require("fs").statSync(path).isDirectory(),
    unlinkSync: (path, cb) => require("fs").unlinkSync(path, cb),
    rmdirSync: (path) => require("fs").rmdirSync(path, { recursive: true, force: true }),
    renameSync: (oldPath, newPath) => require("fs").renameSync(oldPath, newPath),
  },
  glob: {
    // 使用glob模式查找文件
    sync: (pattern, options = {}) => {
      try {
        const glob = require("glob");
        return glob.sync(pattern, options);
      } catch (error) {
        console.error("Glob sync error:", error);
        return [];
      }
    },
    // 异步版本
    async: (pattern, options = {}) => {
      return new Promise((resolve, reject) => {
        try {
          const glob = require("glob");
          glob(pattern, options, (error, files) => {
            if (error) {
              reject(error);
            } else {
              resolve(files);
            }
          });
        } catch (error) {
          reject(error);
        }
      });
    }
  },
  ble: {

  },
  wifi: {

  },
  dialog: {
    selectFiles: (options) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("dialog-select-files", options)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    }
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
    // 移动文件到回收站
    moveToTrash: (filePath) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("move-to-trash", filePath)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
    exitApp: () => ipcRenderer.send("window-close"),
    // 打开新的程序实例
    openNewInstance: (options = {}) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("open-new-instance", options)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
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
  // 这个计划移除，替换成cmd.run
  npm: {
    run: (data) => ipcRenderer.invoke("npm-run", data),
  },
  // 执行命令行命令
  cmd: {
    run: (options) => ipcRenderer.invoke('cmd-run', options),
    kill: (streamId) => ipcRenderer.invoke('cmd-kill', { streamId }),
    killByName: (processName) => ipcRenderer.invoke('cmd-kill-by-name', { processName }),
    input: (streamId, input) => ipcRenderer.invoke('cmd-input', { streamId, input }),
    onData: (streamId, callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on(`cmd-data-${streamId}`, listener);
      // 返回解除监听函数
      return () => {
        ipcRenderer.removeListener(`cmd-data-${streamId}`, listener);
      };
    }
  },
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('start-download'),
    cancelDownload: () => ipcRenderer.invoke('cancel-download'),
    quitAndInstall: () => ipcRenderer.send('quit-and-install'),
    onUpdateStatus: (callback) => {
      ipcRenderer.on('update-status', (_, data) => callback(data));
    }
  },
  mcp: {
    connect: (name, command, args) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke('mcp:connect', name, command, args)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      })
    },
    getTools: (name) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke('mcp:get-tools', name)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      })
    },
    useTool: (toolName, args) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke('mcp:use-tool', toolName, args)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      })
    }
  },
  // 安全存储 API
  safeStorage: {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptString(plainText),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted)
  },
  // 窗口缩放 API
  webFrame: {
    setZoomLevel: (level) => webFrame.setZoomLevel(level),
    getZoomLevel: () => webFrame.getZoomLevel(),
    setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
    getZoomFactor: () => webFrame.getZoomFactor()
  },
  // GitHub OAuth API (简化版，只处理协议回调)
  oauth: {
    onCallback: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('oauth-callback', listener);
      // 返回解除监听函数
      return () => {
        ipcRenderer.removeListener('oauth-callback', listener);
      };
    },
    // 注册OAuth状态，用于多实例回调匹配
    registerState: (state) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke('oauth-register-state', state)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
    // 查找OAuth实例
    findInstance: (state) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke('oauth-find-instance', state)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    }
  },
  tools: {
    findFileByName: (searchPath, fileName) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("find-file", searchPath, fileName)
          .then((files) => resolve(files))
          .catch((error) => reject(error));
      });
    },
    calculateMD5: (text) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("calculate-md5", text)
          .then((md5) => resolve(md5))
          .catch((error) => reject(error));
      });
    }
  },
  // 系统通知 API
  notification: {
    /**
     * 显示系统通知
     * @param {Object} options - 通知选项
     * @param {string} options.title - 通知标题
     * @param {string} options.body - 通知内容
     * @param {string} [options.icon] - 通知图标路径（可选）
     * @param {boolean} [options.silent=false] - 是否静音（可选）
     * @param {string} [options.timeoutType='default'] - 超时类型（可选，'default' | 'never'）
     * @param {string} [options.urgency] - 紧急程度（可选，'normal' | 'critical' | 'low'，仅 Linux）
     * @returns {Promise<{success: boolean, result?: any, error?: string}>}
     */
    show: (options) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("notification-show", options)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
    /**
     * 检查系统是否支持通知
     * @returns {Promise<boolean>}
     */
    isSupported: () => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("notification-is-supported")
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    }
  }
});
