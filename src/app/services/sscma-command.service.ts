import { Injectable } from '@angular/core';
import { Subject, Observable, BehaviorSubject } from 'rxjs';
import { ElectronService } from './electron.service';

/**
 * AT 命令服务 - 基于 Node.js serialport
 * 用于 ESP32 SSCMA 固件的运行时配置
 * 
 * 文档参考: sscma_at.md
 */
@Injectable({
  providedIn: 'root'
})
export class SSCMACommandService {
  // 串口连接状态
  public isConnected$ = new BehaviorSubject<boolean>(false);
  
  // 接收到的原始数据流（用于监控界面）
  public dataReceived$ = new Subject<{ time: string; data: string; dir: 'RX' | 'TX' }>();
  
  // 解析后的 AT 响应流
  public responseReceived$ = new Subject<AtResponse>();
  
  // 当前串口实例
  private serialPort: any = null;
  private currentPortPath: string = '';
  
  // 接收缓冲区
  private receiveBuffer = '';
  
  // 命令队列（用于同步发送）
  private commandQueue: Array<{
    command: string;
    resolve: (response: AtResponse) => void;
    reject: (error: Error) => void;
    timeout: number;
  }> = [];
  private isProcessingQueue = false;

  constructor(private electronService: ElectronService) {
    // 暴露到 window 以便调试
    try {
      (window as any).atService = this;
    } catch (e) {
      // ignore
    }
  }

  /**
   * 连接到指定串口
   * @param portPath 串口路径，如 'COM3' 或 '/dev/ttyUSB0'
   * @param baudRate 波特率，默认 921600（烧录后的正常通信速率）
   */
  async connect(portPath: string, baudRate: number = 921600): Promise<void> {
    if (this.isConnected$.value) {
      if (this.currentPortPath === portPath) {
        // console.log('[AT] 串口已连接:', portPath);
        return;
      }
      // 断开旧连接
      await this.disconnect();
    }

    return new Promise((resolve, reject) => {
      try {
        // console.log(`[AT] 连接串口: ${portPath}, 波特率: ${baudRate}`);
        
        this.serialPort = window['electronAPI'].SerialPort.create({
          path: portPath,
          baudRate: baudRate,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          autoOpen: false
        });

        // 监听打开事件
        this.serialPort.on('open', () => {
          // console.log('[AT] 串口已打开');
          this.currentPortPath = portPath;
          this.isConnected$.next(true);
          this.receiveBuffer = '';
          resolve();
        });

        // 监听数据接收
        this.serialPort.on('data', (data: any) => {
          this.handleDataReceived(data);
        });

        // 监听错误
        this.serialPort.on('error', (err: Error) => {
          console.error('[AT] 串口错误:', err);
          this.isConnected$.next(false);
        });

        // 监听关闭
        this.serialPort.on('close', () => {
          // console.log('[AT] 串口已关闭');
          this.isConnected$.next(false);
          this.serialPort = null;
          this.currentPortPath = '';
        });

        // 打开串口
        this.serialPort.open((err: Error) => {
          if (err) {
            console.error('[AT] 打开串口失败:', err);
            reject(new Error(`打开串口失败: ${err.message}`));
          }
        });
      } catch (error) {
        console.error('[AT] 连接串口异常:', error);
        reject(error);
      }
    });
  }

  /**
   * 断开串口连接
   */
  async disconnect(): Promise<void> {
    if (!this.serialPort) {
      return;
    }

    return new Promise((resolve) => {
      // console.log('[AT] 断开串口连接');
      this.serialPort.close((err: Error) => {
        if (err) {
          console.warn('[AT] 关闭串口警告:', err);
        }
        this.serialPort = null;
        this.currentPortPath = '';
        this.isConnected$.next(false);
        this.receiveBuffer = '';
        resolve();
      });
    });
  }

