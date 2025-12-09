import { Injectable } from '@angular/core';
import { Subject, fromEvent } from 'rxjs';
import { filter, map } from 'rxjs/operators';

export interface IframeMessage {
  type: string;
  action?: string;
  data?: any;
  requestId?: string;
}

/**
 * 主应用侧的 iframe 桥接服务
 * 用于与 iframe 中的子应用通信
 */
@Injectable({
  providedIn: 'root'
})
export class IframeBridgeService {
  private iframeRef: HTMLIFrameElement | null = null;
  private messageSubject = new Subject<IframeMessage>();
  
  // 响应回调映射
  private responseCallbacks = new Map<string, (data: any) => void>();
  private requestIdCounter = 0;

  constructor() {
    // 监听来自 iframe 的消息
    fromEvent<MessageEvent>(window, 'message')
      .pipe(
        filter(event => this.isValidMessage(event)),
        map(event => event.data as IframeMessage)
      )
      .subscribe(message => {
        this.handleMessage(message);
      });
  }

  /**
   * 设置 iframe 引用
   */
  setIframeRef(iframe: HTMLIFrameElement) {
    this.iframeRef = iframe;
  }

  /**
   * 发送消息到 iframe
   */
  sendMessage(message: IframeMessage): void {
    if (!this.iframeRef || !this.iframeRef.contentWindow) {
      console.error('Iframe not ready');
      return;
    }

    this.iframeRef.contentWindow.postMessage(message, '*');
  }

  /**
   * 发送请求并等待响应
   */
  sendRequest<T>(type: string, data?: any): Promise<T> {
    return new Promise((resolve, reject) => {
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
      }, 30000); // 30秒超时

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
   * 处理收到的消息
   */
  private handleMessage(message: IframeMessage) {
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
    // 在生产环境应该检查 event.origin
    // if (event.origin !== 'http://localhost:4201') return false;
    
    return event.data && typeof event.data === 'object' && 'type' in event.data;
  }

  /**
   * 通知项目数据更新
   */
  notifyProjectUpdate(projectData: any) {
    this.sendMessage({
      type: 'PROJECT_UPDATE',
      data: projectData
    });
  }

  /**
   * 通知串口连接状态变化
   */
  notifySerialStatus(connected: boolean, port?: string) {
    this.sendMessage({
      type: 'SERIAL_STATUS',
      data: { connected, port }
    });
  }

  /**
   * 转发串口数据
   */
  forwardSerialData(data: any) {
    this.sendMessage({
      type: 'SERIAL_DATA',
      data
    });
  }
}
