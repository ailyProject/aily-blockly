import { Injectable } from '@angular/core';
import { ParentBridgeService } from './parent-bridge.service';
import { BehaviorSubject } from 'rxjs';

/**
 * 串口服务 - 子应用版本
 * 通过 ParentBridgeService 与主应用通信来操作串口
 */
@Injectable({
  providedIn: 'root'
})
export class SerialMonitorService {
  viewMode = {
    showHex: false,
    showCtrlChar: true,
    autoWrap: true,
    autoScroll: true,
    showTimestamp: true,
  };

  inputMode = {
    hexMode: false,
    sendByEnter: false,
    endR: true,
    endN: true,
  };

  dataList: any[] = [];
  dataUpdated = new BehaviorSubject<any>(null);

  // 串口状态
  connectionStatus = new BehaviorSubject<boolean>(false);
  availablePorts = new BehaviorSubject<any[]>([]);

  sendHistoryList: any[] = [];
  quickSendList: any[] = [];

  constructor(private parentBridge: ParentBridgeService) {
    this.setupListeners();
  }

  private setupListeners() {
    // 监听串口数据
    this.parentBridge.onSerialData().subscribe((msg) => {
      this.handleSerialData(msg.data);
    });

    // 监听串口状态
    this.parentBridge.onSerialStatus().subscribe((msg) => {
      this.connectionStatus.next(msg.data.connected);
    });

    // 监听项目更新
    this.parentBridge.onProjectUpdate().subscribe((msg) => {
      console.log('Project updated:', msg.data);
    });
  }

  /**
   * 获取串口列表
   */
  async getPortsList(): Promise<any[]> {
    try {
      const ports = await this.parentBridge.getSerialPorts();
      this.availablePorts.next(ports);
      return ports;
    } catch (error) {
      console.error('Failed to get ports list:', error);
      return [];
    }
  }

  /**
   * 连接串口
   */
  async connect(options: any): Promise<boolean> {
    try {
      const result = await this.parentBridge.connectSerial(options);
      if (result) {
        this.connectionStatus.next(true);
      }
      return result;
    } catch (error) {
      console.error('Failed to connect:', error);
      return false;
    }
  }

  /**
   * 断开串口
   */
  async disconnect(): Promise<boolean> {
    try {
      const result = await this.parentBridge.disconnectSerial();
      if (result) {
        this.connectionStatus.next(false);
      }
      return result;
    } catch (error) {
      console.error('Failed to disconnect:', error);
      return false;
    }
  }

  /**
   * 发送数据
   */
  async sendData(data: string | Buffer, mode = 'text', ignoreEnd = false): Promise<boolean> {
    try {
      let dataToSend = data;
      
      if (typeof data === 'string') {
        // 如果输入模式是hex，则将字符串解析为hex
        if (this.inputMode.hexMode || mode === 'hex') {
          // 移除空格和非hex字符
          const hexString = data.replace(/[^0-9A-Fa-f]/g, '');
          // 确保有偶数个字符
          const paddedHex = hexString.length % 2 ? '0' + hexString : hexString;
          dataToSend = paddedHex;
        } else {
          // 普通字符串
          let textToSend = data;
          // 如果设置了enter选项，添加换行符
          if (!ignoreEnd) {
            if (this.inputMode.endR) {
              textToSend += '\r';
            }
            if (this.inputMode.endN) {
              textToSend += '\n';
            }
          }
          dataToSend = textToSend;
        }
      }
      
      const result = await this.parentBridge.sendSerialData(dataToSend);
      if (result) {
        // 记录发送的数据
        const now = new Date();
        const item: dataItem = {
          data: dataToSend,
          time: now.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + now.getMilliseconds().toString().padStart(3, '0'),
          dir: 'TX'
        };
        this.dataList.push(item);
        this.dataUpdated.next(item);
      }
      return result;
    } catch (error) {
      console.error('Failed to send data:', error);
      return false;
    }
  }

  /**
   * 发送信号（DTR/RTS）
   */
  async sendSignal(signalType: string, state?: boolean): Promise<boolean> {
    try {
      // 通过 parentBridge 发送信号
      return await this.parentBridge.sendRequest('serial:signal', {
        signalType,
        state
      });
    } catch (error) {
      console.error('Failed to send signal:', error);
      return false;
    }
  }

  /**
   * 处理接收到的串口数据
   */
  private handleSerialData(data: any) {
    const now = new Date();
    const item: dataItem = {
      data: data,
      time: now.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + now.getMilliseconds().toString().padStart(3, '0'),
      dir: 'RX'
    };
    
    this.dataList.push(item);
    this.dataUpdated.next(item);
  }

  /**
   * 清空数据
   */
  clearData() {
    this.dataList = [];
    this.dataUpdated.next(null);
  }

  /**
   * 加载快速发送列表
   */
  loadQuickSendList() {
    // 从本地存储或通过 parentBridge 获取
    const stored = localStorage.getItem('quickSendList');
    if (stored) {
      try {
        this.quickSendList = JSON.parse(stored);
      } catch (e) {
        console.error('Failed to parse quickSendList:', e);
      }
    }
  }

  /**
   * 保存快速发送列表
   */
  saveQuickSendList() {
    localStorage.setItem('quickSendList', JSON.stringify(this.quickSendList));
  }

  /**
   * 导出数据
   */
  async exportData() {
    if (this.dataList.length === 0) {
      console.warn('没有数据可以导出');
      return;
    }

    // 准备要写入的内容
    let fileContent = '';

    // 根据viewMode设置处理每个数据项
    for (const item of this.dataList) {
      // 添加时间戳
      if (this.viewMode.showTimestamp) {
        fileContent += `[${item.time}] `;
        fileContent += item.dir;
      }

      // 处理数据内容
      let dataContent = '';
      const data = item.data;
      
      if (this.viewMode.showHex && typeof data === 'string') {
        // 转换为Hex显示
        dataContent = Buffer.from(data).toString('hex').match(/.{2}/g)?.join(' ') || '';
      } else {
        dataContent = String(data);
      }
      
      fileContent += ' ' + dataContent + '\n';
    }

    // 使用 parentBridge 请求保存文件
    try {
      await this.parentBridge.sendRequest('file:export', {
        content: fileContent,
        suggestedName: 'log_' + new Date().toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).replace(/[/,:]/g, '_').replace(/\s/g, '_') + '.txt'
      });
    } catch (error) {
      console.error('Failed to export data:', error);
    }
  }
}

export interface dataItem {
  time: string;
  data: any;
  dir: 'TX' | 'RX' | 'SYS';
  searchHighlight?: boolean;
}

export interface QuickSendItem {
  "name": string;
  "type": "signal" | "text" | "hex";
  "data": string;
}
