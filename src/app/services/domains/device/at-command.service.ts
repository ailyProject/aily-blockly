import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * AT 命令服务 - 用于通过 Web Serial API 发送和接收 AT 命令
 * 适用于 ESP32 设备的运行时配置（非烧录模式）
 */
@Injectable({
  providedIn: 'root'
})
export class AtCommandService {
  private serialPort: any = null;
  private reader: ReadableStreamDefaultReader | null = null;
  private writer: WritableStreamDefaultWriter | null = null;
  private isReading = false;
  
  // 接收到的数据事件流
  public dataReceived = new Subject<{ time: string; data: string; dir: 'RX' | 'TX' }>();
  
  // 接收到的数据缓冲（用于解析响应）
  private receiveBuffer = '';

  constructor() {
    // 暴露到 window 以便在 DevTools 中快速访问（仅用于调试）
    try {
      (window as any).atCommandService = this;
    } catch (e) {
      // 在非浏览器环境忽略
    }
  }

  /**
   * 绑定到现有的 Web Serial Port（从 ESPLoader 传入）
   * @param serialPort Web Serial API 的串口对象
   * @param baudRate 波特率（默认 921600）
   */
  async attachToPort(serialPort: any, baudRate: number = 921600): Promise<void> {
    if (this.isReading) {
      console.warn('AT 命令服务已绑定到串口');
      return;
    }

    this.serialPort = serialPort;
    this.receiveBuffer = '';
    
    // 如果串口未打开，先打开它
    if (!this.serialPort.readable || !this.serialPort.writable) {
      console.log('[AT] 打开串口，波特率:', baudRate);
      await this.serialPort.open({ baudRate });
    }
    
    // 启动读取循环
    this.startReading();
  }

  /**
   * 发送 AT 命令（原始字节，不会被 SLIP 封装）
   * @param command AT 命令字符串（需包含行尾符，如 \r\n）
   * @returns Promise<void>
   */
  async sendCommand(command: string): Promise<void> {
    if (!this.serialPort?.writable) {
      throw new Error('串口未连接或不可写');
    }

    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(command);
      
      // 获取写入器并写入
      this.writer = this.serialPort.writable.getWriter();
      await this.writer.write(data);
      this.writer.releaseLock();
      this.writer = null;
      
      // 发布 TX 事件
      this.dataReceived.next({
        time: new Date().toLocaleTimeString(),
        data: command,
        dir: 'TX'
      });
      
      console.log('[AT TX]', command.trim());
    } catch (error) {
      if (this.writer) {
        try {
          this.writer.releaseLock();
        } catch (e) {
          // ignore
        }
        this.writer = null;
      }
      console.error('发送 AT 命令失败:', error);
      throw error;
    }
  }

  /**
   * 启动读取循环
   */
  private async startReading(): Promise<void> {
    if (!this.serialPort?.readable || this.isReading) {
      return;
    }

    this.isReading = true;
    
    try {
      this.reader = this.serialPort.readable.getReader();
      const decoder = new TextDecoder();
      
      while (this.isReading) {
        const { value, done } = await this.reader.read();
        
        if (done) {
          break;
        }
        
        // 解码接收到的数据
        const text = decoder.decode(value, { stream: true });
        this.receiveBuffer += text;
        
        // 发布 RX 事件
        this.dataReceived.next({
          time: new Date().toLocaleTimeString(),
          data: text,
          dir: 'RX'
        });
        
        console.log('[AT RX]', text);
      }
    } catch (error) {
      if (error.name !== 'NetworkError') {
        console.error('读取串口数据失败:', error);
      }
    } finally {
      if (this.reader) {
        try {
          this.reader.releaseLock();
        } catch (e) {
          // ignore
        }
        this.reader = null;
      }
      this.isReading = false;
    }
  }

  /**
   * 等待接收到包含指定文本的响应（简单实现）
   * @param expectedText 期望的响应文本（部分匹配）
   * @param timeoutMs 超时时间（毫秒）
   * @returns Promise<boolean> 是否收到期望的响应
   */
  async waitForResponse(expectedText: string, timeoutMs: number = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      
      const subscription = this.dataReceived.subscribe(item => {
        if (item.dir === 'RX' && item.data.includes(expectedText)) {
          subscription.unsubscribe();
          resolve(true);
        }
      });
      
      // 超时处理
      const timeout = setTimeout(() => {
        subscription.unsubscribe();
        resolve(false);
      }, timeoutMs);
      
      // 清理
      subscription.add(() => clearTimeout(timeout));
    });
  }

  /**
   * 获取接收缓冲区内容（用于调试）
   */
  getReceiveBuffer(): string {
    return this.receiveBuffer;
  }

  /**
   * 清空接收缓冲区
   */
  clearReceiveBuffer(): void {
    this.receiveBuffer = '';
  }

  /**
   * 停止读取并解绑串口
   */
  async detach(): Promise<void> {
    this.isReading = false;
    
    if (this.reader) {
      try {
        await this.reader.cancel();
        this.reader.releaseLock();
      } catch (e) {
        // ignore
      }
      this.reader = null;
    }
    
    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch (e) {
        // ignore
      }
      this.writer = null;
    }
    
    this.serialPort = null;
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.serialPort !== null && this.isReading;
  }
}
