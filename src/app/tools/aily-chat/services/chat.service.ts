import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { MCPTool } from './mcp.service';
import { API } from "../../../configs/api.config";

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
export class ChatService {

  currentSessionId = '';
  currentMode = 'ask'; // 默认为代理模式

  private textSubject = new Subject<ChatTextMessage>();
  private static instance: ChatService;

  constructor(
    private http: HttpClient
  ) {
    ChatService.instance = this;
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

    // 发送后滚动到页面底部

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
    if (ChatService.instance) {
      ChatService.instance.sendTextToChat(text, options);
    } else {
      console.warn('ChatService尚未初始化');
    }
  }

  startSession(mode: string, tools: MCPTool[] | null = null): Observable<any> {
    return this.http.post(API.startSession, { session_id: this.currentSessionId, tools: tools || [], mode });
  }

  closeSession(sessionId: string) {
    return this.http.post(`${API.closeSession}/${sessionId}`, {});
  }

  streamConnect(sessionId: string, options?: any): Observable<any> {
    const messageSubject = new Subject<any>();

    fetch(`${API.streamConnect}/${sessionId}`)
      .then(async response => {
        if (!response.ok) {
          messageSubject.error(new Error(`HTTP error! Status: ${response.status}`));
          return;
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                messageSubject.next(msg);
                // console.log(msg);

                if (msg.type === 'TaskCompleted') {
                  messageSubject.complete();
                  return;
                }
              } catch (error) {
                console.error('解析JSON失败:', error, line);
              }
            }
          }

          // 处理缓冲区中剩余的内容
          if (buffer.trim()) {
            try {
              const msg = JSON.parse(buffer);
              messageSubject.next(msg);
            } catch (error) {
              console.error('解析最后的JSON失败:', error, buffer);
            }
          }

          messageSubject.complete();
        } catch (error) {
          messageSubject.error(error);
        }
      })
      .catch(error => {
        messageSubject.error(error);
      });

    return messageSubject.asObservable();
  }

  sendMessage(sessionId: string, content: string, source: string = 'user') {
    return this.http.post(`${API.sendMessage}/${sessionId}`, { content, source });
  }

  getHistory(sessionId: string) {
    return this.http.get(`${API.getHistory}/${sessionId}`);
  }

  stopSession(sessionId: string) {
    return this.http.post(`${API.stopSession}/${sessionId}`, {});
  }

  cancelTask(sessionId: string) {
    return this.http.post(`${API.cancelTask}/${sessionId}`,{});
  }
}
