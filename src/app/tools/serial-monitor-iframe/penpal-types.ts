/**
 * Penpal 通信接口定义
 * 用于主程序和 serial-monitor-app 之间的通信
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
 * 父窗口暴露给子窗口的方法
 * 主程序实现这些方法，供 iframe 内的 serial-monitor 调用
 */
export interface ParentMethods {
  [key: string]: ((...args: any[]) => any) | ParentMethods;
  
  // 串口操作
  getPortsList(): Promise<PortInfo[]>;
  connect(config: SerialConfig): Promise<boolean>;
  disconnect(): Promise<boolean>;
  sendData(data: string, mode?: string, ignoreEnd?: boolean): Promise<boolean>;
  sendSignal(signalType: 'DTR' | 'RTS', state?: boolean): Promise<boolean>;
  
  // 文件操作
  exportData(content: string): Promise<string | null>;
  
  // 配置操作
  getQuickSendList(): Promise<QuickSendItem[]>;
  saveQuickSendList(list: QuickSendItem[]): Promise<void>;
  
  // UI 操作
  closePanel(): void;
  openInNewWindow(): void;
  
  // 翻译
  translate(key: string): Promise<string>;
  
  // 消息提示
  showMessage(type: 'success' | 'error' | 'warning' | 'info', content: string): void;
  
  // 获取当前开发板信息
  getCurrentBoard(): Promise<string | null>;
}

/**
 * 子窗口暴露给父窗口的方法
 * serial-monitor-app 实现这些方法，供主程序调用
 */
export interface ChildMethods {
  [key: string]: ((...args: any[]) => any) | ChildMethods;
  
  // 接收串口数据
  onSerialData(data: DataItem): void;
  
  // 连接状态变化
  onConnectionStatusChange(connected: boolean): void;
  
  // 设置当前串口和波特率
  setPort(port: string): void;
  setBaudRate(baudRate: string): void;
  
  // 清空数据
  clearData(): void;
  
  // 断开连接（上传固件时）
  forceDisconnect(): void;
  
  // 更新快捷发送列表
  updateQuickSendList(list: QuickSendItem[]): void;
}
