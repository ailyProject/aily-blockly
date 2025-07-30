import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';

import { API } from "../../../configs/api.config";

@Injectable({
  providedIn: 'root'
})
export class ChatService {

  currentSessionId = '';

  constructor(
    private http: HttpClient
  ) { }

  startSession() {
    return this.http.post(API.startSession, {session_id: this.currentSessionId});
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

  sendMessage(sessionId: string, content: string) {
    return this.http.post(`${API.sendMessage}/${sessionId}`, { content });
  }

  getHistory(sessionId: string) {
    return this.http.get(`${API.getHistory}/${sessionId}`);
  }
}
