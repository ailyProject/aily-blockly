import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';

export interface ChatTextOptions {
  sender?: string;
  type?: string;
  cover?: boolean;  // 是否覆盖之前的内容
  autoSend?: boolean; // 是否自动发送
}

export interface ChatTextMessage {
  text: string;
  options?: ChatTextOptions;
  timestamp?: number;
}

@Injectable({
  providedIn: 'root'
})
export class ChatCommunicationService {
  private textSubject = new Subject<ChatTextMessage>();
  private static instance: ChatCommunicationService;

  constructor() {
    // 将实例赋值给静态变量，方便全局访问
    ChatCommunicationService.instance = this;
  }

  /**
   * 发送文本到聊天组件
   * @param text 要发送的文本内容
   * @param options 发送选项，包含 sender、type、cover 等参数
   */
  sendTextToChat(text: string, options?: ChatTextOptions): void {
    // 设置默认值：cover 默认为 true
    const finalOptions: ChatTextOptions = {
      cover: true,  // 默认覆盖模式
      ...options    // 用户提供的选项会覆盖默认值
    };

    const message: ChatTextMessage = {
      text,
      options: finalOptions,
      timestamp: Date.now()
    };
    this.textSubject.next(message);
  }

  /**
   * 获取文本消息的Observable，供聊天组件订阅
   */
  getTextMessages(): Observable<ChatTextMessage> {
    return this.textSubject.asObservable();
  }

  /**
   * 静态方法，提供全局访问
   * @param text 要发送的文本内容
   * @param options 发送选项，包含 sender、type、cover 等参数
   */
  static sendToChat(text: string, options?: ChatTextOptions): void {
    if (ChatCommunicationService.instance) {
      ChatCommunicationService.instance.sendTextToChat(text, options);
    } else {
      console.warn('ChatCommunicationService 尚未初始化');
    }
  }
}
