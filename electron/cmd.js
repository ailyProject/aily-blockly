// 管理系统命令进程，并提供 Shell、路径和终端环境检测能力。
const { spawn, exec } = require('child_process');
const { ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWin32, isDarwin, isLinux } = require('./platform');
const { killRegisteredProcessTree } = require('./process-tree');
const {
  normalizeProcessMessage,
  normalizeProcessMessagePortConfig,
} = require('./child-process-message-port');

function summarizeArgs(args = []) {
  return args.join(' ').slice(0, 1000);
}

function uniqueNonEmpty(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeWindowsPathValue(value) {
  if (!isWin32 || !value || typeof value !== 'string') {
    return value;
  }

  let normalized = value.trim().replace(/\//g, '\\');
  normalized = normalized.replace(/^([a-zA-Z]):(?!\\)/, '$1:\\');
  return normalized;
}

function getProcessPathValue() {
  return process.env.PATH || process.env.Path || '';
}

function getWindowsRootsFromPath() {
  if (!isWin32) {
    return [];
  }

  const roots = [];
  for (const entry of getProcessPathValue().split(path.delimiter)) {
    const normalized = normalizeWindowsPathValue(entry);
    const match = normalized.match(/^([a-zA-Z]:\\Windows)(?:\\System32(?:\\WindowsPowerShell\\v1\.0)?|\\Sysnative)?$/i);
    if (match) {
      roots.push(match[1]);
    }
  }
  return roots;
}

function fileExists(filePath) {
  try {
    return !!filePath && fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function windowsShellDiagnostics(candidates) {
  return {
    env: {
      SystemRoot: process.env.SystemRoot || '',
      windir: process.env.windir || '',
      ComSpec: process.env.ComSpec || '',
      ProgramFiles: process.env.ProgramFiles || '',
      ProgramFilesX86: process.env['ProgramFiles(x86)'] || ''
    },
    candidates: candidates.map(candidate => ({
      kind: candidate.kind,
      source: candidate.source,
      path: candidate.path,
      exists: candidate.exists
    }))
  };
}

function getWindowsShellCandidates() {
  if (!isWin32) {
    return [];
  }

  const windowsRoots = uniqueNonEmpty([
    normalizeWindowsPathValue(process.env.SystemRoot),
    normalizeWindowsPathValue(process.env.windir),
    ...getWindowsRootsFromPath(),
    'C:\\Windows'
  ]);
  const programFilesRoots = uniqueNonEmpty([
    normalizeWindowsPathValue(process.env.ProgramFiles),
    normalizeWindowsPathValue(process.env['ProgramFiles(x86)']),
    'C:\\Program Files'
  ]);

  const candidates = [];

  for (const root of windowsRoots) {
    candidates.push({
      kind: 'powershell',
      source: `${root}\\System32`,
      path: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    });
    candidates.push({
      kind: 'powershell',
      source: `${root}\\Sysnative`,
      path: path.join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    });
  }

  for (const root of programFilesRoots) {
    candidates.push({
      kind: 'powershell',
      source: `${root}\\PowerShell\\7`,
      path: path.join(root, 'PowerShell', '7', 'pwsh.exe')
    });
  }

  candidates.push({
    kind: 'cmd',
    source: 'ComSpec',
    path: normalizeWindowsPathValue(process.env.ComSpec)
  });

  for (const root of windowsRoots) {
    candidates.push({
      kind: 'cmd',
      source: `${root}\\System32`,
      path: path.join(root, 'System32', 'cmd.exe')
    });
    candidates.push({
      kind: 'cmd',
      source: `${root}\\Sysnative`,
      path: path.join(root, 'Sysnative', 'cmd.exe')
    });
  }

  const seen = new Set();
  return candidates
    .filter(candidate => candidate.path && typeof candidate.path === 'string')
    .map(candidate => ({
      ...candidate,
      path: candidate.path.trim()
    }))
    .filter(candidate => {
      const key = `${candidate.kind}:${candidate.path.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(candidate => ({
      ...candidate,
      exists: fileExists(candidate.path)
    }));
}

const POWERSHELL_COMMANDS = new Set([
  'copy-item',
  'get-childitem',
  'move-item',
  'new-item',
  'remove-item',
  'test-path'
]);

function getWindowsShellPreference(command) {
  const lowerCommand = String(command || '').replace(/^"|"$/g, '').trim().toLowerCase();
  if (!lowerCommand) {
    return 'powershell';
  }
  if (lowerCommand === 'node' || lowerCommand === 'node.exe') {
    return 'cmd';
  }
  if (lowerCommand.endsWith('.cmd') || lowerCommand.endsWith('.bat')) {
    return 'cmd';
  }
  if (POWERSHELL_COMMANDS.has(lowerCommand)) {
    return 'powershell';
  }
  return 'powershell';
}

function resolveWindowsShell(preference = 'powershell') {
  const candidates = getWindowsShellCandidates();
  const preferredKinds = preference === 'cmd'
    ? ['cmd', 'powershell']
    : ['powershell', 'cmd'];
  const shell = candidates.find(candidate => preferredKinds.includes(candidate.kind) && candidate.exists);

  if (!shell) {
    const diagnostics = windowsShellDiagnostics(candidates);
    const error = new Error(
      `无法启动 Windows shell：未找到可用的 PowerShell 或 cmd.exe。` +
      `请检查 SystemRoot/windir/ComSpec 环境变量或系统文件是否完整。`
    );
    error.shellDiagnostics = diagnostics;
    throw error;
  }

  return {
    shell: shell.path,
    kind: shell.kind,
    diagnostics: windowsShellDiagnostics(candidates)
  };
}

function formatSpawnError(error, entry) {
  const baseMessage = error?.message || String(error);
  const shellDiagnostics = entry?.shellDiagnostics || error?.shellDiagnostics;
  if (!isWin32 || !shellDiagnostics) {
    return baseMessage;
  }

  const diagnostics = shellDiagnostics;
  const candidateLines = diagnostics.candidates
    .map(candidate => `${candidate.exists ? 'OK' : 'MISS'} ${candidate.kind} ${candidate.path} (${candidate.source})`)
    .join('\n');
  const envLines = [
    `SystemRoot=${diagnostics.env.SystemRoot}`,
    `windir=${diagnostics.env.windir}`,
    `ComSpec=${diagnostics.env.ComSpec}`,
    `ProgramFiles=${diagnostics.env.ProgramFiles}`,
    `ProgramFiles(x86)=${diagnostics.env.ProgramFilesX86}`
  ].join('\n');

  return `${baseMessage}\nWindows shell 诊断:\n${envLines}\n${candidateLines}`;
}

function buildCommandEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (isWin32) {
    const systemRoot = normalizeWindowsPathValue(env.SystemRoot || env.windir || 'C:\\Windows');
    env.SystemRoot = systemRoot;
    env.windir = env.windir || systemRoot;
    env.ComSpec = normalizeWindowsPathValue(env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe'));
    env.PATH = env.PATH || env.Path || getProcessPathValue();
  }
  if (isDarwin) {
    const zdotdir = path.join(os.tmpdir(), 'aily-blockly-zsh');
    try {
      fs.mkdirSync(zdotdir, { recursive: true });
    } catch (_) {}
    env.ZDOTDIR = zdotdir;
  }
  return env;
}

function sendRendererLog(targetWebContents, detail, state = 'doing', mergeKey) {
  if (!targetWebContents || targetWebContents.isDestroyed()) {
    return;
  }

  const log = {
    detail,
    state
  };

  if (mergeKey) {
    log.mergeKey = mergeKey;
  }

  targetWebContents.send('window-receive', {
    data: {
      action: 'log',
      log
    }
  });
}

function sendCmdData(targetWebContents, channel, payload) {
  if (!targetWebContents || targetWebContents.isDestroyed()) {
    return;
  }

  targetWebContents.send(channel, payload);
}

function isNoisyNpmLogLine(line) {
  return /^(npm http|npm verbose|npm info ok\b)/i.test(line)
    || /^npm error\b/i.test(line)
    || /^>\s+@?[^\s@]+(?:\/[^\s@]+)?@[^\s]+\s+postinstall\b/i.test(line)
    || /^>\s+node\s+\.\/postinstall\.js\b/i.test(line)
    || /^(added|changed|removed|updated|audited)\s+\d+\s+packages?\s+in\s+/i.test(line)
    || /^up to date\s+in\s+/i.test(line);
}

function getProgressMergeKey(sourceId, line) {
  if (/^下载进度[:：]/i.test(line) || /^下载完成[:：]/i.test(line)) {
    return `${sourceId}:download-progress`;
  }

  if (/^解压进度[:：]/i.test(line)) {
    return `${sourceId}:extract-progress`;
  }

  return undefined;
}

function logCommandOutput(streamId, type, output, targetWebContents) {
  const lines = output.split(/\r\n|\n|\r/g).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (isNoisyNpmLogLine(line)) {
      continue;
    }

    const message = line.length > 2000 ? `${line.slice(0, 2000)}...` : line;
    const mergeKey = getProgressMergeKey(streamId, message);
    if (type === 'stderr') {
      if (!mergeKey) {
        console.error(`[CMD][${streamId}] stderr: ${message}`);
      }
      sendRendererLog(targetWebContents, message, 'error', mergeKey);
    } else {
      if (!mergeKey) {
        console.log(`[CMD][${streamId}] stdout: ${message}`);
      }
      sendRendererLog(targetWebContents, message, 'doing', mergeKey);
    }
  }
}

class CommandManager {
  constructor() {
    this.processes = new Map(); // 存储进程
    this.streams = new Map(); // 存储流监听器
    this.processMessageListeners = new Set();
  }

  // 执行命令并返回流式数据
  executeCommand(options) {
    let {
      command,
      args = [],
      cwd,
      env,
      streamId,
      shellProfile = true,
      messagePort: rawMessagePort,
    } = options;
    const messagePort = normalizeProcessMessagePortConfig(rawMessagePort);
    
    // 根据平台选择正确的 shell
    let shell;
    let shellKind = 'default';
    let shellDiagnostics;
    if (isWin32) {
      const resolvedShell = resolveWindowsShell(getWindowsShellPreference(command));
      shell = resolvedShell.shell;
      shellKind = resolvedShell.kind;
      shellDiagnostics = resolvedShell.diagnostics;
    } else if (isDarwin) {
      shell = '/bin/zsh';
      shellKind = 'zsh';
    } else if (isLinux) {
      shell = '/bin/bash';
      shellKind = 'bash';
    } else {
      shell = true; // 使用系统默认 shell
    }

    // Windows：npm/npx 用 shell:true + 命令名（非 npm.cmd），与 electron/npm.js 一致
    if (isWin32) {
      // 1. 如果是 npm/npx 命令，强制加上 .cmd 后缀
      // 只有这样，spawn 才能准确找到可执行文件，不再依赖 Shell 的智能猜测
      if (command === 'npm') {
        command = 'npm.cmd';
      } else if (command === 'npx') {
        command = 'npx.cmd';
      }

      // 2. 对于 .cmd 命令，使用 CMD (shell: true) 而非 PowerShell
      // 因为 .cmd 本质是批处理，用 cmd.exe 运行是最原生、最稳的
      // 同时也避开了 PowerShell 执行策略 (ExecutionPolicy) 的干扰
      if (command.endsWith('.cmd') || command.endsWith('.bat')) {
        const resolvedShell = resolveWindowsShell('cmd');
        shell = resolvedShell.shell;
        shellKind = resolvedShell.kind;
        shellDiagnostics = resolvedShell.diagnostics;
      }
    }

    if (shellProfile === false && !command.endsWith('.cmd') && !command.endsWith('.bat')) {
      shell = false;
      shellKind = 'direct';
      shellDiagnostics = undefined;
    }
    if (messagePort) {
      if (command.endsWith('.cmd') || command.endsWith('.bat')) {
        throw new Error('Process message ports require a directly spawned executable.');
      }
      shell = false;
      shellKind = 'direct-node-ipc';
      shellDiagnostics = undefined;
    }

    // 为 npm install 命令自动添加 --foreground-scripts，确保 postinstall 输出可见
    const isNpmCmd = command === 'npm' || command === 'npm.cmd';
    const isInstallCmd = args.includes('install') || args.includes('i');
    const shouldLogOutput = isNpmCmd && isInstallCmd;
    if (isNpmCmd && isInstallCmd) {
      const hasForegroundScripts = args.some(arg => arg === '--foreground-scripts' || arg.startsWith('--foreground-scripts='));
      if (!hasForegroundScripts) {
        args = [...args, '--foreground-scripts'];
      }
    }

    // 打印执行命令的日志
    // When using a shell, quote arguments containing spaces to prevent path splitting
    if (shell) {
      args = args.map(arg => {
        if (arg.includes(' ') && !arg.startsWith('"') && !arg.startsWith("'")) {
          return `"${arg}"`;
        }
        return arg;
      });
    }

    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    console.log(`[CMD] 执行命令: ${fullCommand}`);
    console.log(`[CMD] 工作目录: ${cwd || process.cwd()}`);
    console.log(`[CMD] Shell: ${shell}`);

    const isWin32NpmFamily =
      isWin32 && (command === 'npm' || command === 'npx');

    const childStdio = messagePort
      ? ['pipe', 'pipe', 'pipe', 'ipc']
      : ['pipe', 'pipe', 'pipe'];
    const child = isWin32NpmFamily
      ? spawn(fullCommand, {
          cwd: cwd || process.cwd(),
          env: buildCommandEnv(env),
          shell: true,
          windowsHide: true,
          stdio: childStdio,
        })
      : spawn(command, args, {
          cwd: cwd || process.cwd(),
          env: buildCommandEnv(env),
          shell: shell,
          windowsHide: true,
          stdio: childStdio,
        });

    const startedAt = Date.now();
    this.processes.set(streamId, {
      process: child,
      command,
      args,
      cwd: cwd || process.cwd(),
      shell,
      shellKind,
      shellDiagnostics,
      messagePort,
      startedAt
    });
    if (messagePort) {
      child.on('message', (message) => {
        try {
          const normalized = normalizeProcessMessage(
            message,
            messagePort.maxMessageBytes,
          );
          this.notifyProcessMessage({
            streamId,
            message: normalized.message,
            sizeBytes: normalized.sizeBytes,
          });
        } catch (error) {
          console.warn('[PROC_TRACE][CMD_MESSAGE_REJECTED]', {
            streamId,
            pid: child.pid,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
    console.info('[PROC_TRACE][CMD_SPAWN]', {
      streamId,
      pid: child.pid,
      command,
      args: summarizeArgs(args),
      cwd: cwd || process.cwd(),
      shell: String(shell),
      shellKind
    });

    // console.log("====child:" , child,{
    //   pid: child.pid,
    //   process: child
    // });

    return {
      pid: child.pid,
      process: child,
      shouldLogOutput
    };
  }

  // 终止进程
  async killProcess(streamId) {
    const entry = this.processes.get(streamId);
    if (entry?.process) {
      console.info('[PROC_TRACE][CMD_KILL]', {
        streamId,
        pid: entry.process.pid,
        command: entry.command
      });
      await killRegisteredProcessTree(entry.process.pid, `cmd:${streamId}`);
      this.processes.delete(streamId);
      this.streams.delete(streamId);
      return true;
    }
    return false;
  }

  // 获取进程
  getProcess(streamId) {
    return this.processes.get(streamId)?.process;
  }

  getActiveProcessSummaries() {
    return Array.from(this.processes.entries()).map(([streamId, entry]) => ({
      streamId,
      pid: entry.process?.pid,
      command: entry.command,
      cwd: entry.cwd,
      durationMs: Date.now() - entry.startedAt,
      messagePort: !!entry.messagePort
    }));
  }

  getProcessMessagePortInfo(streamId) {
    const messagePort = this.processes.get(streamId)?.messagePort;
    return messagePort ? { ...messagePort } : null;
  }

  async sendProcessMessage(streamId, message) {
    const entry = this.processes.get(streamId);
    const child = entry?.process;
    if (!entry?.messagePort || !child || !child.connected || typeof child.send !== 'function') {
      return {
        success: false,
        reason: 'message-port-unavailable',
        streamId,
      };
    }
    let normalized;
    try {
      normalized = normalizeProcessMessage(
        message,
        entry.messagePort.maxMessageBytes,
      );
    } catch (error) {
      return {
        success: false,
        reason: 'invalid-message',
        error: error instanceof Error ? error.message : String(error),
        streamId,
      };
    }
    return await new Promise((resolve) => {
      child.send(normalized.message, (error) => {
        if (error) {
          resolve({
            success: false,
            reason: 'message-send-failed',
            error: error.message,
            streamId,
          });
          return;
        }
        resolve({
          success: true,
          streamId,
          sizeBytes: normalized.sizeBytes,
        });
      });
    });
  }

  onProcessMessage(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Process message listener must be a function.');
    }
    this.processMessageListeners.add(listener);
    return () => this.processMessageListeners.delete(listener);
  }

  notifyProcessMessage(event) {
    for (const listener of this.processMessageListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[PROC_TRACE][CMD_MESSAGE_LISTENER_ERROR]', {
          streamId: event.streamId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async killAllProcesses() {
    const entries = Array.from(this.processes.entries());
    console.info('[PROC_TRACE][CMD_KILL_ALL]', { count: entries.length, processes: this.getActiveProcessSummaries() });
    await Promise.all(entries.map(async ([streamId, entry]) => {
      await killRegisteredProcessTree(entry.process?.pid, `cmd:${streamId}`);
      this.processes.delete(streamId);
      this.streams.delete(streamId);
    }));
  }

    /**
   * 杀掉所有指定名称的进程
   * @param {string} processName - 要杀掉的进程名称，例如 'node.exe'
   */
  killProcessByName(processName) {
    console.warn('[PROC_TRACE][CMD_KILL_BY_NAME_BLOCKED]', { processName });
    return false;
  }
}

const commandManager = new CommandManager();

function registerCmdHandlers(mainWindow) {
  // 执行命令
  ipcMain.handle('cmd-run', async (event, options) => {
    const streamId = options.streamId || `cmd_${Date.now()}_${Math.random()}`;
    const senderWindow = event.sender; // 获取发送请求的窗口

    try {
      const result = commandManager.executeCommand({ ...options, streamId });
      const process = result.process;
      // console.log(options);
      // 监听标准输出
      process.stdout.on('data', (data) => {
        const output = data.toString();
        if (result.shouldLogOutput) {
          logCommandOutput(streamId, 'stdout', output, senderWindow);
        }
        if (options.forwardStdout !== false) {
          sendCmdData(senderWindow, `cmd-data-${streamId}`, {
            type: 'stdout',
            data: output,
            streamId
          });
        }
      });

      // 监听错误输出
      process.stderr.on('data', (data) => {
        const output = data.toString();
        if (result.shouldLogOutput) {
          logCommandOutput(streamId, 'stderr', output, senderWindow);
        }
        sendCmdData(senderWindow, `cmd-data-${streamId}`, {
          type: 'stderr',
          data: output,
          streamId
        });
      });

      // 监听进程关闭
      process.on('close', (code, signal) => {
        const entry = commandManager.processes.get(streamId);
        console.log(`[CMD][${streamId}] close, code: ${code}, signal: ${signal}`);
        console.info('[PROC_TRACE][CMD_CLOSE]', {
          streamId,
          pid: process.pid,
          code,
          signal,
          durationMs: entry ? Date.now() - entry.startedAt : undefined
        });
        sendCmdData(senderWindow, `cmd-data-${streamId}`, {
          type: 'close',
          code,
          signal,
          streamId
        });
        commandManager.processes.delete(streamId);
      });

      // 监听进程错误
      process.on('error', (error) => {
        const entry = commandManager.processes.get(streamId);
        const formattedError = formatSpawnError(error, entry);
        console.error(`[CMD][${streamId}] error: ${formattedError}`);
        console.error('[PROC_TRACE][CMD_ERROR]', {
          streamId,
          pid: process.pid,
          error: formattedError,
          code: error?.code,
          shell: entry?.shell ? String(entry.shell) : undefined,
          shellKind: entry?.shellKind,
          durationMs: entry ? Date.now() - entry.startedAt : undefined
        });
        sendCmdData(senderWindow, `cmd-data-${streamId}`, {
          type: 'error',
          error: formattedError,
          streamId
        });
        commandManager.processes.delete(streamId);
      });

      return {
        success: true,
        streamId,
        pid: result.pid
      };

    } catch (error) {
      const formattedError = formatSpawnError(error);
      console.error('[PROC_TRACE][CMD_START_ERROR]', {
        streamId,
        error: formattedError
      });
      return {
        success: false,
        error: formattedError,
        streamId
      };
    }
  });

  // 终止命令
  ipcMain.handle('cmd-kill', async (event, { streamId }) => {
    const success = await commandManager.killProcess(streamId);
    return { success, streamId };
  });

  // 终止指定名称的进程
  ipcMain.handle('cmd-kill-by-name', async (event, { processName }) => {
    console.warn('[PROC_TRACE][CMD_KILL_BY_NAME_BLOCKED]', { processName });
    return { success: false, error: 'Killing processes by name is disabled. Use a registered streamId instead.' };
  });

  // 向进程发送输入
  ipcMain.handle('cmd-input', async (event, { streamId, input }) => {
    const process = commandManager.getProcess(streamId);
    if (process && process.stdin) {
      process.stdin.write(input);
      return { success: true };
    }
    return { success: false, error: 'Process not found or stdin not available' };
  });
}

module.exports = {
  CommandManager,
  registerCmdHandlers,
  getCmdProcessMessagePortInfo: (streamId) => commandManager.getProcessMessagePortInfo(streamId),
  killCmdProcess: (streamId) => commandManager.killProcess(streamId),
  killAllCmdProcesses: () => commandManager.killAllProcesses(),
  getActiveCmdProcesses: () => commandManager.getActiveProcessSummaries(),
  onCmdProcessMessage: (listener) => commandManager.onProcessMessage(listener),
  sendCmdProcessMessage: (streamId, message) => commandManager.sendProcessMessage(streamId, message),
};
