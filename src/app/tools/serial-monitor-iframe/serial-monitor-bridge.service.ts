import { Injectable, ElementRef } from '@angular/core';
import { connect, WindowMessenger, RemoteProxy, Connection } from 'penpal';
import { BehaviorSubject, Subject } from 'rxjs';
import { Buffer } from 'buffer';
import { 
  ParentMethods, 
  ChildMethods, 
  DataItem, 
  QuickSendItem, 
  SerialConfig, 
  PortInfo 
} from './penpal-types';
import { SerialService } from '../../services/serial.service';
import { ProjectService } from '../../services/project.service';
import { ConfigService } from '../../services/config.service';
import { ElectronService } from '../../services/electron.service';
import { UiService } from '../../services/ui.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { TranslateService } from '@ngx-translate/core';

// 声明Electron API全局接口
declare global {
  interface Window {
    electronAPI: {
      SerialPort: {
        list: () => Promise<any[]>;
        create: (options: any) => any;
      }
    }
  }
}

@Injectable({
  providedIn: 'root'
})
export class SerialMonitorBridgeService {
  private connection: Connection<ChildMethods> | null = null;
  private childMethods: RemoteProxy<ChildMethods> | null = null;
  private connectionReady = new BehaviorSubject<boolean>(false);
  
  // 串口相关属性
  private serialPort: any = null;
  private isConnected = false;
  private lastDataTime = 0;
  private firstDataTime = 0;
  
  // 输入模式配置
  private inputMode = {
    hexMode: false,
    endR: true,
    endN: true,
  };
  
  // 数据列表（用于导出）
  private dataList: DataItem[] = [];

  constructor(
    private serialService: SerialService,
    private projectService: ProjectService,
    private configService: ConfigService,
    private electronService: ElectronService,
    private uiService: UiService,
    private message: NzMessageService,
    private translate: TranslateService
  ) {}

  /**
   * 初始化与 iframe 的连接
   */
  async initConnection(iframeRef: ElementRef<HTMLIFrameElement>): Promise<void> {
    if (this.connection) {
      this.connection.destroy();
    }

    const parentMethods: ParentMethods = {
      getPortsList: () => this.getPortsList(),
      connect: (config) => this.connect(config),
      disconnect: () => this.disconnect(),
      sendData: (data, mode, ignoreEnd) => this.sendData(data, mode, ignoreEnd),
      sendSignal: (signalType, state) => this.sendSignal(signalType, state),
      exportData: (content) => this.exportData(content),
      getQuickSendList: () => this.getQuickSendList(),
      saveQuickSendList: (list) => this.saveQuickSendList(list),
      closePanel: () => this.closePanel(),
      openInNewWindow: () => this.openInNewWindow(),
      translate: (key) => this.translateKey(key),
      showMessage: (type, content) => this.showMessage(type, content),
      getCurrentBoard: () => this.getCurrentBoard()
    };

    // penpal 7.x 使用 WindowMessenger + connect
    const messenger = new WindowMessenger({
      remoteWindow: iframeRef.nativeElement.contentWindow!,
      allowedOrigins: ['*'] // 允许任意来源（Electron 本地文件）
    });

    this.connection = connect<ChildMethods>({
      messenger,
      methods: parentMethods
    });

    try {
      this.childMethods = await this.connection.promise;
      this.connectionReady.next(true);
      console.log('[SerialMonitorBridge] Connection established');
    } catch (error) {
      console.error('[SerialMonitorBridge] Failed to connect:', error);
    }
  }

