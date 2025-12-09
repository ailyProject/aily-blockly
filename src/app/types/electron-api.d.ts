/**
 * Electron API 全局类型声明
 * 统一的 Window.electronAPI 接口定义
 */

export interface SerialPortAPI {
  // 列出可用串口
  list: () => Promise<any[]>;
  
  // 旧版 API (兼容)
  create?: (options: any) => any;
  
  // 新版 API
  connect?: (options: any) => Promise<any>;
  disconnect?: () => Promise<any>;
  send?: (data: any) => Promise<any>;
  getStatus?: () => Promise<any>;
  
  // 事件监听
  onData?: (callback: (data: any) => void) => () => void;
  onError?: (callback: (error: any) => void) => () => void;
  onDisconnected?: (callback: () => void) => () => void;
}

export interface ElectronAPI {
  SerialPort: SerialPortAPI;
  // 可以在此添加其他 Electron API
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    ipcRenderer?: any;
  }
}

// 确保这个文件被视为模块
export {};
