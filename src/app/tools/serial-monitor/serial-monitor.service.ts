import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { Buffer } from 'buffer';
import { ProjectService } from '../../services/project.service';
import { ElectronService } from '../../services/electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ConfigService } from '../../services/config.service';

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
export class SerialMonitorService {
  viewMode = {
    showHex: false, // hex显示
    showCtrlChar: true, // 控制字符显示
    autoWrap: true, // 换行显示
    autoScroll: true, // 自动滚动显示
    showTimestamp: true, // 时间显示
  }

  inputMode = {
    hexMode: false,
    sendByEnter: false,
    endR: true,
    endN: true,
  }

  dataList: dataItem[] = [];

  dataUpdated = new Subject<void>();

  // 串口相关属性
  private serialPort: any = null;
  private lastDataTime = 0;
  private isConnected = false;

  // 状态观察对象
  connectionStatus = new BehaviorSubject<boolean>(false);
  availablePorts = new BehaviorSubject<any[]>([]);

  sendHistoryList = [];

  quickSendList: QuickSendItem[] = []

  constructor(
    private projectService: ProjectService,
    private electronService: ElectronService,
    private message: NzMessageService,
    private configService: ConfigService
  ) {
    this.loadQuickSendList();
  }

  /**
   * 获取可用串口列表
   */
  async getPortsList(): Promise<any[]> {
    try {
      const ports = await window.electronAPI.SerialPort.list();
      this.availablePorts.next(ports);
      return ports;
    } catch (error) {
      console.error('获取串口列表失败:', error);
      return [];
    }
  }

  /**
   * 连接到指定串口
   * @param options 串口配置选项 {path, baudRate, ...}
   */
  async connect(options: any): Promise<boolean> {
    if (this.isConnected) {
      await this.disconnect();
    }

    try {
      const serialOptions = {
        path: options.path,
        baudRate: options.baudRate || 9600,
        dataBits: options.dataBits || 8,
        stopBits: options.stopBits || 1,
        parity: options.parity || 'none',
        flowControl: options.flowControl || 'none',
        autoOpen: false
      };

      this.serialPort = window.electronAPI.SerialPort.create(serialOptions);
      
      return new Promise((resolve, reject) => {
        this.serialPort.on('open', () => {
          this.isConnected = true;
          this.connectionStatus.next(true);
          this.setupDataListeners();
          
          // 记录连接信息到数据列表
          this.dataList.push({
            time: new Date().toLocaleTimeString(),
            data: Buffer.from(`[串口已连接: ${options.path} ${options.baudRate}波特 ${options.dataBits}数据位 ${options.stopBits}停止位 ${options.parity}校验 ${options.flowControl}流控]`),
            dir: 'SYS'
          });
          this.dataUpdated.next();
          
          resolve(true);
        });

        this.serialPort.on('error', (err: any) => {
          console.error('串口错误:', err);
          this.isConnected = false;
          this.connectionStatus.next(false);
          reject(err);
        });

        this.serialPort.open((err: any) => {
          if (err) {
            console.error('打开串口失败:', err);
            this.isConnected = false;
            this.connectionStatus.next(false);
            reject(err);
          }
        });
      });
    } catch (error) {
      console.error('连接串口失败:', error);
      this.isConnected = false;
      this.connectionStatus.next(false);
      return false;
    }
  }

  /**
   * 设置数据监听器
   */
  private setupDataListeners() {
    if (!this.serialPort) return;

    this.serialPort.on('data', (data) => {
      this.processReceivedData(data);
    });

    this.serialPort.on('close', () => {
      this.isConnected = false;
      this.connectionStatus.next(false);
      console.log('串口已关闭');
    });
  }

  /**
   * 处理接收到的数据
   * 根据时间间隔规则存储数据：
   * 1. 如果距离上次数据超过1秒，创建新记录
   * 2. 如果不到1秒，追加到当前记录
   */
  private processReceivedData(data) {
    const currentTime = Date.now();
    const timeString = new Date().toLocaleTimeString();

    // 检查是否需要创建新的数据项
    if (this.dataList.length === 0 ||
      currentTime - this.lastDataTime > 1000 ||
      this.dataList[this.dataList.length - 1].dir !== 'RX') {
      // 创建新的数据项
      this.dataList.push({
        time: timeString,
        data: data,
        dir: 'RX'
      });
    } else {
      // 将数据添加到最后一个项目
      const lastItem = this.dataList[this.dataList.length - 1];
      // 合并Buffer数据
      const combinedData = Buffer.concat([lastItem.data, data]);
      lastItem.data = combinedData;
    }

    // 更新最后一次接收数据的时间
    this.lastDataTime = currentTime;

    this.dataUpdated.next();
  }

