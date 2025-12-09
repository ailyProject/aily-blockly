// Electron Preload Script - 串口桥接
// 更新 electron/preload.js 或创建 electron/serial-preload.js

const { contextBridge, ipcRenderer } = require('electron');

// 暴露串口 API 到渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 保留原有的 API...
  
  // 串口相关 API
  SerialPort: {
    // 列出可用串口
    list: () => ipcRenderer.invoke('serial:list'),
    
    // 创建串口连接(兼容原有接口)
    create: (options) => {
      return {
        open: async (callback) => {
          const result = await ipcRenderer.invoke('serial:connect', options);
          if (callback) {
            callback(result.success ? null : new Error(result.error));
          }
        },
        close: async (callback) => {
          const result = await ipcRenderer.invoke('serial:disconnect');
          if (callback) {
            callback(result.success ? null : new Error(result.error));
          }
        },
        write: async (data, callback) => {
          const result = await ipcRenderer.invoke('serial:send', data);
          if (callback) {
            callback(result.success ? null : new Error(result.error));
          }
        },
        on: (event, callback) => {
          if (event === 'data') {
            ipcRenderer.on('serial:data', (_, data) => callback(data));
          } else if (event === 'error') {
            ipcRenderer.on('serial:error', (_, error) => callback(new Error(error)));
          } else if (event === 'close') {
            ipcRenderer.on('serial:disconnected', () => callback());
          }
        },
        removeAllListeners: () => {
          ipcRenderer.removeAllListeners('serial:data');
          ipcRenderer.removeAllListeners('serial:error');
          ipcRenderer.removeAllListeners('serial:disconnected');
        }
      };
    },
    
    // 新的直接 API (推荐)
    connect: (options) => ipcRenderer.invoke('serial:connect', options),
    disconnect: () => ipcRenderer.invoke('serial:disconnect'),
    send: (data) => ipcRenderer.invoke('serial:send', data),
    getStatus: () => ipcRenderer.invoke('serial:status'),
    
    // 监听串口事件
    onData: (callback) => {
      ipcRenderer.on('serial:data', (_, data) => callback(data));
      return () => ipcRenderer.removeListener('serial:data', callback);
    },
    onError: (callback) => {
      ipcRenderer.on('serial:error', (_, error) => callback(error));
      return () => ipcRenderer.removeListener('serial:error', callback);
    },
    onDisconnected: (callback) => {
      ipcRenderer.on('serial:disconnected', callback);
      return () => ipcRenderer.removeListener('serial:disconnected', callback);
    }
  }
});
