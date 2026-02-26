const { contextBridge, ipcRenderer, shell, safeStorage, webFrame } = require("electron");
const { SerialPort } = require("serialport");
const { createThrottledSerialPort, listPorts } = require("./serial");
const { exec } = require("child_process");
const { existsSync, statSync } = require("fs");
const { isAbsolute } = require("path");
const { tmpdir } = require("os");

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
    getAilyChildPath: () => process.env.AILY_CHILD_PATH,
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
    relative: (from, to) => require("path").relative(from, to),
    basename: (path, suffix = undefined) => require("path").basename(path, suffix),
    isAbsolute: (path) => isAbsolute(path),
  },
  versions: () => process.versions,
  SerialPort: {
    list: async () => await listPorts(),
    create: (options) => createThrottledSerialPort(options)
  },
  os: {
    tmpdir: () => tmpdir(),
  },
  platform: {
    type: process.platform,
    pt,
    isWindows: process.platform === "win32",
    isMacOS: process.platform === "darwin",
    isLinux: process.platform === "linux",
    lang: process.env.AILY_SYSTEM_LANG || 'zh-CN'
  },
  terminal: {
    init: (data) => ipcRenderer.invoke("terminal-create", data),
    getShell: () => ipcRenderer.invoke("terminal-get-shell"),
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
    // 监听窗口全屏状态变化事件
    onFullScreenChanged: (callback) => {
      const listener = (event, isFullScreen) => callback(isFullScreen);
      ipcRenderer.on("window-full-screen-changed", listener);
      return () => ipcRenderer.removeListener("window-full-screen-changed", listener);
    },
    // 监听窗口最大化状态变化事件
    onMaximizeChanged: (callback) => {
      const listener = (event, isMaximized) => callback(isMaximized);
      ipcRenderer.on("window-maximize-changed", listener);
      return () => ipcRenderer.removeListener("window-maximize-changed", listener);
    },
    // 监听 Mac 平台下系统关闭按钮的关闭请求
    onCloseRequest: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("window-close-request", listener);
      return () => ipcRenderer.removeListener("window-close-request", listener);
    },
    // 确认关闭窗口（Mac 平台使用）
    confirmClose: () => {
      ipcRenderer.send("window-close-confirmed");
    },
  },
  subWindow: (() => {
    // 立即监听 window-init-data，缓存数据，避免 Angular 组件注册监听前数据丢失
    let _cachedInitData = null;
    let _initDataReceived = false;
    let _initDataCallback = null;
    ipcRenderer.on("window-init-data", (_event, data) => {
      _cachedInitData = data;
      _initDataReceived = true;
      if (_initDataCallback) {
        _initDataCallback(data);
      }
    });
    return {
      open: (options) => ipcRenderer.send("window-open", options),
      close: () => ipcRenderer.send("window-close"),
      onInitData: (callback) => {
        _initDataCallback = callback;
        // 如果数据已到达，立即回调
        if (_initDataReceived) {
          callback(_cachedInitData);
        }
        return () => { _initDataCallback = null; };
      },
    };
  })(),
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
    readFileAsBase64: (path) => {
      const buffer = require("fs").readFileSync(path);
      return buffer.toString('base64');
    },
    readDirSync: (path) => require("fs").readdirSync(path, { withFileTypes: true }),
    readdirSync: (path) => require("fs").readdirSync(path),
    writeFileSync: (path, data) => require("fs").writeFileSync(path, data),
    writeBase64File: (path, base64Data) => {
      const buffer = Buffer.from(base64Data, 'base64');
      require("fs").writeFileSync(path, buffer);
    },
    mkdirSync: (path) => require("fs").mkdirSync(path, { recursive: true }),
    copySync: (src, dest) => require("fs-extra").copySync(src, dest),
    existsSync: (path) => require("fs").existsSync(path),
    statSync: (path) => require("fs").statSync(path),
    isDirectory: (path) => require("fs").statSync(path).isDirectory(),
    unlinkSync: (path, cb) => require("fs").unlinkSync(path, cb),
    rmdirSync: (path) => require("fs").rmdirSync(path, { recursive: true, force: true }),
    rmSync: (path, options) => require("fs").rmSync(path, options),
    renameSync: (oldPath, newPath) => require("fs").renameSync(oldPath, newPath),
    linkSync: (existingPath, newPath) => require("fs").linkSync(existingPath, newPath),
    chmodSync: (path, mode) => require("fs").chmodSync(path, mode),
    appendFileSync: (path, data) => require("fs").appendFileSync(path, data),
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
    get: (key) => ipcRenderer.invoke("env-get", key),
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
    },
    // 后台静默执行命令（用于不需要用户感知的后台任务）
    execBackground: (command, options = {}) => {
      const execOptions = {
        windowsHide: true,
        ...options
      };
      const childProcess = exec(command, execOptions);
      
      const processInfo = {
        pid: childProcess.pid,
        kill: () => {
          try {
            if (childProcess && !childProcess.killed) {
              // 在Windows上需要强制终止整个进程树
              if (process.platform === 'win32') {
                exec(`taskkill /pid ${childProcess.pid} /T /F`, (err) => {
                  if (err) console.warn('终止进程失败:', err.message);
                });
              } else {
                childProcess.kill('SIGTERM');
              }
              return true;
            }
            return false;
          } catch (err) {
            console.warn('终止后台进程失败:', err);
            return false;
          }
        }
      };
      
      // Promise用于等待完成
      const promise = new Promise((resolve, reject) => {
        childProcess.on('exit', (code, signal) => {
          if (code === 0 || signal === 'SIGTERM') {
            resolve({ stdout: '', stderr: '' });
          } else if (signal) {
            reject({ error: `Process terminated with signal ${signal}`, stderr: '' });
          } else {
            reject({ error: `Process exited with code ${code}`, stderr: '' });
          }
        });
        
        childProcess.on('error', (error) => {
          reject({ error: error.message, stderr: '' });
        });
      });
      
      return { processInfo, promise };
    },
    // 通过PID终止后台进程
    killBackgroundProcess: (pid) => {
      return new Promise((resolve, reject) => {
        try {
          if (process.platform === 'win32') {
            exec(`taskkill /pid ${pid} /T /F`, (error) => {
              if (error) {
                reject({ error: error.message });
              } else {
                resolve({ success: true });
              }
            });
          } else {
            try {
              process.kill(pid, 'SIGTERM');
              resolve({ success: true });
            } catch (err) {
              reject({ error: err.message });
            }
          }
        } catch (err) {
          reject({ error: err.message });
        }
      });
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
  // 示例列表协议 API
  exampleList: {
    onOpen: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('open-example-list', listener);
      // 返回解除监听函数
      return () => {
        ipcRenderer.removeListener('open-example-list', listener);
      };
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
    },
    // Glob 工具 - 直接使用 glob API，不需要 IPC
    globTool: (params) => {
      return new Promise((resolve, reject) => {
        try {
          const { pattern, path: searchPath, limit = 100 } = params;
          const glob = require("glob");

          const options = {
            absolute: true,
            nodir: true,
            ignore: [
              '**/node_modules/**',
              '**/.git/**',
              '**/dist/**',
              '**/build/**',
              '**/.angular/**'
            ]
          };

          if (searchPath) {
            options.cwd = searchPath;
          }

          const startTime = Date.now();
          const files = glob.sync(pattern, options);
          const durationMs = Date.now() - startTime;

          const truncated = files.length > limit;
          const limitedFiles = files.slice(0, limit);

          resolve({
            is_error: false,
            content: limitedFiles.join('\n'),
            metadata: {
              pattern,
              path: searchPath,
              numFiles: limitedFiles.length,
              totalFiles: files.length,
              durationMs,
              truncated
            }
          });
        } catch (error) {
          reject({
            is_error: true,
            content: `Glob 搜索失败: ${error.message}`,
            metadata: {
              pattern: params.pattern,
              path: params.path,
              error: error.message
            }
          });
        }
      });
    }
  },
  // Ripgrep 搜索 API
  ripgrep: {
    /**
     * 检查 ripgrep 是否可用
     */
    isRipgrepAvailable: () => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("ripgrep-check-available")
          .then((available) => resolve(available))
          .catch((error) => reject(error));
      });
    },
    /**
     * 使用 ripgrep 搜索文件内容
     */
    searchFiles: (params) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("ripgrep-search-files", params)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
    /**
     * 列出所有内容文件
     */
    listAllContentFiles: (searchPath, limit) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("ripgrep-list-files", searchPath, limit)
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
    /**
     * 搜索文件内容并返回匹配的行
     */
    searchContent: (params) => {
      return new Promise((resolve, reject) => {
        ipcRenderer
          .invoke("ripgrep-search-content", params)
          .then((result) => resolve(result))
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
  },
  base64: {
    atob: (b64String) => Buffer.from(b64String, 'base64').toString('binary'),
  },
  // 日志 API - 将渲染进程的日志发送到主进程记录
  log: {
    error: (message, error) => {
      ipcRenderer.invoke('log-error', message, error ? {
        message: error.message || String(error),
        stack: error.stack
      } : null);
    },
    warn: (message) => {
      ipcRenderer.invoke('log-warn', message);
    },
    info: (message) => {
      ipcRenderer.invoke('log-info', message);
    }
  }
});