  /**
   * 发送数据到串口
   */
  sendData(data: string, mode = 'text', IgnoreEnd = false): Promise<boolean> {
    if (!this.isConnected || !this.serialPort) {
      this.message.warning('串口未连接，请先打开串口');
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let bufferToSend;
      if (typeof data === 'string') {
        // 如果输入模式是hex，则将字符串解析为hex
        if (this.inputMode.hexMode || mode === 'hex') {
          // 移除空格和非hex字符
          const hexString = data.replace(/[^0-9A-Fa-f]/g, '');
          // 确保有偶数个字符
          const paddedHex = hexString.length % 2 ? '0' + hexString : hexString;
          // 转换为Buffer
          bufferToSend = Buffer.from(paddedHex, 'hex');
        } else {
          // 普通字符串
          let textToSend = data;
          // 如果设置了enter选项，添加换行符
          if (!IgnoreEnd) {
            if (this.inputMode.endR) {
              textToSend += '\r';
            }
            if (this.inputMode.endN) {
              textToSend += '\n';
            }
          }
          bufferToSend = Buffer.from(textToSend);
        }
      } else {
        // 已经是Buffer
        bufferToSend = data;
      }

      this.serialPort.write(bufferToSend, (err: any) => {
        if (err) {
          console.error('发送数据失败:', err);
          resolve(false);
        } else {
          // 记录发送的数据到dataList
          this.dataList.push({
            time: new Date().toLocaleTimeString(),
            data: bufferToSend,
            dir: 'TX'
          });

          this.dataUpdated.next();
          resolve(true);
        }
      });
    });
  }

  /**
   * 断开串口连接
   */
  disconnect(): Promise<boolean> {
    if (!this.isConnected || !this.serialPort) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      this.serialPort.close((err: any) => {
        if (err) {
          console.error('关闭串口失败:', err);
          resolve(false);
        } else {
          this.isConnected = false;
          this.connectionStatus.next(false);
          this.serialPort = null;
          resolve(true);
        }
      });
    });
  }

  /**
   * 清除数据列表
   */
  clearData() {
    this.dataList = [];
  }

  /**
   * 检查是否已连接
   */
  isPortConnected(): boolean {
    return this.isConnected;
  }


  async exportData() {
    if (this.dataList.length === 0) {
      console.warn('没有数据可以导出');
      return;
    }

    // 弹出保存对话框
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
    // console.log('选中的文件夹路径：', folderPath);

    if (!folderPath) {
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
      if (this.viewMode.showHex) {
        // 转换为Hex显示
        if (Buffer.isBuffer(item.data)) {
          dataContent = Array.from(item.data)
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join(' ');
        } else {
          dataContent = Buffer.from(String(item.data)).toString('hex');
        }
      } else {
        // 文本模式
        let textData = '';
        if (Buffer.isBuffer(item.data)) {
          textData = item.data.toString();
        } else {
          textData = String(item.data);
        }

        // 控制字符处理
        if (this.viewMode.showCtrlChar) {
          // 替换常见控制字符为可见符号
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

      // 添加数据内容
      fileContent += dataContent;

      // 如果不是自动换行模式且是最后一个数据项，不添加额外换行
      if (this.viewMode.autoWrap || fileContent.endsWith('\n')) {
        // 已经有换行了
      } else {
        fileContent += '\n';
      }
    }

    // 写入文件
    this.electronService.writeFile(folderPath, fileContent);
    this.message.success('数据已成功导出到' + folderPath);
  }

  /**
   * 发送控制信号(DTR/RTS)到串口
   * @param signalType 信号类型: 'DTR' 或 'RTS'
   * @param state 信号状态: true为设置，false为清除，不传则切换当前状态
   * @returns 操作是否成功
   */
  sendSignal(signalType: 'DTR' | 'RTS', state?: boolean): Promise<boolean> {
    if (!this.isConnected || !this.serialPort) {
      this.message.warning('串口未连接，请先打开串口');
      return Promise.resolve(false);
    }
    
    return new Promise((resolve) => {
      try {
        const methodName = signalType.toLowerCase();
        // 如果没提供状态，则获取当前状态并取反
        if (state === undefined && typeof this.serialPort[methodName + 'Bool'] === 'function') {
          state = !this.serialPort[methodName + 'Bool']();
        }

        // 调用串口对象的方法设置信号
        this.serialPort.set({ [methodName]: state }, (err: any) => {
          if (err) {
            console.error(`设置${signalType}信号失败:`, err);
            this.message.error(`设置${signalType}信号失败`);
            resolve(false);
          } else {
            // 记录信号发送到数据列表
            this.dataList.push({
              time: new Date().toLocaleTimeString(),
              data: Buffer.from(`[设置${signalType}信号: ${state ? '开启' : '关闭'}]`),
              dir: 'SYS'
            });
            this.dataUpdated.next();
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

  saveQuickSendList() {
    // 保存到ConfigService中
    this.configService.data.quickSendList = this.quickSendList;
    this.configService.save();
  }

  loadQuickSendList() {
    // 从ConfigService中加载
    if (this.configService.data?.quickSendList) {
      try {
        this.quickSendList = this.configService.data.quickSendList;
      } catch (e) {
        console.error('解析快速发送列表失败:', e);
      }
    } else {
      // 如果没有数据，则使用默认值
      this.quickSendList = [
        { name: 'DTR', type: 'signal', data: 'DTR' },
        { name: 'RTS', type: 'signal', data: 'RTS' },
        { name: '发送文本', type: 'text', data: 'This is aily blockly' },
        { name: '发送Hex', type: 'hex', data: 'FF FF A1 A2 A3 A4 A5' }
      ];
    }
  }
}

export interface dataItem {
  time: string,
  data: any,
  dir: 'TX' | 'RX' | 'SYS',
  searchHighlight?: boolean,
}

export interface QuickSendItem {
  "name": string,
  "type": "signal" | "text" | "hex",
  "data": string
}