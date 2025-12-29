import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { Buffer } from 'buffer';
import { PenpalService } from '../penpal/penpal.service';
import { DataItem, SerialConfig } from '../penpal/types';

/**
 * Electron SerialPort API 接口
 */
interface ElectronSerialPort {
  write(data: any, callback?: (err: Error | null) => void): void;
  open(callback?: (err: Error | null) => void): void;
  close(callback?: (err: Error | null) => void): void;
  on(event: string, callback: (...args: any[]) => void): any;
  off(event: string, callback: (...args: any[]) => void): any;
  set(options: any, callback?: (err: Error | null) => void): void;
  dtrBool(): boolean;
  rtsBool(): boolean;
  path: string;
  isOpen: boolean;
}

/**
 * 串口管理服务
 * 
 * 子应用内部的串口管理，直接使用 Electron SerialPort API
 * 不再依赖主程序的业务方法
 */
@Injectable({
  providedIn: 'root'
})
export class SerialPortService {
  private port: ElectronSerialPort | null = null;
  
  /** 连接状态 */
  connectionStatus = new BehaviorSubject<boolean>(false);
  
  /** 接收到的数据 */
  dataReceived = new Subject<DataItem>();
  
  /** 当前配置 */
  private currentConfig: SerialConfig | null = null;
  
  /** 输入模式设置 */
  inputMode = {
    hexMode: false,
    endR: true,
    endN: true,
  };

  constructor(private penpalService: PenpalService) {}

  /**
   * 获取 Electron SerialPort API
   */
  private getElectronAPI(): any {
    // 尝试直接从 window 获取（iframe 内可能也能访问）
    if ((window as any).electronAPI?.SerialPort) {
      return (window as any).electronAPI.SerialPort;
    }
    // 通过 top window 获取（如果 iframe 受限）
    if ((window.top as any)?.electronAPI?.SerialPort) {
      return (window.top as any).electronAPI.SerialPort;
    }
    return null;
  }

  /**
   * 获取可用串口列表
   */
  async getPortsList(): Promise<any[]> {
    const api = this.getElectronAPI();
    if (api) {
      try {
        const list = await api.list();
        return this.processPortList(list);
      } catch (error) {
        console.error('[SerialPortService] Failed to list ports:', error);
      }
    }
    
    // 回退到父窗口方法
    try {
      return await this.penpalService.getSerialPorts();
    } catch (error) {
      console.error('[SerialPortService] Fallback also failed:', error);
      return [];
    }
  }

  /**
   * 处理串口列表格式
   */
  private processPortList(list: any[]): any[] {
    return list.map(port => ({
      name: port.path,
      text: port.friendlyName || port.manufacturer || port.path,
      type: port.serialNumber ? 'usb' : 'serial',
      icon: 'usb',
      disabled: false
    }));
  }