  /**
   * 处理接收到的数据
   */
  private handleDataReceived(data: any): void {
    let text: string;
    
    // 处理不同的数据类型
    if (typeof data === 'string') {
      // 已经是字符串 - 检查是否是逗号分隔的 ASCII 码
      if (/^\d+(,\d+)*$/.test(data)) {
        // 逗号分隔的 ASCII 码字符串，如 "72,101,108,108,111"
        const bytes = data.split(',').map(s => parseInt(s, 10));
        text = String.fromCharCode(...bytes);
        // console.log('[AT] 检测到逗号分隔的 ASCII 码，已转换');
      } else {
        text = data;
      }
    } else if (Array.isArray(data)) {
      // 数组形式的字节数据
      text = String.fromCharCode(...data);
    } else if (data && typeof data === 'object') {
      // 对象类型 - 可能是类 Buffer 对象
      const dataStr = String(data);
      if (/^\d+(,\d+)*$/.test(dataStr)) {
        // toString() 返回的是逗号分隔的 ASCII 码
        const bytes = dataStr.split(',').map(s => parseInt(s, 10));
        text = String.fromCharCode(...bytes);
        // console.log('[AT] 对象转字符串后检测到逗号分隔的 ASCII 码，已转换');
      } else {
        text = dataStr;
      }
    } else {
      // 其他情况，尝试转换
      console.warn('[AT] 未知的数据类型:', typeof data);
      text = String(data);
    }
    
    const now = new Date().toLocaleTimeString();
    
    // 调试：输出原始接收数据
    // console.log('[AT RX Raw]', {
    //   type: typeof data,
    //   isArray: Array.isArray(data),
    //   text: text,
    //   length: text.length,
    //   preview: text.substring(0, 100)
    // });
    
    // 发布原始数据事件（供监控界面使用）
    this.dataReceived$.next({
      time: now,
      data: text,
      dir: 'RX'
    });

    // 添加到缓冲区
    this.receiveBuffer += text;
    
    // 只在缓冲区较小时打印预览，避免性能问题
    if (this.receiveBuffer.length < 2000) {
      // console.log('[AT] 缓冲区当前长度:', this.receiveBuffer.length);
      // console.log('[AT] 缓冲区预览:', this.receiveBuffer);
    } else {
      // console.log('[AT] 缓冲区当前长度:', this.receiveBuffer.length, '字节 (包含大数据，不显示预览)');
    }
    
    // 尝试解析 AT 响应
    this.parseAtResponses();
  }

  /**
   * 解析 AT 响应
   * 
   * 响应格式: \r<JSON>\n
   * 示例: \r{"type":0,"name":"ID?","code":0,"data":"7e2d02cf"}\n
   * 
   * 注意：对于包含大量数据的响应（如 Base64 图片），需要支持完整的 JSON 解析
   */
  private parseAtResponses(): void {
    // 尝试多种响应格式
    // 格式1: \r{JSON}\n （标准格式）
    // 格式2: {JSON}\n （无前导 \r）
    
    let foundMatch = false;
    
    // 先尝试标准格式 \r{...}\n
    const standardPattern = /\r(\{[\s\S]*?\})\n/;
    let match = this.receiveBuffer.match(standardPattern);
    
    if (match) {
      const jsonStr = match[1];
      try {
        const response: AtResponse = JSON.parse(jsonStr);
        // console.log('[AT] 解析到响应 (标准格式), 数据长度:', jsonStr.length);
        // console.log('[AT] 响应内容:', response);
        
        // 发布解析后的响应
        this.responseReceived$.next(response);
        foundMatch = true;
        
        // 从缓冲区移除已解析的部分
        const matchEnd = match.index! + match[0].length;
        this.receiveBuffer = this.receiveBuffer.substring(matchEnd);
        // console.log('[AT] 移除已解析数据，剩余缓冲区长度:', this.receiveBuffer.length);
      } catch (error) {
        console.warn('[AT] JSON 解析失败 (标准格式):', error);
      }
    }
    
    // 如果标准格式没找到，尝试无前导 \r 的格式
    if (!foundMatch) {
      const simplePattern = /(\{[\s\S]*?\})\n/;
      match = this.receiveBuffer.match(simplePattern);
      
      if (match) {
        const jsonStr = match[1];
        try {
          const response: AtResponse = JSON.parse(jsonStr);
          // console.log('[AT] 解析到响应 (简单格式), 数据长度:', jsonStr.length);
          // console.log('[AT] 响应内容:', response);
          
          // 发布解析后的响应
          this.responseReceived$.next(response);
          foundMatch = true;
          
          // 从缓冲区移除已解析的部分
          const matchEnd = match.index! + match[0].length;
          this.receiveBuffer = this.receiveBuffer.substring(matchEnd);
          // console.log('[AT] 移除已解析数据，剩余缓冲区长度:', this.receiveBuffer.length);
        } catch (error) {
          console.warn('[AT] JSON 解析失败 (简单格式):', error);
        }
      }
    }
    
    // 清理过长的缓冲区（但要保留足够空间给大数据，如 Base64 图片）
    // Base64 图片通常在 10KB-100KB，所以保留更大的缓冲区
    const maxBufferSize = 500 * 1024; // 500KB
    if (this.receiveBuffer.length > maxBufferSize) {
      console.warn('[AT] 缓冲区过长 (' + this.receiveBuffer.length + ' 字节)，可能存在数据问题');
      // 只在找不到完整 JSON 时才清理
      if (!this.receiveBuffer.includes('{')) {
        console.warn('[AT] 缓冲区中没有 JSON 开始标记，清空缓冲区');
        this.receiveBuffer = '';
      }
    }
  }

