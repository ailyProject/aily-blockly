// 这个文件用于和cli交互，进行编译和烧录等操作
const { ipcMain } = require("electron");
const pty = require("@lydell/node-pty");

// 匹配 PowerShell 提示符: PS D:\path>   以后需要匹配mac os和linux的提示符（陈吕洲 2025.3.4）
const promptRegex = /PS [A-Z]:(\\[^\\]+)+>/g;
const terminals = new Map();

// 清除ANSI转义序列的函数
function stripAnsiEscapeCodes(text) {
  // 匹配所有ANSI转义序列
  return text.replace(/\x1B\[(?:[0-9]{1,3}(?:;[0-9]{1,3})*)?[m|K|h|l|H|A-Z]/g, '');
}

function registerTerminalHandlers(mainWindow) {
  ipcMain.handle("terminal-create", (event, args) => {
    return new Promise((resolve, reject) => {
      const shell = process.platform === "win32" ? "powershell.exe" : "bash";
      const ptyProcess = pty.spawn(shell, [], {
        name: "xterm-color",
        cols: args.cols || 80,  // 确保有合适的默认值
        rows: args.rows || 24,
        cwd: args.cwd || process.env.HOME,
        env: process.env,
      });

      console.log("new terminal pid: ", ptyProcess.pid);
      terminals.set(ptyProcess.pid, ptyProcess);
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
    const ptyProcess = terminals.get(parseInt(pid, 10));
    if (ptyProcess) {
      ptyProcess.write(input);
    }
  });

  // 终端大小调整处理
  ipcMain.on("terminal-resize", (event, { pid, cols, rows }) => {
    const ptyProcess = terminals.get(parseInt(pid, 10));
    if (ptyProcess) {
      ptyProcess.resize(cols, rows);
    }
  });

  // 关闭终端
  ipcMain.on("terminal-close", (event, { pid }) => {
    console.log("terminal-close pid ", pid);
    const ptyProcess = terminals.get(parseInt(pid, 10));
    if (ptyProcess) {
      ptyProcess.kill();
      terminals.delete(parseInt(pid, 10));
    }
  });

  // 异步输入，可以获取到数据
  ipcMain.handle('terminal-to-pty-async', async (event, { pid, input }) => {
    const ptyProcess = terminals.get(parseInt(pid, 10));
    console.log('terminal-to-pty-async pid ', pid);
    return new Promise((resolve, reject) => {
      try {
        let commandOutput = '';
        let commandTimeout = null;
        // 临时数据处理函数
        const dataHandler = (e) => {
          // 累积所有输出
          commandOutput += e;

          // 检查是否检测到命令提示符，表示命令已完成
          if (promptRegex.test(commandOutput)) {
            clearTimeout(commandTimeout);
            ptyProcess.removeListener('data', dataHandler);
            // 移除命令提示符部分，只保留命令输出
            // 从最后一次出现提示符的位置开始截取
            const lastPromptIndex = commandOutput.search(promptRegex);
            if (lastPromptIndex > 0) {
              commandOutput = commandOutput.substring(0, lastPromptIndex);
            }
            resolve(stripAnsiEscapeCodes(commandOutput.trim()));
          }
        };

        // 添加临时监听器
        ptyProcess.addListener('data', dataHandler);

        // 发送命令
        ptyProcess.write(input);

        // 设置超时保护
        commandTimeout = setTimeout(() => {
          ptyProcess.removeListener('data', dataHandler);
          resolve(stripAnsiEscapeCodes(commandOutput));
        }, 120000); // 默认120秒超时
      } catch (error) {
        reject(error.message || '执行命令失败');
      }
    });
  });
}

module.exports = {
  registerTerminalHandlers,
};