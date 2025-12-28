import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { Buffer } from 'buffer';
import { PenpalService } from '../penpal/penpal.service';
import { DataItem, QuickSendItem, PortInfo } from '../penpal/types';

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

  dataList: DataItem[] = [];
  dataUpdated = new Subject<void | DataItem>();
  
  connectionStatus = new BehaviorSubject<boolean>(false);
  availablePorts = new BehaviorSubject<PortInfo[]>([]);

  sendHistoryList: string[] = [];
  quickSendList: QuickSendItem[] = [];

  constructor(private penpalService: PenpalService) {
    this.init();
  }

  private async init() {
    // 订阅来自父窗口的串口数据
    this.penpalService.serialDataReceived.subscribe((data) => {
      this.processReceivedData(data);
    });

    // 订阅连接状态变化
    this.penpalService.connectionStatusChanged.subscribe((connected) => {
      this.connectionStatus.next(connected);
    });

    // 订阅清空数据请求
    this.penpalService.clearDataRequested.subscribe(() => {
      this.clearData();
    });

    // 订阅强制断开请求
    this.penpalService.forceDisconnectRequested.subscribe(() => {
      this.connectionStatus.next(false);
    });

    // 订阅快捷发送列表更新
    this.penpalService.quickSendListUpdated.subscribe((list) => {
      this.quickSendList = list;
    });

    // 加载快捷发送列表
    await this.loadQuickSendList();
  }

  private processReceivedData(data: DataItem) {
    // 转换数据格式（如果需要）
    if (data.data && typeof data.data === 'object' && data.data.type === 'Buffer') {
      data.data = Buffer.from(data.data.data);
    }
    
    this.dataList.push(data);
    this.dataUpdated.next(data);
  }

  /**
   * 获取可用串口列表
   */
  async getPortsList(): Promise<PortInfo[]> {
    try {
      const ports = await this.penpalService.getPortsList();
      this.availablePorts.next(ports);
      return ports;
    } catch (error) {
      console.error('获取串口列表失败:', error);
      return [];
    }
  }

  /**
   * 连接串口
   */
  async connect(options: {
    path: string;
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
    flowControl?: string;
  }): Promise<boolean> {
    try {
      const result = await this.penpalService.connect(options);
      if (result) {
        this.connectionStatus.next(true);
      }
      return result;
    } catch (error) {
      console.error('连接串口失败:', error);
      return false;
    }
  }

  /**
   * 断开串口连接
   */
  async disconnect(): Promise<boolean> {
    try {
      const result = await this.penpalService.disconnect();
      this.connectionStatus.next(false);
      return result;
    } catch (error) {
      console.error('断开串口失败:', error);
      return false;
    }
  }

  /**
   * 发送数据
   */
  async sendData(data: string, mode = 'text', ignoreEnd = false): Promise<boolean> {
    if (!this.connectionStatus.value) {
      await this.penpalService.showMessage('warning', '串口未连接，请先打开串口');
      return false;
    }

    try {
      const actualMode = this.inputMode.hexMode ? 'hex' : mode;
      const result = await this.penpalService.sendData(data, actualMode, ignoreEnd);
      return result;
    } catch (error) {
      console.error('发送数据失败:', error);
      return false;
    }
  }

  /**
   * 发送控制信号
   */
  async sendSignal(signalType: 'DTR' | 'RTS', state?: boolean): Promise<boolean> {
    if (!this.connectionStatus.value) {
      await this.penpalService.showMessage('warning', '串口未连接，请先打开串口');
      return false;
    }

    try {
      return await this.penpalService.sendSignal(signalType, state);
    } catch (error) {
      console.error('发送信号失败:', error);
      return false;
    }
  }

  /**
   * 清除数据
   */
  clearData() {
    this.dataList = [];
    this.dataUpdated.next();
  }

  /**
   * 检查是否已连接
   */
  isPortConnected(): boolean {
    return this.connectionStatus.value;
  }

  /**
   * 导出数据
   */
  async exportData(): Promise<void> {
    if (this.dataList.length === 0) {
      console.warn('没有数据可以导出');
      return;
    }

    // 准备要写入的内容
    let fileContent = '';

    for (const item of this.dataList) {
      if (this.viewMode.showTimestamp) {
        fileContent += `[${item.time}] `;
        fileContent += item.dir;
      }

      let dataContent = '';
      if (this.viewMode.showHex) {
        if (Buffer.isBuffer(item.data)) {
          dataContent = Array.from(item.data as Buffer)
            .map((byte: number) => byte.toString(16).padStart(2, '0'))
            .join(' ');
        } else {
          dataContent = Buffer.from(String(item.data)).toString('hex');
        }
      } else {
        let textData = '';
        if (Buffer.isBuffer(item.data)) {
          textData = (item.data as Buffer).toString();
        } else {
          textData = String(item.data);
        }

        if (this.viewMode.showCtrlChar) {
          dataContent = textData
            .replace(/\r\n/g, '\\r\\n\n')
            .replace(/\n/g, '\\n\n')
            .replace(/\r/g, '\\r\n')
            .replace(/\t/g, '\\t')
            .replace(/\f/g, '\\f')
            .replace(/\v/g, '\\v')
            .replace(/\0/g, '\\0');
        } else {
          dataContent = textData;
        }
      }

      fileContent += dataContent;

      if (this.viewMode.autoWrap || fileContent.endsWith('\n')) {
        // 已经有换行了
      } else {
        fileContent += '\n';
      }
    }

    const filePath = await this.penpalService.exportData(fileContent);
    if (filePath) {
      await this.penpalService.showMessage('success', '数据已成功导出到' + filePath);
    }
  }

  /**
   * 保存快捷发送列表
   */
  async saveQuickSendList(): Promise<void> {
    await this.penpalService.saveQuickSendList(this.quickSendList);
  }

  /**
   * 加载快捷发送列表
   */
  async loadQuickSendList(): Promise<void> {
    try {
      await this.penpalService.waitForConnection();
      const list = await this.penpalService.getQuickSendList();
      if (list && list.length > 0) {
        this.quickSendList = list;
      } else {
        this.quickSendList = [
          { name: 'DTR', type: 'signal', data: 'DTR' },
          { name: 'RTS', type: 'signal', data: 'RTS' },
          { name: '发送文本', type: 'text', data: 'This is aily blockly' },
          { name: '发送Hex', type: 'hex', data: 'FF FF A1 A2 A3 A4 A5' }
        ];
      }
    } catch (e) {
      console.error('加载快速发送列表失败:', e);
      this.quickSendList = [
        { name: 'DTR', type: 'signal', data: 'DTR' },
        { name: 'RTS', type: 'signal', data: 'RTS' },
        { name: '发送文本', type: 'text', data: 'This is aily blockly' },
        { name: '发送Hex', type: 'hex', data: 'FF FF A1 A2 A3 A4 A5' }
      ];
    }
  }
}