  /**
   * 连接串口
   */
  async connect(config: SerialConfig): Promise<boolean> {
    // 如果已连接，先断开
    if (this.port && this.port.isOpen) {
      await this.disconnect();
    }

    try {
      const api = this.getElectronAPI();
      if (!api) {
        await this.penpalService.showMessage('error', '无法访问串口 API');
        return false;
      }

      // 创建串口实例
      this.port = api.create({
        path: config.path,
        baudRate: config.baudRate,
        dataBits: config.dataBits || 8,
        stopBits: config.stopBits || 1,
        parity: config.parity || 'none',
        autoOpen: false
      });

      // 绑定事件
      this.setupEventHandlers();

      // 打开串口
      return new Promise((resolve) => {
        this.port!.open((err: Error | null) => {
          if (err) {
            console.error('[SerialPortService] Open error:', err);
            this.addSystemMessage(`连接失败: ${err.message}`);
            resolve(false);
          } else {
            this.currentConfig = config;
            this.connectionStatus.next(true);
            this.addSystemMessage(`已连接到 ${config.path}`);
            resolve(true);
          }
        });
      });
    } catch (error: any) {
      console.error('[SerialPortService] Connect error:', error);
      await this.penpalService.showMessage('error', `连接失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    if (!this.port) return;

    this.port.on('data', (data: Buffer) => {
      this.handleData(data);
    });

    this.port.on('error', (err: Error) => {
      console.error('[SerialPortService] Port error:', err);
      this.addSystemMessage(`错误: ${err.message}`);
    });

    this.port.on('close', () => {
      this.connectionStatus.next(false);
      this.addSystemMessage('串口已关闭');
    });
  }

  /**
   * 处理接收的数据
   */
  private handleData(data: Buffer): void {
    const item: DataItem = {
      time: this.formatTime(new Date()),
      data: data,
      dir: 'RX'
    };
    this.dataReceived.next(item);
  }

  /**
   * 添加系统消息
   */
  private addSystemMessage(message: string): void {
    const item: DataItem = {
      time: this.formatTime(new Date()),
      data: message,
      dir: 'SYS'
    };
    this.dataReceived.next(item);
  }

  /**
   * 格式化时间
   */
  private formatTime(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${date.getMilliseconds().toString().padStart(3, '0')}`;
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<boolean> {
    if (!this.port) return true;

    return new Promise((resolve) => {
      if (!this.port!.isOpen) {
        this.port = null;
        this.connectionStatus.next(false);
        resolve(true);
        return;
      }

      this.port!.close((err: Error | null) => {
        if (err) {
          console.error('[SerialPortService] Close error:', err);
        }
        this.port = null;
        this.connectionStatus.next(false);
        resolve(!err);
      });
    });
  }

  /**
   * 发送数据
   */
  async sendData(data: string, mode = 'text', ignoreEnd = false): Promise<boolean> {
    if (!this.port || !this.port.isOpen) {
      await this.penpalService.showMessage('warning', '串口未连接');
      return false;
    }

    try {
      let buffer: Buffer;

      if (mode === 'hex' || this.inputMode.hexMode) {
        // Hex 模式
        const hexStr = data.replace(/\s+/g, '');
        buffer = Buffer.from(hexStr, 'hex');
      } else {
        // 文本模式
        let sendStr = data;
        if (!ignoreEnd) {
          if (this.inputMode.endR) sendStr += '\r';
          if (this.inputMode.endN) sendStr += '\n';
        }
        buffer = Buffer.from(sendStr);
      }

      return new Promise((resolve) => {
        this.port!.write(buffer, (err: Error | null) => {
          if (err) {
            console.error('[SerialPortService] Write error:', err);
            resolve(false);
          } else {
            // 记录发送的数据
            const item: DataItem = {
              time: this.formatTime(new Date()),
              data: buffer,
              dir: 'TX'
            };
            this.dataReceived.next(item);
            resolve(true);
          }
        });
      });
    } catch (error: any) {
      console.error('[SerialPortService] Send error:', error);
      return false;
    }
  }

  /**
   * 发送控制信号 (DTR/RTS)
   */
  async sendSignal(signalType: 'DTR' | 'RTS', state?: boolean): Promise<boolean> {
    if (!this.port || !this.port.isOpen) {
      return false;
    }

    try {
      // 如果未指定状态，则切换当前状态
      let newState = state;
      if (newState === undefined) {
        if (signalType === 'DTR') {
          newState = !this.port.dtrBool();
        } else {
          newState = !this.port.rtsBool();
        }
      }

      return new Promise((resolve) => {
        const options = signalType === 'DTR' 
          ? { dtr: newState } 
          : { rts: newState };
          
        this.port!.set(options, (err: Error | null) => {
          if (err) {
            console.error(`[SerialPortService] Set ${signalType} error:`, err);
            resolve(false);
          } else {
            this.addSystemMessage(`${signalType} ${newState ? 'ON' : 'OFF'}`);
            resolve(true);
          }
        });
      });
    } catch (error) {
      console.error(`[SerialPortService] Send signal error:`, error);
      return false;
    }
  }

  /**
   * 获取当前是否已连接
   */
  get isConnected(): boolean {
    return this.port?.isOpen || false;
  }

  /**
   * 获取当前串口路径
   */
  get currentPath(): string | null {
    return this.port?.path || null;
  }
}
