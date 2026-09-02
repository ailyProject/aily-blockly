// 通过预加载桥接向渲染进程安全暴露 Electron 和原生能力。
const { contextBridge, ipcRenderer, shell, webFrame, clipboard } = require("electron");
const { SerialPort } = require("serialport");
const { createThrottledSerialPort, createRawSerialPort, listPorts } = require("./serial");
const { exec } = require("child_process");
const { createHash, randomUUID } = require("crypto");
const { existsSync, statSync, createReadStream } = require("fs");
const { createInterface } = require("readline");
const { isAbsolute } = require("path");
const { tmpdir } = require("os");
const nodeFsp = require("node:fs/promises");
const { calculateDirectoryStats } = require("./directory-stats");
const { createSafeStorageBridge } = require("./safe-storage-bridge");

// 单双杠虽不影响实用性，为了路径规范好看，还是单独使用
const pt = process.platform === "win32" ? "\\" : "/"
const ailyBuilderEnv = {
  path: process.env.AILY_BUILDER_PATH,
  command: process.env.AILY_BUILDER_COMMAND,
};

function updateAilyBuilderEnv(result) {
  if (result?.path) {
    ailyBuilderEnv.path = result.path;
  }
  if (result?.command) {
    ailyBuilderEnv.command = result.command;
  }
  return result;
}

async function invokeAilyConnector(channel, payload) {
  const envelope = await ipcRenderer.invoke(channel, payload);
  if (!envelope || envelope.ailyConnectorIpc !== 1) {
    throw new Error('Invalid aily-connector IPC response');
  }
  if (!envelope.ok) {
    const error = new Error(envelope.error?.message || 'Aily Connector request failed');
    error.code = envelope.error?.code || 'CONNECTOR_ERROR';
    if (envelope.error?.details) error.details = envelope.error.details;
    throw error;
  }
  return envelope.result;
}

const pathApi = {
  getUserHome: () => require("os").homedir(),
  getAilyChildPath: () => process.env.AILY_CHILD_PATH,
  getAppDataPath: () => process.env.AILY_APPDATA_PATH,
  getAilyBuilderPath: () => process.env.AILY_BUILDER_PATH,
  getUserDocuments: () => require("os").homedir() + `${pt}Documents`,
  isExists: (path) => existsSync(path),
  getElectronPath: () => {
    // 当 preload.js 从 asar 解包后，将路径重定向到 asar 内部以便 fs 操作正常工作
    if (__dirname.includes('app.asar.unpacked')) {
      return __dirname.replace('app.asar.unpacked', 'app.asar');
    }
    return __dirname;
  },
  isDir: (path) => statSync(path).isDirectory(),
  join: (...args) => require("path").join(...args),
  dirname: (path) => require("path").dirname(path),
  extname: (path) => require("path").extname(path),
  normalize: (path) => require("path").normalize(path),
  resolve: (path) => require("path").resolve(path),
  relative: (from, to) => require("path").relative(from, to),
  basename: (path, suffix = undefined) => require("path").basename(path, suffix),
  isAbsolute: (path) => isAbsolute(path),
};

const fspApi = {
  directoryStats: (rootPath) => calculateDirectoryStats(rootPath, { skipRootFiles: true }),
  glob: (...args) => nodeFsp.glob(...args),
  readFile: (...args) => nodeFsp.readFile(...args),
  writeFile: (...args) => nodeFsp.writeFile(...args),
  appendFile: (...args) => nodeFsp.appendFile(...args),
  readdir: (...args) => nodeFsp.readdir(...args),
  stat: (...args) => nodeFsp.stat(...args),
  mkdir: (...args) => nodeFsp.mkdir(...args),
  rm: (...args) => nodeFsp.rm(...args),
  access: (...args) => nodeFsp.access(...args),
  unlink: (...args) => nodeFsp.unlink(...args),
  open: (...args) => nodeFsp.open(...args),
};

