// 这个文件用于和cli交互，进行编译和烧录等操作
const { ipcMain } = require("electron");
const pty = require("@lydell/node-pty");
const { isWin32 } = require("./platform");

// 匹配 PowerShell 提示符: PS D:\path>   以后需要匹配mac os和linux的提示符（陈吕洲 2025.3.4）
const promptRegexMap = {
  "win32": /PS [A-Z]:(\\[^\\]+)+>/g,
  "darwin": /(\x1B\[[0-9;]*[A-Za-z])*[^#%>]*[#%>]\s*$/,
  "linux": /(\x1B\[[0-9;]*[A-Za-z])*[^#%>]*[#%>]\s*$/
}

const shellMap = {
  "win32": "powershell.exe",
  "darwin": "zsh",
  "linux": "bash",
}

const promptRegex = promptRegexMap[process.platform]
const terminals = new Map();

function registerTerminalHandlers(mainWindow) {
  // 获取当前平台的shell
  ipcMain.handle("terminal-get-shell", (event) => {
    return shellMap[process.platform];
  });

  ipcMain.handle("terminal-create", (event, args) => {
    console.log("terminal-create args ", args);
    return new Promise((resolve, reject) => {
      const shell = shellMap[process.platform];

      // 确定工作目录
      let cwd = args.cwd;
      if (!cwd) {
        // Windows使用USERPROFILE，其他平台使用HOME
        cwd = isWin32
          ? process.env.USERPROFILE
          : process.env.HOME;
      }

      // 检查cwd是否存在
      const fs = require('fs');
      if (!fs.existsSync(cwd)) {
        console.warn(`指定的工作目录不存在: ${cwd}，将使用系统临时目录`);
        cwd = require('os').tmpdir(); // 使用临时目录作为最后的备选
      }

      console.log(`启动终端，工作目录: ${cwd}`);

      const ptyProcess = pty.spawn(shell, [], {
        name: "xterm-color",
        cols: args.cols || 80,  // 确保有合适的默认值
        rows: args.rows || 24,
        cwd: cwd,
        env: process.env,
      });

      console.log("new terminal pid: ", ptyProcess.pid);
      // 当前win10上有问题，所以先固定一个terminal
      terminals.set("currentPid", ptyProcess);

      // terminals.set(ptyProcess.pid, ptyProcess);
      // 设置一个标志来避免重复解析
      let isResolved = false;
      // 设置超时保护
      const timeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          // console.log("创建终端超时，但仍继续");
          resolve({ pid: ptyProcess.pid });
        }
      }, 5000); // 5秒超时

      // 修改数据处理函数，检测提示符
      ptyProcess.on("data", (data) => {
        mainWindow.webContents.send("terminal-inc-data", data);
        // 检查是否包含命令提示符
        if (!isResolved && promptRegex.test(data)) {
          clearTimeout(timeout);
          isResolved = true;
          // console.log("检测到终端提示符，终端准备就绪");
          // console.log("终端准备就绪, pid ", ptyProcess.pid);
          resolve({ pid: ptyProcess.pid });
        }
      });
    });
  });

  ipcMain.on("terminal-to-pty", (event, { pid, input }) => {
    // const ptyProcess = terminals.get(parseInt(pid, 10));
    const ptyProcess = terminals.get("currentPid");
    if (ptyProcess) {
      ptyProcess.write(input);
    }
  });

  // 终端大小调整处理
  ipcMain.on("terminal-resize", (event, { pid, cols, rows }) => {
    // const ptyProcess = terminals.get(parseInt(pid, 10));
    const ptyProcess = terminals.get("currentPid");
    if (ptyProcess) {
      ptyProcess.resize(cols, rows);
    }
  });

  // 关闭终端
  // ipcMain.on("terminal-close", (event, { pid }) => {
  //   console.log("terminal-close pid ", pid);
  //   const ptyProcess = terminals.get(parseInt(pid, 10));
  //   if (ptyProcess) {
  //     ptyProcess.kill();
  //     terminals.delete(parseInt(pid, 10));
  //   }
  // });

  // 异步输入，可以获取到数据
  ipcMain.handle('terminal-to-pty-async', async (event, { pid, input }) => {
    return new Promise((resolve, reject) => {
      const ptyProcess = terminals.get("currentPid");
      console.log('terminal-to-pty-async pid ', pid, ' input ', input);
      let output = '';
      let dataHandler;
      let timeoutId;

      // 创建超时处理
      timeoutId = setTimeout(() => {
        ptyProcess.removeListener('data', dataHandler);
        reject(new Error('Command execution timed out'));
      }, 60000);

      // 收集输出数据
      dataHandler = (data) => {
        output += data;

        // 可以根据特定标记判断命令是否完成（如提示符出现）
        // 这里使用简单的延迟检测方式，适合大多数命令
        clearTimeout(timeoutId);

        // 判断是否是npm install命令
        if (input.includes('npm install') || input.includes('npm uninstall')) {
          // 判断data是否类似于：added 9 packages in 0.697s
          if ((output.includes('added') || output.includes('updated')) || output.includes('removed') && output.includes('packages')) {
            // 如果检测到提示符，表示命令执行完成
            console.log('npm command completed');
            ptyProcess.removeListener('data', dataHandler);
            resolve(output);
          } else {
            timeoutId = setTimeout(() => {
              ptyProcess.removeListener('data', dataHandler);
              console.log('npm install command timed out');
              resolve(output);
            }, 2000); // 等待1秒无数据后认为命令执行完毕
          }
        } else {
          timeoutId = setTimeout(() => {
            ptyProcess.removeListener('data', dataHandler);
            resolve(output);
          }, 1000); // 等待500ms无数据后认为命令执行完毕
        }

        // timeoutId = setTimeout(() => {
        //   ptyProcess.removeListener('data', dataHandler);
        //   resolve(output);
        // }, 500); // 等待500ms无数据后认为命令执行完毕
      };

      ptyProcess.on('data', dataHandler);
      // 发送命令
      ptyProcess.write(input);
    })
  });

  // 存储流式输出回调
  const streamCallbacks = new Map();

  // 添加流式输出处理函数
  ipcMain.handle("terminal-stream-start", (event, { pid, streamId }) => {
    // const ptyProcess = terminals.get(parseInt(pid, 10));
    const ptyProcess = terminals.get("currentPid");
    if (!ptyProcess) {
      return { success: false, error: 'Terminal not found' };
    }

    // 为每个流管理其未完成的行数据
    const streamState = {
      buffer: '',  // 用于存储未完成的行
      streamId
    };

    // 创建处理函数
    const streamHandler = (data) => {
      // 累积接收的数据
      let buffer = streamState.buffer + data;
      let lines = [];
      let lastNewlineIndex = 0;

      // 查找所有完整的行
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === '\n' || buffer[i] === '\r') {
          lines.push(buffer.substring(lastNewlineIndex, i + 1));
          lastNewlineIndex = i + 1;
        }
      }

      // 保存剩余的未完成行
      streamState.buffer = lastNewlineIndex < buffer.length ? buffer.substring(lastNewlineIndex) : '';

      // 发送完整的行到渲染进程
      if (lines.length > 0) {
        mainWindow.webContents.send(`terminal-stream-data-${streamId}`, {
          lines,
          complete: false
        });
      }
    };

    // 将处理函数存储起来以便后续移除
    if (!streamCallbacks.has(pid)) {
      streamCallbacks.set(pid, new Map());
    }
    streamCallbacks.get(pid).set(streamId, {
      handler: streamHandler,
      state: streamState
    });

    // 添加数据监听器
    ptyProcess.on('data', streamHandler);

    return { success: true, streamId };
  })

  // 停止流式输出
  ipcMain.handle('terminal-stream-stop', (event, { pid, streamId }) => {
    // const ptyProcess = terminals.get(parseInt(pid, 10));
    const ptyProcess = terminals.get("currentPid");
    if (!ptyProcess) {
      return { success: false, error: 'Terminal not found' };
    }

    // 获取流处理函数
    if (streamCallbacks.has(pid) && streamCallbacks.get(pid).has(streamId)) {
      const { handler, state } = streamCallbacks.get(pid).get(streamId);

      // 移除监听器
      ptyProcess.removeListener('data', handler);
      streamCallbacks.get(pid).delete(streamId);

      // 发送任何剩余的不完整数据
      if (state.buffer.length > 0) {
        mainWindow.webContents.send(`terminal-stream-data-${streamId}`, {
          lines: [state.buffer],
          complete: true  // 标记为最后一批数据
        });
      } else {
        // 发送完成信号
        mainWindow.webContents.send(`terminal-stream-data-${streamId}`, {
          lines: [],
          complete: true
        });
      }

      return { success: true };
    }

    return { success: false, error: 'Stream not found' };
  });

  // 执行命令并流式输出结果
  ipcMain.handle('terminal-to-pty-stream', async (event, { pid, input, streamId }) => {
    // const ptyProcess = terminals.get(parseInt(pid, 10));
    const ptyProcess = terminals.get("currentPid");
    if (!ptyProcess) {
      return { success: false, error: 'Terminal not found' };
    }

    // 生成唯一流ID（如果未提供）
    const actualStreamId = streamId || `stream_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    // 先启动流监听
    await ipcMain.handle('terminal-stream-start', event, { pid, streamId: actualStreamId });

    // 发送命令
    ptyProcess.write(input);

    return {
      success: true,
      streamId: actualStreamId,
      message: '命令已发送，开始流式输出'
    };
  });

  // 修改关闭终端处理，确保清理流回调
  // const originalCloseHandler = ipcMain.listeners('terminal-close')[0];
  // ipcMain.removeListener('terminal-close', originalCloseHandler);

  ipcMain.on("terminal-close", (event, { pid }) => {
    console.log("terminal-close pid ", pid);
    // const ptyProcess = terminals.get(parseInt(pid, 10));
    const ptyProcess = terminals.get("currentPid");
    if (ptyProcess) {
      // 清理流回调
      if (streamCallbacks.has(pid)) {
        streamCallbacks.delete(pid);
      }

      ptyProcess.kill();
      terminals.delete(parseInt(pid, 10));
    }
  });

  // 在 terminal.js 的 registerTerminalHandlers 函数中添加
  ipcMain.handle("terminal-interrupt", (event, { pid }) => {
    // const ptyProcess = terminals.get(parseInt(pid, 10));
    const ptyProcess = terminals.get("currentPid");
    if (!ptyProcess) {
      return { success: false, error: 'Terminal not found' };
    }

    try {
      // 发送 Ctrl+C 信号中断当前进程
      if (process.platform === 'win32') {
        // Windows 上发送 Ctrl+C
        ptyProcess.write('\x03');
      } else {
        // Unix/Linux/macOS 上发送 SIGINT 信号
        ptyProcess.write('\x03');
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || 'Failed to interrupt process' };
    }
  });

  // 添加强制终止方法（当Ctrl+C不起作用时使用）
  ipcMain.handle("terminal-kill-process", async (event, { pid, processName }) => {
    // const ptyProcess = terminals.get(parseInt(pid, 10));
    const ptyProcess = terminals.get("currentPid");
    if (!ptyProcess) {
      return { success: false, error: 'Terminal not found' };
    }

    try {
      if (process.platform === 'win32') {
        // Windows上终止进程
        if (processName) {
          // 先尝试用taskkill终止指定名称的进程
          ptyProcess.write(`taskkill /F /IM ${processName} /T\r`);
        } else {
          // 无名称则发送Ctrl+Break
          ptyProcess.write('\x03\x1A');  // Ctrl+C 然后 Ctrl+Z
        }
      } else {
        // Unix系统
        ptyProcess.write('\x03\x1A');  // Ctrl+C 然后 Ctrl+Z
        // 也可以使用 killall
        if (processName) {
          ptyProcess.write(`pkill -9 ${processName}\r`);
        }
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || '终止进程失败' };
    }
  });

}

module.exports = {
  registerTerminalHandlers,
};
