const { ipcMain } = require("electron");
const CrossAppCommunication = require("./cross-app-communication");

class Sublink {
  constructor() {
    this.crossAppComm = null;
  }

  /**
   * @description 注册跨应用通信IPC处理
   * @returns {Promise<boolean>}
   */
  register() {
    return new Promise(async (resolve, reject) => {
      // 启动跨应用通信服务器（可选，如果需要接收其他应用的连接）
      // 端口设置为 0 表示自动分配端口
      try {
        // 初始化跨应用通信实例
        if (!this.crossAppComm) {
          this.crossAppComm = new CrossAppCommunication();
        }

        console.log("启动跨应用通信服务器");
        const port = await this.crossAppComm.startServer(8787);
        console.log(`跨应用通信服务器已启动，端口: ${port}`);

        // await this.crossAppComm.connectToApp(8787, "127.0.0.1");
        // console.log("连接到其他应用");
        // this.crossAppComm.send("synchronous-message", { message: "hello" });

        // 注册消息处理器示例
        this.crossAppComm.on("synchronous-message", (data) => {
          console.log("收到同步消息:", data);
          if (data.message === "hello") {
            this.crossAppComm.send("synchronous-message1", { message: "pong" });
          }
        });
      } catch (error) {
        console.error("启动跨应用通信服务器失败:", error);
      }

      // 跨应用通信 IPC 处理
      ipcMain.handle(
        "cross-app-connect",
        async (event, port, host = "127.0.0.1") => {
          try {
            if (!this.crossAppComm) {
              this.crossAppComm = new CrossAppCommunication();
            }
            await this.crossAppComm.connectToApp(port, host);
            return { success: true, message: "连接成功" };
          } catch (error) {
            return { success: false, error: error.message };
          }
        }
      );

      ipcMain.handle(
        "cross-app-send-sync",
        async (event, channel, data, timeout = 5000) => {
          try {
            if (!this.crossAppComm) {
              throw new Error("跨应用通信未初始化，请先连接或启动服务器");
            }
            const result = await this.crossAppComm.sendSync(
              channel,
              data,
              timeout
            );
            return { success: true, data: result };
          } catch (error) {
            return { success: false, error: error.message };
          }
        }
      );

      ipcMain.handle("cross-app-send", async (event, channel, data) => {
        try {
          if (!this.crossAppComm) {
            throw new Error("跨应用通信未初始化，请先连接或启动服务器");
          }
          this.crossAppComm.send(channel, data);
          return { success: true };
        } catch (error) {
          return { success: false, error: error.message };
        }
      });

      ipcMain.handle("cross-app-on", async (event, channel) => {
        try {
          if (!this.crossAppComm) {
            this.crossAppComm = new CrossAppCommunication();
          }
          // 注册消息处理器，通过 IPC 转发
          this.crossAppComm.on(channel, (data) => {
            // 通知渲染进程
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (mainWindow) {
              mainWindow.webContents.send("cross-app-message", {
                channel,
                data,
              });
            }
          });
          return { success: true };
        } catch (error) {
          return { success: false, error: error.message };
        }
      });

      ipcMain.handle("cross-app-get-server-port", async () => {
        try {
          if (!this.crossAppComm) {
            return { port: null };
          }
          return { port: this.crossAppComm.getServerPort() };
        } catch (error) {
          return { port: null, error: error.message };
        }
      });
    });
  }

  /**
   * @description 注销跨应用通信IPC处理
   * @returns {Promise<boolean>}
   */
  unregister() {
    return new Promise(async (resolve, reject) => {
      try {
        await this.crossAppComm.close();
        resolve(true);
      } catch (error) {
        reject(error);
      }
    });
  }
}

module.exports = new Sublink();