async function writeFileBufferAtomic(filePath, data) {
  const directory = require("path").dirname(filePath);
  const baseName = require("path").basename(filePath);
  await nodeFsp.mkdir(directory, { recursive: true });
  const temporaryPath = require("path").join(
    directory,
    `.${baseName}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await nodeFsp.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(Buffer.from(data));
    await handle.sync();
    await handle.close();
    handle = null;
    await nodeFsp.rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await nodeFsp.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readLinesWithMode(filePath, options = {}) {
  const mode = options?.mode === 'head' || options?.mode === 'sed' ? options.mode : 'tail';
  const maxLines = Number.isFinite(options?.maxLines) ? Math.max(1, Math.floor(options.maxLines)) : 20;
  const startLine = Number.isFinite(options?.startLine) ? Math.max(1, Math.floor(options.startLine)) : 1;
  const endLine = Number.isFinite(options?.endLine) ? Math.max(startLine, Math.floor(options.endLine)) : startLine;
  const filterPattern = typeof options?.filterPattern === 'string' && options.filterPattern.trim() ? new RegExp(options.filterPattern) : null;
  const timestampFromMs = Number.isFinite(options?.timestampFromMs) ? Number(options.timestampFromMs) : null;
  const timestampToMs = Number.isFinite(options?.timestampToMs) ? Number(options.timestampToMs) : null;

  return await new Promise((resolve, reject) => {
    const input = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({
      input,
      crlfDelay: Infinity,
    });

    const headLines = [];
    const tailLines = [];
    const sedLines = [];
    let matchedLineNumber = 0;
    let settled = false;

    const finalize = (lines) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(lines);
    };
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      rl.removeAllListeners();
      input.removeAllListeners();
    };
    const stopEarly = (lines) => {
      rl.close();
      input.destroy();
      finalize(lines);
    };

    rl.on('line', (line) => {
      if (filterPattern && !filterPattern.test(line)) {
        return;
      }
      if (!matchesTimestampRange(line, timestampFromMs, timestampToMs)) {
        return;
      }

      matchedLineNumber += 1;
      if (mode === 'head') {
        headLines.push(line);
        if (headLines.length >= maxLines) {
          stopEarly(headLines);
        }
        return;
      }

      if (mode === 'sed') {
        if (matchedLineNumber >= startLine && matchedLineNumber <= endLine) {
          sedLines.push(line);
        }
        if (matchedLineNumber >= endLine) {
          stopEarly(sedLines);
        }
        return;
      }

      tailLines.push(line);
      if (tailLines.length > maxLines) {
        tailLines.shift();
      }
    });

    rl.once('close', () => {
      if (settled) {
        return;
      }
      finalize(mode === 'head' ? headLines : mode === 'sed' ? sedLines : tailLines);
    });
    rl.once('error', fail);
    input.once('error', fail);
  });
}

function matchesTimestampRange(line, timestampFromMs, timestampToMs) {
  if (timestampFromMs === null && timestampToMs === null) {
    return true;
  }

  const timestampMs = extractLeadingTimestampMs(line);
  if (timestampMs === null) {
    return false;
  }
  if (timestampFromMs !== null && timestampMs < timestampFromMs) {
    return false;
  }
  if (timestampToMs !== null && timestampMs > timestampToMs) {
    return false;
  }
  return true;
}

function extractLeadingTimestampMs(line) {
  const match = String(line || '').match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/);
  if (!match) {
    return null;
  }
  const parsed = Date.parse(match[1].replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
}

contextBridge.exposeInMainWorld("electronAPI", {
  ipcRenderer: {
    send: (channel, data) => ipcRenderer.send(channel, data),
    on: (channel, callback) => {
      ipcRenderer.on(channel, callback);
      return () => ipcRenderer.removeListener(channel, callback);
    },
    invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  },
  path: pathApi,
  fsp: fspApi,
  versions: () => process.versions,
  SerialPort: {
    list: async () => await listPorts(),
    create: (options) => createThrottledSerialPort(options),
    createRaw: (options) => createRawSerialPort(options)
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
  /** 在访达 / 资源管理器中高亮真实路径（须为绝对路径） */
  shell: {
    showItemInFolder: (fullPath) => {
      if (typeof fullPath !== "string" || !fullPath) {
        return;
      }
      shell.showItemInFolder(fullPath);
    },
  },
  terminal: {
    init: (data) => ipcRenderer.invoke("terminal-create", data),
    getShell: () => ipcRenderer.invoke("terminal-get-shell"),
    onData: (callback) => {
      ipcRenderer.on("terminal-inc-data", (event, data) => {
        callback(data);
      });
    },
    onPidData: (pid, callback) => {
      const channel = `terminal-inc-data-${pid}`;
      const listener = (event, payload) => {
        callback(payload);
      };
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
    onPidExit: (pid, callback) => {
      const channel = `terminal-exit-${pid}`;
      const listener = (event, payload) => {
        callback(payload);
      };
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
    sendInput: (data) => ipcRenderer.send("terminal-to-pty", data),
    spawnCommand: (data) => ipcRenderer.invoke("terminal-spawn-command", data),
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
  ailyServicesStream: {
    start: (data) => ipcRenderer.invoke("aily-services-stream-start", data),
    cancel: (streamId) => ipcRenderer.invoke("aily-services-stream-cancel", { streamId }),
    onEvent: (streamId, callback) => {
      const channel = `aily-services-stream-event-${streamId}`;
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
  },
  webviewBridge: {
    fetchPage: (data) => ipcRenderer.invoke("webview-bridge-fetch", data),
    searchWeb: (data) => ipcRenderer.invoke("webview-bridge-search", data),
  },
  webviewDebuggerSurface: {
    create: (data) => ipcRenderer.invoke('webview-debugger-surface-create', data),
    setBounds: (data) => ipcRenderer.invoke('webview-debugger-surface-bounds', data),
    command: (data) => ipcRenderer.invoke('webview-debugger-surface-command', data),
    destroy: (data) => ipcRenderer.invoke('webview-debugger-surface-destroy', data),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('webview-debugger-surface-event', listener);
      return () => ipcRenderer.removeListener('webview-debugger-surface-event', listener);
    },
  },
  iWindow: {
    minimize: () => ipcRenderer.send("window-minimize"),
    maximize: () => ipcRenderer.send("window-maximize"),
    isMaximized: () => ipcRenderer.sendSync("window-is-maximized"),
    unmaximize: () => ipcRenderer.send("window-unmaximize"),
    setSize: (data) => ipcRenderer.invoke("window-set-size", data),
    close: () => ipcRenderer.send("window-close"),
    // 子窗口收回到主窗口事件
    goMain: (data) => ipcRenderer.send("window-go-main", data),
    returnMain: (data) => ipcRenderer.invoke("window-return-main", data),
    // 向其他窗口发送消息
    send: (data) => ipcRenderer.invoke("window-send", data),
    onReceive: (callback) => ipcRenderer.on("window-receive", callback),
    // 检查窗口是否为活动窗口
    isFocused: () => ipcRenderer.sendSync("window-is-focused"),
    // 后台时需要用户注意时：闪烁任务栏 / Dock 弹跳等（见 main 进程 window-request-attention）
    requestAttention: () => ipcRenderer.invoke('window-request-attention'),
    // 检查窗口是否最小化
    isMinimized: () => ipcRenderer.sendSync("window-is-minimized"),
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
  projectLock: {
    tryAcquire: (projectPath, options) =>
      ipcRenderer.invoke("project-lock-try", {
        projectPath,
        force: options && options.force,
      }),
    release: (projectPath) => ipcRenderer.invoke("project-lock-release", { projectPath }),
    focusProcess: (pid) => ipcRenderer.invoke("project-lock-focus", { pid }),
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
      focus: (path) => ipcRenderer.invoke("window-focus-by-url", path),
      getState: (path) => ipcRenderer.invoke("window-state-by-url", path),
      list: () => ipcRenderer.invoke("window-list"),
      control: (path, action) => ipcRenderer.invoke("window-control-by-url", { path, action }),
      setBounds: (path, options) => ipcRenderer.invoke("window-set-bounds-by-url", { path, ...options }),
      arrange: (options) => ipcRenderer.invoke("window-arrange", options),
      command: (path, command) => ipcRenderer.invoke("child-app-host-command-by-url", { path, command }),
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
  childAppHost: {
    onCommand: (callback) => {
      const listener = (_event, payload = {}) => {
        callback(payload.command, payload.requestId);
      };
      ipcRenderer.on('child-app-host-command', listener);
      return () => ipcRenderer.removeListener('child-app-host-command', listener);
    },
    respond: (requestId, result) => ipcRenderer.send('child-app-host-command-response', { requestId, result }),
  },
  childToolSession: {
    acquire: (toolId) => ipcRenderer.invoke("child-tool-session-acquire", toolId),
    register: (payload) => ipcRenderer.invoke("child-tool-session-register", payload),
    release: (toolIdOrPayload) => ipcRenderer.invoke("child-tool-session-release", toolIdOrPayload),
    restart: (toolId) => ipcRenderer.invoke("child-tool-session-restart", toolId),
    unregister: (payload) => ipcRenderer.invoke("child-tool-session-unregister", payload),
    list: () => ipcRenderer.invoke("child-tool-session-list"),
    stop: (toolId) => ipcRenderer.invoke("child-tool-session-stop", toolId),
    sendMessage: (payload) => ipcRenderer.invoke("child-tool-session-message-send", payload),
    onMessage: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("child-tool-session-message", listener);
      return () => ipcRenderer.removeListener("child-tool-session-message", listener);
    },
    onStateChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("child-tool-session-state-changed", listener);
      return () => ipcRenderer.removeListener("child-tool-session-state-changed", listener);
    },
  },
  subapps: {
    list: (options = {}) => ipcRenderer.invoke("subapp-manager-list", options),
    install: (options) => ipcRenderer.invoke("subapp-manager-install", options),
    update: (options) => ipcRenderer.invoke("subapp-manager-update", options),
    uninstall: (options) => ipcRenderer.invoke("subapp-manager-uninstall", options),
    onChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("subapp-manager-changed", listener);
      return () => ipcRenderer.removeListener("subapp-manager-changed", listener);
    },
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("subapp-manager-progress", listener);
      return () => ipcRenderer.removeListener("subapp-manager-progress", listener);
    },
  },
  codeViewer: {
    publishState: (state) => ipcRenderer.send("blockly-code-viewer-state-update", state),
    getState: () => ipcRenderer.invoke("blockly-code-viewer-state-get"),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("blockly-code-viewer-state", listener);
      return () => ipcRenderer.removeListener("blockly-code-viewer-state", listener);
    },
  },
  builder: {
    status: () => ipcRenderer.invoke("aily-builder-status"),
    checkForUpdate: () => ipcRenderer.invoke("aily-builder-check-update"),
    update: () => ipcRenderer.invoke("aily-builder-update"),
    waitForReady: () => ipcRenderer.invoke("aily-builder-wait-ready"),
  },
  connector: {
    status: () => ipcRenderer.invoke("aily-connector-status"),
    checkForUpdate: () => ipcRenderer.invoke("aily-connector-check-update"),
    update: () => ipcRenderer.invoke("aily-connector-update"),
    waitForReady: () => ipcRenderer.invoke("aily-connector-wait-ready"),
    connect: (options) => invokeAilyConnector("aily-connector-connect", options),
    request: (options) => invokeAilyConnector("aily-connector-request", options),
    disconnect: (options) => invokeAilyConnector("aily-connector-disconnect", options),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("aily-connector-event", listener);
      return () => ipcRenderer.removeListener("aily-connector-event", listener);
    },
  },
  simulatorGateway: {
    iframeUrlOverride:
      process.env.AILY_E2E === "1"
        ? process.env.AILY_E2E_SIMULATOR_IFRAME_URL || ""
        : "",
    start: (projectPath, ownerId) => ipcRenderer.invoke(
      "simulator-gateway-start",
      projectPath,
      ownerId,
    ),
    status: () => ipcRenderer.invoke("simulator-gateway-status"),
    stop: (expectedProjectPath, expectedOwnerId) => ipcRenderer.invoke(
      "simulator-gateway-stop",
      expectedProjectPath,
      expectedOwnerId,
    ),
    onStateChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("simulator-gateway-state-changed", listener);
      return () => ipcRenderer.removeListener(
        "simulator-gateway-state-changed",
        listener,
      );
    },
  },
  simulatorSubapp: {
    open: (options) => ipcRenderer.invoke("simulator-subapp-open", options),
    openProjectScene: (options) => ipcRenderer.invoke(
      "simulator-subapp-open-project-scene",
      options,
    ),
    requestProjectSceneGeneration: (options) => ipcRenderer.invoke(
      "simulator-subapp-request-project-scene-generation",
      options,
    ),
    resolveProjectSceneRegeneration: (options) => ipcRenderer.invoke(
      "simulator-subapp-resolve-project-scene-regeneration",
      options,
    ),
    applyProjectSceneAgentProposal: (options) => ipcRenderer.invoke(
      "simulator-subapp-apply-project-scene-agent-proposal",
      options,
    ),
    attachProjectSceneSession: (ownerId) => ipcRenderer.invoke(
      "simulator-subapp-attach-project-scene-session",
      { ownerId },
    ),
    detachProjectSceneSession: (ownerId) => ipcRenderer.invoke(
      "simulator-subapp-detach-project-scene-session",
      { ownerId },
    ),
    status: () => ipcRenderer.invoke("simulator-subapp-status"),
    close: (ownerId) => ipcRenderer.invoke(
      "simulator-subapp-close",
      { ownerId },
    ),
    onStateChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("simulator-subapp-state-changed", listener);
      return () => ipcRenderer.removeListener(
        "simulator-subapp-state-changed",
        listener,
      );
    },
  },
  linter: {
    status: () => ipcRenderer.invoke("aily-linter-status"),
    checkForUpdate: () => ipcRenderer.invoke("aily-linter-check-update"),
    update: () => ipcRenderer.invoke("aily-linter-update"),
    waitForReady: () => ipcRenderer.invoke("aily-linter-wait-ready"),
  },
  uploader: {
    upload: (data) => ipcRenderer.invoke("uploader-upload", data),
  },
  fs: {
    readFileSync: (path, encoding = "utf8") => require("fs").readFileSync(path, encoding),
    readFileBufferAsync: async (path) => {
      const buffer = await require("fs").promises.readFile(path);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    readFileBuffer: (path) => {
      const buffer = require("fs").readFileSync(path);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    readFileAsBase64: (path) => {
      const buffer = require("fs").readFileSync(path);
      return buffer.toString('base64');
    },
    readDirSync: (path) => {
      const entries = require("fs").readdirSync(path, { withFileTypes: true });
      return entries.map(e => ({ name: e.name, _isDirectory: e.isDirectory(), _isFile: e.isFile() }));
    },
    readdirSync: (path) => require("fs").readdirSync(path),
    writeFileSync: (path, data) => require("fs").writeFileSync(path, data),
    writeFileBuffer: (path, data) => {
      require("fs").writeFileSync(path, Buffer.from(data));
    },
    writeFileBufferAsync: async (path, data) => {
      await require("fs").promises.writeFile(path, Buffer.from(data));
    },
    writeFileBufferAtomicAsync: async (path, data) => {
      await writeFileBufferAtomic(path, data);
    },
    realpathAsync: (path) => require("fs").promises.realpath(path),
    md5Buffer: (data) => {
      return createHash("md5").update(Buffer.from(data)).digest("hex");
    },
    writeBase64File: (path, base64Data) => {
      const buffer = Buffer.from(base64Data, 'base64');
      require("fs").writeFileSync(path, buffer);
    },
    mkdirSync: (path) => require("fs").mkdirSync(path, { recursive: true }),
    copySync: (src, dest) => require("fs").cpSync(src, dest, { recursive: true }),
    existsSync: (path) => require("fs").existsSync(path),
    statSync: (path) => {
      const s = require("fs").statSync(path);
      return { size: s.size, mtime: s.mtime.toISOString(), birthtime: s.birthtime.toISOString(), _isDirectory: s.isDirectory(), _isFile: s.isFile() };
    },
    lstatSync: (path) => {
      const s = require("fs").lstatSync(path);
      return { size: s.size, mtime: s.mtime.toISOString(), birthtime: s.birthtime.toISOString(), _isDirectory: s.isDirectory(), _isFile: s.isFile(), _isSymbolicLink: s.isSymbolicLink() };
    },
    isDirectory: (path) => require("fs").statSync(path).isDirectory(),
    unlinkSync: (path, cb) => require("fs").unlinkSync(path, cb),
    rmdirSync: (path) => require("fs").rmdirSync(path, { recursive: true, force: true }),
    rmSync: (path, options) => require("fs").rmSync(path, options),
    renameSync: (oldPath, newPath) => require("fs").renameSync(oldPath, newPath),
    rename: (oldPath, newPath) => require("fs").promises.rename(oldPath, newPath),
    linkSync: (existingPath, newPath) => require("fs").linkSync(existingPath, newPath),
    chmodSync: (path, mode) => require("fs").chmodSync(path, mode),
    appendFileSync: (path, data) => require("fs").appendFileSync(path, data),
    readHeadLines: async (path, options = {}) => {
      return await readLinesWithMode(path, { ...options, mode: 'head' });
    },
    readTailLines: async (path, options = {}) => {
      return await readLinesWithMode(path, { ...options, mode: 'tail' });
    },
    readLineRange: async (path, options = {}) => {
      return await readLinesWithMode(path, { ...options, mode: 'sed' });
    },
    watch: (path, callback, options = {}) => {
      const watcher = require("fs").watch(
        path,
        { persistent: false, ...options },
        (eventType, filename) => callback({
          eventType,
          filename: filename ? filename.toString() : '',
        })
      );
      watcher.on('error', (error) => callback({
        eventType: 'error',
        error: error?.message || String(error),
      }));
      return () => watcher.close();
    },
    // ---- 异步方法（通过 IPC 在主进程执行，不阻塞渲染进程） ----
    readFile: (path, encoding) => ipcRenderer.invoke("fs-readFile", path, encoding),
    writeFile: (path, data, encoding) => ipcRenderer.invoke("fs-writeFile", path, data, encoding),
    exists: (path) => ipcRenderer.invoke("fs-exists", path),
    stat: (path) => ipcRenderer.invoke("fs-stat", path),
    lstat: (path) => ipcRenderer.invoke("fs-lstat", path),
    readdir: (path) => ipcRenderer.invoke("fs-readdir", path),
    readDir: (path) => ipcRenderer.invoke("fs-readDir", path),
    mkdir: (path, options) => ipcRenderer.invoke("fs-mkdir", path, options),
    unlink: (path) => ipcRenderer.invoke("fs-unlink", path),
  },
  glob: {
    // 同步版本 - 通过 IPC 在主进程执行
    sync: (pattern, options = {}) => {
      // 降级为异步调用（无法真正同步 IPC），返回 Promise
      return ipcRenderer.invoke("glob-search", pattern, options);
    },
    // 异步版本 - 通过 IPC 在主进程执行
    async: (pattern, options = {}) => {
      return ipcRenderer.invoke("glob-search-async", pattern, options);
    }
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
  safeStorage: createSafeStorageBridge(ipcRenderer),
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
    // Glob 工具 - 通过 IPC 在主进程执行
    globTool: async (params) => {
      try {
        const { pattern, path: searchPath, limit = 100 } = params;

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
        const files = await ipcRenderer.invoke("glob-search-async", pattern, options);
        const durationMs = Date.now() - startTime;

        const truncated = files.length > limit;
        const limitedFiles = files.slice(0, limit);

        return {
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
        };
      } catch (error) {
        return {
          is_error: true,
          content: `Glob 搜索失败: ${error.message}`,
          metadata: {
            pattern: params.pattern,
            path: params.path,
            error: error.message
          }
        };
      }
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
          .invoke('ripgrep-list-files-v2', {
            pattern: '**/*',
            path: searchPath,
            maxResults: limit,
            includeHidden: true
          })
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
          .invoke('ripgrep-search-text-v2', {
            ...params,
            includeHidden: true
          })
          .then((result) => resolve(result))
          .catch((error) => reject(error));
      });
    },
    /**
     * v2 path-only file search backed by `rg --files`.
     */
    listFiles: (params) => ipcRenderer.invoke('ripgrep-list-files-v2', params),
    /**
     * v2 structured content search backed by `rg --json`.
     */
    searchText: (params) => ipcRenderer.invoke('ripgrep-search-text-v2', params),
    /**
     * Cancel an active v2 search by request id.
     */
    cancelSearch: (requestId) => ipcRenderer.send('ripgrep-cancel-search', requestId)
  },
  // BLE API
  ble: {
    onDeviceList: (callback) => {
      const listener = (_event, devices) => {
        console.log('[BLE:preload] device list from main:', Array.isArray(devices) ? devices.length : 'invalid', devices);
        callback(devices);
      };
      ipcRenderer.on('ble-device-list', listener);
      return () => ipcRenderer.removeListener('ble-device-list', listener);
    },
    selectDevice: (deviceId) => ipcRenderer.invoke('ble-select-device', deviceId),
    setPreferredDevice: (deviceId) => ipcRenderer.invoke('ble-set-preferred-device', deviceId),
    cancelDeviceRequest: () => ipcRenderer.invoke('ble-cancel-device-request'),
    startDeviceListUpdates: () => ipcRenderer.invoke('ble-start-device-list-updates'),
    stopDeviceListUpdates: () => ipcRenderer.invoke('ble-stop-device-list-updates'),
    debugState: () => ipcRenderer.invoke('ble-debug-state'),
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
  // probe-rs API - 调试探针检测与固件烧录
  probeRs: {
    /**
     * 列出所有已连接的调试探针
     * @returns {Promise<{success: boolean, count?: number, probes?: Array, error?: string}>}
     */
    list: () => ipcRenderer.invoke("probe-rs-list"),
    /**
     * 烧录固件到目标芯片
     * @param {Object} options
     * @param {string} options.firmwarePath - 固件文件路径 (.hex/.bin/.elf)
     * @param {string} [options.chip] - 目标芯片型号（如 STM32F407VGTx）
     * @param {string} [options.probe] - 指定调试探针 vid:pid[:serial]
     * @param {string} [options.protocol] - 调试协议 "swd" | "jtag"
     * @param {number} [options.speed] - 通信速度 kHz
     * @param {string} [options.format] - 固件格式 "elf" | "hex" | "bin"
     * @param {number} [options.baseAddress] - BIN 文件烧录基地址
     * @param {number} [options.skipBytes] - 跳过固件文件开头的字节数
     * @param {boolean} [options.verify] - 烧录后校验
     * @returns {Promise<{success: boolean, firmware?: string, chip?: string, message?: string, error?: string}>}
     */
    download: (options) => ipcRenderer.invoke("probe-rs-download", options),
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
  },
  // 系统剪贴板 API - 用于跨实例 block 复制粘贴
  clipboard: {
    writeText: (text) => clipboard.writeText(text),
    readText: () => clipboard.readText(),
  }
});
