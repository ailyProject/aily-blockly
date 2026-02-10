const { spawn, exec } = require('child_process');
const { ipcMain } = require('electron');
const { isWin32, isDarwin, isLinux } = require('./platform');

class CommandManager {
  constructor() {
    this.processes = new Map(); // 存储进程
    this.streams = new Map(); // 存储流监听器
  }

  // 执行命令并返回流式数据
  executeCommand(options) {
    let { command, args = [], cwd, env, streamId } = options;
    
    // 根据平台选择正确的 shell
    let shell;
    if (isWin32) {
      shell = 'powershell';
    } else if (isDarwin) {
      shell = '/bin/zsh';
    } else if (isLinux) {
      shell = '/bin/bash';
    } else {
      shell = true; // 使用系统默认 shell
    }

    // 【核心修复】Windows 环境下的特殊处理
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
        shell = true;
      }
    }

    // 【调试增强】为 npm install 命令自动添加 --loglevel verbose 参数
    const isNpmCmd = command === 'npm' || command === 'npm.cmd';
    const isInstallCmd = args.includes('install') || args.includes('i');
    if (isNpmCmd && isInstallCmd) {
      // 检查是否已经有 loglevel 或 verbose 相关参数
      const hasLogLevel = args.some(arg => 
        arg.includes('--loglevel') || arg === '--verbose' || arg === '-d' || arg === '--silent' || arg === '-s'
      );
      
      if (!hasLogLevel) {
        // 添加 --loglevel verbose 以获取详细日志
        args = [...args, '--loglevel', 'verbose'];
      }
    }

    // 打印执行命令的日志
    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    console.log(`[CMD] 执行命令: ${fullCommand}`);
    console.log(`[CMD] 工作目录: ${cwd || process.cwd()}`);
    console.log(`[CMD] Shell: ${shell}`);
    
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      shell: shell,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.processes.set(streamId, child);

    // console.log("====child:" , child,{
    //   pid: child.pid,
    //   process: child
    // });

    return {
      pid: child.pid,
      process: child
    };
  }

  // 终止进程
  killProcess(streamId) {
    const process = this.processes.get(streamId);
    if (process) {
      process.kill('SIGTERM');
      this.processes.delete(streamId);
      this.streams.delete(streamId);
      return true;
    }
    return false;
  }

  // 获取进程
  getProcess(streamId) {
    return this.processes.get(streamId);
  }

    /**
   * 杀掉所有指定名称的进程
   * @param {string} processName - 要杀掉的进程名称，例如 'node.exe'
   */
  killProcessByName(processName) {
    // taskkill /IM [进程名称] /F
    // /IM 表示通过图像名（进程名）终止
    // /F 表示强制终止进程
    const command = `taskkill /IM ${processName} /F`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`执行 taskkill 失败: ${error.message}`);
        // 检查 stderr 以确定是否是“未找到进程”的错误
        if (stderr.includes(`No tasks are running which match the specified criteria`)) {
          console.log(`没有找到名称为 ${processName} 的进程.`);
        } else {
          console.error(`终止进程 ${processName} 时发生错误: ${stderr}`);
        }
        return;
      }

      console.log(`所有名称为 ${processName} 的进程已成功终止: ${stdout}`);
    });
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
        console.log(`[CMD][${streamId}] stdout: ${output}`);
        senderWindow.send(`cmd-data-${streamId}`, {
          type: 'stdout',
          data: output,
          streamId
        });
      });

      // 监听错误输出
      process.stderr.on('data', (data) => {
        const output = data.toString();
        console.error(`[CMD][${streamId}] stderr: ${output}`);
        senderWindow.send(`cmd-data-${streamId}`, {
          type: 'stderr',
          data: output,
          streamId
        });
      });

      // 监听进程关闭
      process.on('close', (code, signal) => {
        console.log(`[CMD][${streamId}] 进程关闭, code: ${code}, signal: ${signal}`);
        senderWindow.send(`cmd-data-${streamId}`, {
          type: 'close',
          code,
          signal,
          streamId
        });
        commandManager.processes.delete(streamId);
      });

      // 监听进程错误
      process.on('error', (error) => {
        console.error(`[CMD][${streamId}] 进程错误: ${error.message}`);
        senderWindow.send(`cmd-data-${streamId}`, {
          type: 'error',
          error: error.message,
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
      return {
        success: false,
        error: error.message,
        streamId
      };
    }
  });

  // 终止命令
  ipcMain.handle('cmd-kill', async (event, { streamId }) => {
    const success = commandManager.killProcess(streamId);
    return { success, streamId };
  });

  // 终止指定名称的进程
  ipcMain.handle('cmd-kill-by-name', async (event, { processName }) => {
    commandManager.killProcessByName(processName);
    return { success: true };
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

module.exports = { registerCmdHandlers };