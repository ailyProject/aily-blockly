import { Injectable } from '@angular/core';
import { ESPLoader, Transport } from 'esptool-js';
// encode 已不再需要，AT 命令由 AtCommandService 处理
// import { encode } from 'js-base64';

/**
 * 烧录进度回调
 */
export interface FlashProgressCallback {
  (fileIndex: number, written: number, total: number): void;
}

/**
 * 烧录文件
 */
export interface FlashFile {
  data: string;  // 文件数据（二进制字符串）
  address: number;  // 烧录地址
}

/**
 * 烧录选项
 */
export interface FlashOptions {
  fileArray: FlashFile[];
  flashSize?: string;
  eraseAll?: boolean;
  compress?: boolean;
  reportProgress?: FlashProgressCallback;
}

/**
 * 模型信息
 */
export interface ModelInfo {
  model_id: string;
  version: string;
  arguments: any;
  model_name: string;
  model_format: string;
  ai_framwork: string;
  author: string;
  classes: string[];
  checksum: string;
}

/**
 * 终端日志处理器
 */
export interface TerminalHandler {
  write: (text: string) => void;
  writeLine: (text: string) => void;
  clean?: () => void;  // 清空终端（可选）
}

/**
 * ESPLoader 服务 - 用于 ESP32 设备的固件烧录
 */
@Injectable({
  providedIn: 'root'
})
export class EspLoaderService {
  private esploader: ESPLoader | null = null;
  private transport: Transport | null = null;
  private serialPort: any = null;
  private terminalHandler: TerminalHandler | null = null;
  private isCancelled = false;  // 取消标志

  constructor() { }

  /**
   * 初始化 ESPLoader
   * @param baudrate 波特率，默认 115200
   * @param terminalHandler 终端处理器（可选）
   * @returns Promise<boolean>
   */
  async initialize(baudrate: number = 115200, terminalHandler?: TerminalHandler): Promise<boolean> {
    try {
      // 请求串口权限
      if (!this.serialPort) {
        this.serialPort = await (navigator as any).serial.requestPort({
          filters: [
            { usbVendorId: 0x303a, usbProductId: 0x1001 }  // XIAO ESP32S3
          ]
        });
      }

      // 创建传输对象
      this.transport = new Transport(this.serialPort);
      this.terminalHandler = terminalHandler || this.createDefaultTerminal();

      // 创建 ESPLoader
      this.esploader = new ESPLoader({
        transport: this.transport,
        baudrate: baudrate,
        romBaudrate: 115200,
        terminal: this.createESPLoaderTerminal(),
      });

      // 初始化连接
      console.log('正在连接设备...');
      await this.esploader.connect();
      console.log('设备连接成功');

      return true;
    } catch (error) {
      console.error('初始化 ESPLoader 失败:', error);
      return false;
    }
  }

  /**
   * 使用已存在的串口初始化
   * @param serialPort 串口对象（Web Serial API 兼容）
   * @param baudrate 波特率
   * @param terminalHandler 终端处理器
   * @returns Promise<boolean>
   */
  async initializeWithPort(
    serialPort: any,
    baudrate: number = 115200,
    terminalHandler?: TerminalHandler
  ): Promise<boolean> {
    try {
      this.serialPort = serialPort;
      this.terminalHandler = terminalHandler || this.createDefaultTerminal();
      
      // 创建 Transport（第二个参数 true 启用调试追踪）
      this.transport = new Transport(this.serialPort, true);
      
      // 创建 ESPLoader
      this.esploader = new ESPLoader({
        transport: this.transport,
        baudrate: baudrate,
        romBaudrate: 115200,
        terminal: this.createESPLoaderTerminal(),
      });

      // 初始化设备并获取芯片信息
      const chip = await this.esploader.main();
      console.log('设备初始化成功，芯片类型:', chip);
      
      return true;
    } catch (error) {
      console.error('[ESPLoader] 初始化失败:', error);
      return false;
    }
  }

  /**
   * 请求取消当前烧录操作
   */
  requestCancel(): void {
    console.log('[ESPLoader] 收到取消请求');
    this.isCancelled = true;
  }

  /**
   * 重置取消标志
   */
  resetCancelFlag(): void {
    this.isCancelled = false;
  }

  /**
   * 检查是否已取消
   */
  isCancelRequested(): boolean {
    return this.isCancelled;
  }

