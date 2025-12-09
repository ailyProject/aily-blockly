// Electron Main Process - 串口管理模块
// 添加到 electron/main.js 或创建单独的 electron/serial-manager.js

const { ipcMain } = require('electron');
const { SerialPort } = require('serialport');

class SerialManager {
  constructor() {
    this.serialPort = null;
    this.isConnected = false;
    this.mainWindow = null;
    this.setupIpcHandlers();
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  setupIpcHandlers() {
    // 获取串口列表
    ipcMain.handle('serial:list', async () => {
      try {
        const ports = await SerialPort.list();
        return { success: true, data: ports };
      } catch (error) {
        console.error('Failed to list serial ports:', error);
        return { success: false, error: error.message };
      }
    });

    // 连接串口
    ipcMain.handle('serial:connect', async (event, options) => {
      try {
        if (this.serialPort && this.isConnected) {
          await this.disconnect();
        }

        this.serialPort = new SerialPort({
          path: options.path,
          baudRate: options.baudRate || 9600,
          dataBits: options.dataBits || 8,
          stopBits: options.stopBits || 1,
          parity: options.parity || 'none',
          autoOpen: false
        });

        return new Promise((resolve) => {
          this.serialPort.open((err) => {
            if (err) {
              console.error('Failed to open serial port:', err);
              resolve({ success: false, error: err.message });
              return;
            }

            this.isConnected = true;
            
            // 监听数据
            this.serialPort.on('data', (data) => {
              if (this.mainWindow) {
                this.mainWindow.webContents.send('serial:data', data);
              }
            });

            // 监听错误
            this.serialPort.on('error', (error) => {
              console.error('Serial port error:', error);
              if (this.mainWindow) {
                this.mainWindow.webContents.send('serial:error', error.message);
              }
            });

            // 监听关闭
            this.serialPort.on('close', () => {
              this.isConnected = false;
              if (this.mainWindow) {
                this.mainWindow.webContents.send('serial:disconnected');
              }
            });

            resolve({ success: true, data: { connected: true, port: options.path } });
          });
        });
      } catch (error) {
        console.error('Failed to connect serial port:', error);
        return { success: false, error: error.message };
      }
    });

    // 断开串口
    ipcMain.handle('serial:disconnect', async () => {
      try {
        if (!this.serialPort || !this.isConnected) {
          return { success: true, data: { connected: false } };
        }

        return new Promise((resolve) => {
          this.serialPort.close((err) => {
            if (err) {
              console.error('Failed to close serial port:', err);
              resolve({ success: false, error: err.message });
              return;
            }

            this.isConnected = false;
            this.serialPort = null;
            resolve({ success: true, data: { connected: false } });
          });
        });
      } catch (error) {
        console.error('Failed to disconnect serial port:', error);
        return { success: false, error: error.message };
      }
    });

    // 发送数据
    ipcMain.handle('serial:send', async (event, data) => {
      try {
        if (!this.serialPort || !this.isConnected) {
          return { success: false, error: 'Serial port not connected' };
        }

        return new Promise((resolve) => {
          this.serialPort.write(data, (err) => {
            if (err) {
              console.error('Failed to write to serial port:', err);
              resolve({ success: false, error: err.message });
              return;
            }

            resolve({ success: true });
          });
        });
      } catch (error) {
        console.error('Failed to send serial data:', error);
        return { success: false, error: error.message };
      }
    });

    // 获取连接状态
    ipcMain.handle('serial:status', async () => {
      return {
        success: true,
        data: {
          connected: this.isConnected,
          port: this.serialPort ? this.serialPort.path : null
        }
      };
    });
  }

  async disconnect() {
    if (this.serialPort && this.isConnected) {
      return new Promise((resolve) => {
        this.serialPort.close(() => {
          this.isConnected = false;
          this.serialPort = null;
          resolve();
        });
      });
    }
  }

  cleanup() {
    this.disconnect();
  }
}

module.exports = SerialManager;