  /**
   * 发送原始 AT 命令（不等待响应）
   * @param command AT 命令（不需要包含 \r，会自动添加）
   */
  async sendRaw(command: string): Promise<void> {
    if (!this.isConnected$.value || !this.serialPort) {
      throw new Error('串口未连接');
    }

    // 自动添加 \r 结尾
    const fullCommand = command.endsWith('\r') ? command : command + '\r';
    
    return new Promise((resolve, reject) => {
      this.serialPort.write(fullCommand, (err: Error) => {
        if (err) {
          console.error('[AT] 发送命令失败:', err);
          reject(new Error(`发送命令失败: ${err.message}`));
          return;
        }
        
        // console.log('[AT TX]', fullCommand.trim());
        
        // 发布 TX 事件
        this.dataReceived$.next({
          time: new Date().toLocaleTimeString(),
          data: fullCommand,
          dir: 'TX'
        });
        
        resolve();
      });
    });
  }

  /**
   * 发送 AT 命令并等待响应
   * @param command AT 命令（不需要包含 \r）
   * @param timeout 超时时间（毫秒），默认 3000ms
   * @returns Promise<AtResponse>
   */
  async sendCommand(command: string, timeout: number = 3000): Promise<AtResponse> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ command, resolve, reject, timeout });
      this.processCommandQueue();
    });
  }

  /**
   * 处理命令队列（确保串行执行）
   */
  private async processCommandQueue(): Promise<void> {
    if (this.isProcessingQueue || this.commandQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.commandQueue.length > 0) {
      const { command, resolve, reject, timeout } = this.commandQueue.shift()!;
      
      try {
        const response = await this.sendAndWait(command, timeout);
        resolve(response);
      } catch (error) {
        reject(error);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * 发送命令并等待响应（内部方法）
   */
  private async sendAndWait(command: string, timeout: number): Promise<AtResponse> {
    // 提取命令名称（用于匹配响应）
    const commandName = this.extractCommandName(command);
    
    return new Promise(async (resolve, reject) => {
      let timeoutHandle: any;
      let subscription: any;

      // 设置超时
      timeoutHandle = setTimeout(() => {
        if (subscription) {
          subscription.unsubscribe();
        }
        reject(new Error(`AT 命令超时: ${command}`));
      }, timeout);

      // 订阅响应
      subscription = this.responseReceived$.subscribe((response) => {
        // 匹配命令名称
        if (response.name === commandName || response.name.includes(commandName)) {
          clearTimeout(timeoutHandle);
          subscription.unsubscribe();
          resolve(response);
        }
      });

      // 发送命令
      try {
        await this.sendRaw(command);
      } catch (error) {
        clearTimeout(timeoutHandle);
        subscription.unsubscribe();
        reject(error);
      }
    });
  }

  /**
   * 提取 AT 命令名称
   * 示例:
   * - "AT+ID?" => "ID?"
   * - "AT+MODEL=2" => "MODEL"
   * - "AT+INVOKE=1,0,1" => "INVOKE"
   */
  private extractCommandName(command: string): string {
    const trimmed = command.trim().replace(/\r$/, '');
    
    // 移除 AT+ 前缀
    let name = trimmed.replace(/^AT\+/, '');
    
    // 移除参数部分
    if (name.includes('=')) {
      name = name.split('=')[0];
    }
    
    return name;
  }

  // ==================== 便捷 API（基于 AT 协议文档）====================

  /**
   * 获取设备 ID
   */
  async getDeviceId(): Promise<string> {
    const response = await this.sendCommand('AT+ID?');
    if (response.code !== 0) {
      throw new Error(`获取设备 ID 失败: code=${response.code}`);
    }
    return response.data as string;
  }

  /**
   * 获取设备名称
   */
  async getDeviceName(): Promise<string> {
    const response = await this.sendCommand('AT+NAME?');
    if (response.code !== 0) {
      throw new Error(`获取设备名称失败: code=${response.code}`);
    }
    return response.data as string;
  }

  /**
   * 获取版本信息
   */
  async getVersion(): Promise<{ at_api: string; software: string; hardware: string }> {
    const response = await this.sendCommand('AT+VER?');
    if (response.code !== 0) {
      throw new Error(`获取版本失败: code=${response.code}`);
    }
    return response.data as any;
  }

  /**
   * 获取默认传输类型（DFTTPT）
   */
  async getDefaultTransport(): Promise<number> {
    const response = await this.sendCommand('AT+DFTTPT?');
    if (response.code !== 0) {
      throw new Error(`获取默认传输类型失败: code=${response.code}`);
    }
    return Number(response.data as any);
  }

  /**
   * 设置默认传输类型（DFTTPT）
   * @param t 传输类型编号
   */
  async setDefaultTransport(t: number): Promise<number> {
    const response = await this.sendCommand(`AT+DFTTPT=${t}`);
    if (response.code !== 0) {
      throw new Error(`设置默认传输类型失败: code=${response.code}`);
    }
    return Number(response.data as any);
  }

  /**
   * 获取当前模型信息
   */
  async getCurrentModel(): Promise<ModelInfo> {
    const response = await this.sendCommand('AT+MODEL?');
    if (response.code !== 0) {
      throw new Error(`获取模型信息失败: code=${response.code}`);
    }
    return response.data as ModelInfo;
  }

  /**
   * 设置模型（通过 ID）
   */
  async setModel(modelId: number): Promise<ModelInfo> {
    const response = await this.sendCommand(`AT+MODEL=${modelId}`);
    if (response.code !== 0) {
      throw new Error(`设置模型失败: code=${response.code}`);
    }
    return response.data.model as ModelInfo;
  }

  /**
   * 获取当前传感器信息
   */
  async getCurrentSensor(): Promise<SensorInfo> {
    const response = await this.sendCommand('AT+SENSOR?');
    if (response.code !== 0) {
      throw new Error(`获取传感器信息失败: code=${response.code}`);
    }
    return response.data as SensorInfo;
  }

  /**
   * 设置传感器
   * @param sensorId 传感器 ID
   * @param enable 启用/禁用（1/0）
   * @param optId 选项 ID（分辨率等）
   */
  async setSensor(sensorId: number, enable: number, optId: number): Promise<SensorInfo> {
    const response = await this.sendCommand(`AT+SENSOR=${sensorId},${enable},${optId}`);
    if (response.code !== 0) {
      throw new Error(`设置传感器失败: code=${response.code}`);
    }
    return response.data.sensor as SensorInfo;
  }

  /**
   * 开始推理（invoke）
   * @param times 推理次数（-1 表示无限循环）
   * @param differed 是否仅在结果变化时返回（0/1）
   * @param resultOnly 是否仅返回结果（不含图像）（0/1）
   * @param onEvent 事件回调（用于接收推理结果）
   */
  async startInvoke(
    times: number = -1,
    differed: number = 0,
    resultOnly: number = 0,
    onEvent?: (event: AtResponse) => void
  ): Promise<void> {
    // 订阅事件响应
    if (onEvent) {
      const subscription = this.responseReceived$.subscribe((response) => {
        if (response.type === 1 && response.name === 'INVOKE') {
          onEvent(response);
        }
      });
      
      // 存储订阅以便后续取消
      (this as any)._invokeSubscription = subscription;
    }

    const response = await this.sendCommand(`AT+INVOKE=${times},${differed},${resultOnly}`);
    if (response.code !== 0) {
      throw new Error(`启动推理失败: code=${response.code}`);
    }
  }

  /**
   * 停止所有运行中的任务（包括推理）
   */
  async stopAllTasks(): Promise<void> {
    // 取消事件订阅
    if ((this as any)._invokeSubscription) {
      (this as any)._invokeSubscription.unsubscribe();
      (this as any)._invokeSubscription = null;
    }

    const response = await this.sendCommand('AT+BREAK');
    if (response.code !== 0) {
      console.warn('停止任务返回非零码:', response.code);
    }
  }

  /**
   * 设置分数阈值（score threshold）
   */
  async setScoreThreshold(score: number): Promise<number> {
    if (score < 0 || score > 100) {
      throw new Error('分数阈值范围: 0-100');
    }
    const response = await this.sendCommand(`AT+TSCORE=${score}`);
    if (response.code !== 0) {
      throw new Error(`设置分数阈值失败: code=${response.code}`);
    }
    return response.data as number;
  }

  /**
   * 获取分数阈值
   */
  async getScoreThreshold(): Promise<number> {
    const response = await this.sendCommand('AT+TSCORE?');
    if (response.code !== 0) {
      throw new Error(`获取分数阈值失败: code=${response.code}`);
    }
    return response.data as number;
  }

  /**
   * 设置 IoU 阈值
   */
  async setIouThreshold(iou: number): Promise<number> {
    if (iou < 0 || iou > 100) {
      throw new Error('IoU 阈值范围: 0-100');
    }
    const response = await this.sendCommand(`AT+TIOU=${iou}`);
    if (response.code !== 0) {
      throw new Error(`设置 IoU 阈值失败: code=${response.code}`);
    }
    return response.data as number;
  }

  /**
   * 获取 IoU 阈值
   */
  async getIouThreshold(): Promise<number> {
    const response = await this.sendCommand('AT+TIOU?');
    if (response.code !== 0) {
      throw new Error(`获取 IoU 阈值失败: code=${response.code}`);
    }
    return response.data as number;
  }

  /**
   * 设置 RC 启动命令（开机自动执行）
   */
  async setRcCommands(commands: string): Promise<void> {
    const response = await this.sendCommand(`AT+RC="${commands}"`);
    if (response.code !== 0) {
      throw new Error(`设置 RC 命令失败: code=${response.code}`);
    }
  }

  /**
   * 获取 RC 启动命令
   */
  async getRcCommands(): Promise<string> {
    const response = await this.sendCommand('AT+RC?');
    if (response.code !== 0) {
      throw new Error(`获取 RC 命令失败: code=${response.code}`);
    }
    return (response.data as any).rc;
  }

  /**
   * 重启设备
   */
  async reboot(): Promise<void> {
    await this.sendRaw('AT+RST');
    // 重启后断开连接
    await this.disconnect();
  }
}

// ==================== 类型定义 ====================

/**
 * AT 响应结构
 */
export interface AtResponse {
  type: number;      // 0: Operation, 1: Event, 2: Logging
  name: string;      // 命令名称
  code: number;      // 响应码（0=成功）
  data: any;         // 响应数据
}

/**
 * 模型信息
 */
export interface ModelInfo {
  id: number;
  type: number;      // AlgorithmType
  address: number;
  size: number;
}

/**
 * 传感器信息
 */
export interface SensorInfo {
  id: number;
  type: number;      // SensorType
  state: number;     // 0: Unknown, 1: Registered, 2: Available, 3: Locked
  opt_id?: number;
  opt_detail?: string;
}

/**
 * 推理结果数据
 */
export interface InvokeResultData {
  count: number;     // 帧计数
  perf?: number[];   // [preprocess_ms, run_ms, postprocess_ms]
  boxes?: number[][]; // [[x, y, w, h, score, target_id], ...]
  points?: number[][]; // [[x, y, score, target_id], ...]
  classes?: number[][]; // [[score, target_id], ...]
  image?: string;    // Base64 JPEG（如果 resultOnly=0）
}