  /**
   * 烧录固件和模型文件
   * @param options 烧录选项
   * @returns Promise<boolean>
   */
  async flash(options: FlashOptions): Promise<boolean> {
    if (!this.esploader) {
      console.error('ESPLoader 未初始化');
      return false;
    }

    // 重置取消标志
    this.resetCancelFlag();

    try {
      const originalProgressCallback = options.reportProgress;
      
      const flashOptions = {
        fileArray: options.fileArray,
        flashSize: options.flashSize || 'keep',
        flashMode: 'dio',
        flashFreq: '80m',
        eraseAll: options.eraseAll || false,
        compress: options.compress !== false,
        reportProgress: (fileIndex: number, written: number, total: number) => {
          // 检查是否被取消
          if (this.isCancelled) {
            console.log('[ESPLoader] 检测到取消请求，中断烧录');
            throw new Error('用户取消烧录');
          }
          
          // 调用原始进度回调
          if (originalProgressCallback) {
            originalProgressCallback(fileIndex, written, total);
          } else {
            const progress = ((written / total) * 100).toFixed(2);
            console.log(`文件 ${fileIndex + 1} 烧录进度: ${progress}%`);
          }
        },
      };

      await this.esploader.writeFlash(flashOptions);
      return true;
    } catch (error) {
      // 区分用户取消和其他错误
      if (this.isCancelled || (error as Error).message?.includes('用户取消')) {
        console.log('[ESPLoader] 烧录已取消');
        throw new Error('用户取消烧录');
      }
      console.error('烧录失败:', error);
      return false;
    }
  }

  /**
   * 重启设备
   * @param delayMs 重启后等待时间（毫秒）
   * @returns Promise<void>
   */
  async resetDevice(delayMs: number = 3000): Promise<void> {
    if (!this.transport) {
      console.error('传输对象不存在');
      return;
    }

    try {
      await this.transport.setDTR(false);
      await this.delay(100);
      await this.transport.setDTR(true);
      await this.delay(delayMs);
    } catch (error) {
      console.error('重启设备失败:', error);
    }
  }

  // 注意: writeCommand 和 setModelInfo 方法已移除
  // 现在使用 AtCommandService 来发送 AT 命令，避免 SLIP 协议包装问题

  /**
   * 断开 ESPLoader 和 Transport，但保留串口对象
   * @returns Promise<void>
   */
  async disconnectWithoutClosingPort(): Promise<void> {
    try {
      if (this.transport) {
        // 完全断开 Transport（释放所有锁，但不调用 device.close()）
        const transport = this.transport as any;
        
        // 取消并释放 reader
        if (transport.reader) {
          try {
            await transport.reader.cancel();
          } catch (e) {
            console.warn('取消 reader 失败:', e);
          }
          transport.reader = undefined;
        }
        
        // 等待串口解锁
        if (transport.device && transport.waitForUnlock) {
          try {
            await transport.waitForUnlock(400);
          } catch (e) {
            console.warn('等待串口解锁失败:', e);
          }
        }
      }
      
      // 清理 ESPLoader 和 Transport 引用，但保留 serialPort
      this.esploader = null;
      this.transport = null;
      console.log('已断开 ESPLoader 和 Transport（串口保持打开）');
    } catch (error) {
      console.error('断开失败:', error);
    }
  }

  /**
   * 断开连接
   * @returns Promise<void>
   */
  async disconnect(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.disconnect();
        console.log('已断开连接');
      }
      this.esploader = null;
      this.transport = null;
    } catch (error) {
      console.error('断开连接失败:', error);
    }
  }

  /**
   * 获取设备信息
   * @returns 设备芯片类型
   */
  getChipType(): string {
    if (!this.esploader) return 'Unknown';
    return (this.esploader as any).chip?.CHIP_NAME || 'Unknown';
  }

  /**
   * 获取当前串口对象（用于 AT 命令服务）
   * @returns 串口对象或 null
   */
  getSerialPort(): any {
    return this.serialPort;
  }

  /**
   * 创建默认终端处理器
   * @returns TerminalHandler
   */
  private createDefaultTerminal(): TerminalHandler {
    return {
      write: (text: string) => console.log(text),
      writeLine: (text: string) => console.log(text),
      clean: () => { /* 清空终端 */ }
    };
  }

  /**
   * 创建 ESPLoader 终端适配器
   * @returns ESPLoader 终端对象
   */
  private createESPLoaderTerminal(): any {
    return {
      write: (text: string) => {
        if (this.terminalHandler) {
          this.terminalHandler.write(text);
        }
      },
      writeLine: (text: string) => {
        if (this.terminalHandler) {
          this.terminalHandler.writeLine(text);
        }
      },
      clean: () => {
        if (this.terminalHandler && this.terminalHandler.clean) {
          this.terminalHandler.clean();
        }
      }
    };
  }

  /**
   * 延迟函数
   * @param ms 毫秒数
   * @returns Promise<void>
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
