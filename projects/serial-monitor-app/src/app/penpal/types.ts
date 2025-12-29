/**
 * Penpal 通信接口定义
 * 用于主程序和子应用之间的通信
 * 
 * 设计理念：
 * - ParentMethods 只提供通用的底层 API
 * - 业务逻辑完全在子应用内实现
 */

// 串口数据项接口
export interface DataItem {
  time: string;
  data: any;
  dir: 'TX' | 'RX' | 'SYS';
  searchHighlight?: boolean;
}

// 快捷发送项接口
export interface QuickSendItem {
  name: string;
  type: 'signal' | 'text' | 'hex';
  data: string;
}

// 串口配置接口
export interface SerialConfig {
  path: string;
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  flowControl?: string;
}

// 串口信息接口
export interface PortInfo {
  name: string;
  text: string;
  type: string;
  icon: string;
  disabled?: boolean;
}

/**
 * 父窗口暴露给子窗口的通用 API
 * 主程序只提供底层能力，不包含业务逻辑
 */
export interface ParentMethods {
  [key: string]: ((...args: any[]) => any) | ParentMethods;
  
  // === Electron IPC ===
  invokeIpc(channel: string, ...args: any[]): Promise<any>;
  
  // === 串口 API（底层） ===
  getSerialPorts(): Promise<PortInfo[]>;
  createSerialPort(options: SerialConfig): any;
  
  // === 文件操作 ===
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  selectFolderSaveAs(options: any): Promise<string | null>;
  
  // === UI 操作 ===
  closeTool(toolId: string): void;
  openInNewWindow(route: string): void;
  showMessage(type: 'success' | 'error' | 'warning' | 'info', content: string): void;
  
  // === 翻译 ===
  translate(key: string): Promise<string>;
  
  // === 项目/配置 ===
  getCurrentProjectPath(): Promise<string | null>;
  getCurrentBoard(): Promise<string | null>;
  getCurrentPort(): Promise<string | null>;
  getConfig(key: string): Promise<any>;
  saveConfig(key: string, value: any): Promise<void>;
}

/**
 * 子窗口暴露给父窗口的方法
 * 子应用实现这些方法，供主程序调用（通常用于通知子应用）
 */
export interface ChildMethods {
  [key: string]: ((...args: any[]) => any) | ChildMethods;
  
  // 设置当前串口和波特率
  setPort(port: string): void;
  setBaudRate(baudRate: string): void;
  
  // 清空数据
  clearData(): void;
  
  // 强制断开连接（上传固件时由主程序调用）
  forceDisconnect(): void;
  
  // 更新快捷发送列表
  updateQuickSendList(list: QuickSendItem[]): void;
}