  /**
   * 销毁连接
   */
  destroy() {
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
      this.childMethods = null;
      this.connectionReady.next(false);
    }
    this.disconnect();
  }

  /**
   * 获取串口列表
   */
  private async getPortsList(): Promise<PortInfo[]> {
    try {
      const ports = await this.serialService.getSerialPorts();
      return ports.map(p => ({
        name: p.name,
        text: p.text || '',
        type: p.type || 'serial',
        icon: p.icon || 'fa-light fa-usb-drive',
        disabled: p.disabled || false
      }));
    } catch (error) {
      console.error('获取串口列表失败:', error);
      return [];
    }
  }

  /**
   * 连接串口
   */
  private async connect(config: SerialConfig): Promise<boolean> {
    if (this.isConnected) {
      await this.disconnect();
    }

    try {
      const serialOptions = {
        path: config.path,
        baudRate: config.baudRate || 9600,
        dataBits: config.dataBits || 8,
        stopBits: config.stopBits || 1,
        parity: config.parity || 'none',
        flowControl: config.flowControl || 'none',
        autoOpen: false
      };

      this.serialPort = window.electronAPI.SerialPort.create(serialOptions);

      return new Promise((resolve, reject) => {
        this.serialPort.on('open', () => {
          this.isConnected = true;
          
          const connectData: DataItem = {
            time: new Date().toLocaleTimeString(),
            data: Buffer.from(`[串口已连接: ${config.path} ${config.baudRate}波特 ${config.dataBits || 8}数据位 ${config.stopBits || 1}停止位 ${config.parity || 'none'}校验 ${config.flowControl || 'none'}流控]`),
            dir: 'SYS'
          };
          
          this.dataList.push(connectData);
          this.notifyChild('onSerialData', connectData);
          this.notifyChild('onConnectionStatusChange', true);
          
          this.setupDataListeners();
          resolve(true);
        });

        this.serialPort.on('error', (err: any) => {
          console.error('串口错误:', err);
          this.isConnected = false;
          this.notifyChild('onConnectionStatusChange', false);
          reject(err);
        });

        this.serialPort.open((err: any) => {
          if (err) {
            console.error('打开串口失败:', err);
            this.isConnected = false;
            this.notifyChild('onConnectionStatusChange', false);
            reject(err);
          }
        });
      });
    } catch (error) {
      console.error('连接串口失败:', error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * 设置数据监听器
   */
  private setupDataListeners() {
    if (!this.serialPort) return;

    this.serialPort.on('data', (data: Buffer) => {
      this.processReceivedData(data);
    });

    this.serialPort.on('close', () => {
      this.isConnected = false;
      this.notifyChild('onConnectionStatusChange', false);
      console.log('串口已关闭');
    });
  }

  /**
   * 处理接收到的数据
   */
  private processReceivedData(data: Buffer) {
    const currentTime = Date.now();
    const timeString = new Date().toLocaleTimeString();

    // 检查是否需要创建新的数据项
    if (this.dataList.length === 0 ||
      currentTime - this.lastDataTime > 1000 ||
      currentTime - this.firstDataTime > 10000 ||
      this.dataList[this.dataList.length - 1].dir !== 'RX') {
      
      const item: DataItem = {
        time: timeString,
        data: data,
        dir: 'RX'
      };
      
      this.dataList.push(item);
      this.notifyChild('onSerialData', item);
      this.firstDataTime = currentTime;
    } else {
      // 将数据添加到最后一个项目
      const lastItem = this.dataList[this.dataList.length - 1];
      const combinedData = Buffer.concat([lastItem.data, data]);
      lastItem.data = combinedData;
    }

    this.lastDataTime = currentTime;
  }

  /**
   * 发送数据
   */
  private async sendData(data: string, mode = 'text', ignoreEnd = false): Promise<boolean> {
    if (!this.isConnected || !this.serialPort) {
      this.message.warning('串口未连接，请先打开串口');
      return false;
    }

    return new Promise((resolve) => {
      let bufferToSend: Buffer;
      
      if (this.inputMode.hexMode || mode === 'hex') {
        const hexString = data.replace(/[^0-9A-Fa-f]/g, '');
        const paddedHex = hexString.length % 2 ? '0' + hexString : hexString;
        bufferToSend = Buffer.from(paddedHex, 'hex');
      } else {
        let textToSend = data;
        if (!ignoreEnd) {
          if (this.inputMode.endR) {
            textToSend += '\r';
          }
          if (this.inputMode.endN) {
            textToSend += '\n';
          }
        }
        bufferToSend = Buffer.from(textToSend);
      }

      this.serialPort.write(bufferToSend, (err: any) => {
        if (err) {
          console.error('发送数据失败:', err);
          resolve(false);
        } else {
          const txItem: DataItem = {
            time: new Date().toLocaleTimeString(),
            data: bufferToSend,
            dir: 'TX'
          };
          
          this.dataList.push(txItem);
          this.notifyChild('onSerialData', txItem);
          resolve(true);
        }
      });
    });
  }

  /**
   * 断开连接
   */
  private async disconnect(): Promise<boolean> {
    if (!this.isConnected || !this.serialPort) {
      return true;
    }

    return new Promise((resolve) => {
      this.serialPort.close((err: any) => {
        if (err) {
          console.error('关闭串口失败:', err);
          resolve(false);
        } else {
          this.isConnected = false;
          this.serialPort = null;
          this.notifyChild('onConnectionStatusChange', false);
          resolve(true);
        }
      });
    });
  }

  /**
   * 发送控制信号
   */
  private async sendSignal(signalType: 'DTR' | 'RTS', state?: boolean): Promise<boolean> {
    if (!this.isConnected || !this.serialPort) {
      this.message.warning('串口未连接，请先打开串口');
      return false;
    }

    return new Promise((resolve) => {
      try {
        const methodName = signalType.toLowerCase();
        
        this.serialPort.set({ [methodName]: state }, (err: any) => {
          if (err) {
            console.error(`设置${signalType}信号失败:`, err);
            this.message.error(`设置${signalType}信号失败`);
            resolve(false);
          } else {
            const signalItem: DataItem = {
              time: new Date().toLocaleTimeString(),
              data: Buffer.from(`[设置${signalType}信号: ${state ? '开启' : '关闭'}]`),
              dir: 'SYS'
            };
            
            this.dataList.push(signalItem);
            this.notifyChild('onSerialData', signalItem);
            resolve(true);
          }
        });
      } catch (error) {
        console.error('发送信号时出错:', error);
        this.message.error('发送信号失败');
        resolve(false);
      }
    });
  }

  /**
   * 导出数据
   */
  private async exportData(content: string): Promise<string | null> {
    const folderPath = await window['ipcRenderer'].invoke('select-folder-saveAs', {
      title: '导出串口数据',
      path: this.projectService.currentProjectPath,
      suggestedName: 'log_' + new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).replace(/[/,:]/g, '_').replace(/\s/g, '_') + '.txt',
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });

    if (!folderPath) {
      return null;
    }

    this.electronService.writeFile(folderPath, content);
    return folderPath;
  }

  /**
   * 获取快捷发送列表
   */
  private async getQuickSendList(): Promise<QuickSendItem[]> {
    if (this.configService.data?.quickSendList) {
      return this.configService.data.quickSendList;
    }
    return [
      { name: 'DTR', type: 'signal', data: 'DTR' },
      { name: 'RTS', type: 'signal', data: 'RTS' },
      { name: '发送文本', type: 'text', data: 'This is aily blockly' },
      { name: '发送Hex', type: 'hex', data: 'FF FF A1 A2 A3 A4 A5' }
    ];
  }

  /**
   * 保存快捷发送列表
   */
  private async saveQuickSendList(list: QuickSendItem[]): Promise<void> {
    this.configService.data.quickSendList = list;
    this.configService.save();
  }

  /**
   * 关闭面板
   */
  private closePanel(): void {
    this.uiService.closeTool('serial-monitor');
  }

  /**
   * 在新窗口打开
   */
  private openInNewWindow(): void {
    // TODO: 实现在新窗口打开的逻辑
  }

  /**
   * 翻译
   */
  private async translateKey(key: string): Promise<string> {
    return this.translate.instant(key);
  }

  /**
   * 显示消息
   */
  private showMessage(type: 'success' | 'error' | 'warning' | 'info', content: string): void {
    this.message[type](content);
  }

  /**
   * 获取当前开发板
   */
  private async getCurrentBoard(): Promise<string | null> {
    return this.projectService.currentPackageData?.board || null;
  }

  /**
   * 通知子窗口
   */
  private async notifyChild(
    method: string, 
    ...args: any[]
  ): Promise<void> {
    if (!this.childMethods) return;
    
    try {
      const fn = (this.childMethods as any)[method];
      if (typeof fn === 'function') {
        fn(...args);
      }
    } catch (error) {
      console.error(`[SerialMonitorBridge] Failed to call ${method}:`, error);
    }
  }

  /**
   * 设置端口
   */
  setPort(port: string): void {
    this.notifyChild('setPort', port);
  }

  /**
   * 设置波特率
   */
  setBaudRate(baudRate: string): void {
    this.notifyChild('setBaudRate', baudRate);
  }

  /**
   * 强制断开连接（上传固件时）
   */
  async forceDisconnect(): Promise<void> {
    await this.disconnect();
    this.notifyChild('forceDisconnect');
  }

  /**
   * 清空数据
   */
  clearData(): void {
    this.dataList = [];
    this.notifyChild('clearData');
  }
}
