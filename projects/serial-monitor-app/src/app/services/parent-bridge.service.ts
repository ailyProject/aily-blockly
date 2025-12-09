import { Injectable } from '@angular/core';
import { Subject, fromEvent } from 'rxjs';
import { filter, map } from 'rxjs/operators';

export interface ParentMessage {
  type: string;
  action?: string;
  data?: any;
  requestId?: string;
}

/**
 * 子应用侧的父窗口桥接服务
 * 用于与父窗口(主应用)通信
 */
@Injectable({
  providedIn: 'root'
})
export class ParentBridgeService {
  private messageSubject = new Subject<ParentMessage>();
  private responseCallbacks = new Map<string, (data: any) => void>();
  private requestIdCounter = 0;
  
  // 判断是否在 iframe 中运行
  public readonly isInIframe = window.self !== window.top;

  constructor() {
    // 监听来自父窗口的消息
    fromEvent<MessageEvent>(window, 'message')
      .pipe(
        filter(event => this.isValidMessage(event)),
        map(event => event.data as ParentMessage)
      )
      .subscribe(message => {
        this.handleMessage(message);
      });

    // 通知父窗口子应用已准备好
    if (this.isInIframe) {
      this.sendReady();
    }
  }

  /**
   * 发送消息到父窗口
   */
  sendMessage(message: ParentMessage): void {
    if (!this.isInIframe) {
      console.warn('Not running in iframe, message not sent');
      return;
    }

    window.parent.postMessage(message, '*');
  }

  /**
   * 发送请求并等待响应
   */
  sendRequest<T>(type: string, data?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.isInIframe) {
        reject(new Error('Not running in iframe'));
        return;
      }

      const requestId = `req_${++this.requestIdCounter}_${Date.now()}`;
      
      // 注册回调
      this.responseCallbacks.set(requestId, (responseData) => {
        resolve(responseData);
      });

      // 设置超时
      setTimeout(() => {
        if (this.responseCallbacks.has(requestId)) {
          this.responseCallbacks.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 30000);

      // 发送消息
      this.sendMessage({ type, data, requestId });
    });
  }

  /**
   * 监听特定类型的消息
   */
  onMessage(type: string) {
    return this.messageSubject.pipe(
      filter(msg => msg.type === type)
    );
  }

  /**
   * 发送就绪通知
   */
  private sendReady() {
    this.sendMessage({
      type: 'IFRAME_READY'
    });
  }

  /**
   * 处理收到的消息
   */
  private handleMessage(message: ParentMessage) {
    // 如果是响应消息
    if (message.requestId && this.responseCallbacks.has(message.requestId)) {
      const callback = this.responseCallbacks.get(message.requestId)!;
      callback(message.data);
      this.responseCallbacks.delete(message.requestId);
      return;
    }

    // 普通消息,发送到订阅者
    this.messageSubject.next(message);
  }

  /**
   * 验证消息来源
   */
  private isValidMessage(event: MessageEvent): boolean {
    // 检查消息是否来自父窗口
    if (!this.isInIframe) return false;
    
    return event.data && typeof event.data === 'object' && 'type' in event.data;
  }

  // ============= 串口相关 API =============

  /**
   * 请求获取串口列表
   */
  async getSerialPorts(): Promise<any[]> {
    return this.sendRequest('SERIAL_REQUEST', {
      action: 'list'
    });
  }

  /**
   * 请求连接串口
   */
  async connectSerial(options: {
    path: string;
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
    flowControl?: string;
  }): Promise<boolean> {
    return this.sendRequest('SERIAL_REQUEST', {
      action: 'connect',
      options
    });
  }

  /**
   * 请求断开串口
   */
  async disconnectSerial(): Promise<boolean> {
    return this.sendRequest('SERIAL_REQUEST', {
      action: 'disconnect'
    });
  }

  /**
   * 发送串口数据
   */
  async sendSerialData(data: string | Buffer): Promise<boolean> {
    return this.sendRequest('SERIAL_REQUEST', {
      action: 'send',
      data
    });
  }

  /**
   * 监听串口数据
   */
  onSerialData() {
    return this.onMessage('SERIAL_DATA');
  }

  /**
   * 监听串口状态变化
   */
  onSerialStatus() {
    return this.onMessage('SERIAL_STATUS');
  }

  /**
   * 监听项目数据更新
   */
  onProjectUpdate() {
    return this.onMessage('PROJECT_UPDATE');
  }

  // ============= 通用 API =============

  /**
   * 请求关闭窗口
   */
  requestClose() {
    this.sendMessage({
      type: 'REQUEST_CLOSE'
    });
  }

  /**
   * 通知错误
   */
  notifyError(error: string) {
    this.sendMessage({
      type: 'ERROR',
      data: { error }
    });
  }

  /**
   * 请求主应用的服务数据
   */
  async requestServiceData(serviceName: string, method: string, params?: any): Promise<any> {
    return this.sendRequest('SERVICE_REQUEST', {
      service: serviceName,
      method,
      params
    });
  }
}
