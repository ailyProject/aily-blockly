import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { MCPTool } from './mcp.service';
import { API } from "../../../configs/api.config";
import { ConfigService } from '../../../services/config.service';
import { AilyChatConfigService } from './aily-chat-config.service';

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

// 模型配置接口
export interface ModelConfig {
  model: string;
  family: string;
  name: string;
  speed: string;
}

// 可用模型列表
export const AVAILABLE_MODELS: ModelConfig[] = [
  { model: 'glm-4.7', family: 'glm', name: 'GLM-4.7', speed: '1x' },
  { model: 'glm-4.6', family: 'glm', name: 'GLM-4.6', speed: '1x' }
];

@Injectable({
  providedIn: 'root'
})
export class ChatService {

  currentMode = 'ask'; // 默认为代理模式
  currentModel: ModelConfig | null = null; // 当前模型，在构造函数中初始化
  historyList = [];
  historyChatMap = new Map<string, any>();

  currentSessionId = this.historyList.length > 0 ? this.historyList[0].sessionId : '';
  currentSessionTitle = this.historyList.length > 0 ? this.historyList[0].name : '';
  
  // 记录当前会话创建时的项目路径，用于确保历史记录保存到正确位置
  currentSessionPath = '';

  titleIsGenerating = false;

  private textSubject = new Subject<ChatTextMessage>();
  private static instance: ChatService;

  constructor(
    private http: HttpClient,
    private configService: ConfigService,
    private ailyChatConfigService: AilyChatConfigService
  ) {
    ChatService.instance = this;
    // 从配置加载AI聊天模式
    this.loadChatMode();
    // 从配置加载AI模型
    this.loadChatModel();
    
    // 订阅配置变更，当模型列表更新时重新加载
    this.ailyChatConfigService.configChanged$.subscribe(() => {
      this.loadChatModel();
    });
  }

  /**
   * 从配置加载AI聊天模式
   */
  private loadChatMode(): void {
    if (this.configService.data.aiChatMode) {
      this.currentMode = this.configService.data.aiChatMode;
    }
  }

  /**
   * 保存AI聊天模式到配置
   */
  saveChatMode(mode: 'agent' | 'ask'): void {
    this.currentMode = mode;
    this.configService.data.aiChatMode = mode;
    this.configService.save();
  }

  /**
   * 从配置加载AI模型
   */
  private loadChatModel(): void {
    const savedModel = this.configService.data.aiChatModel;
    const enabledModels = this.ailyChatConfigService.getEnabledModels();
    
    // 重置当前模型，确保每次都重新验证
    this.currentModel = null;
    
    if (savedModel && enabledModels.length > 0) {
      // 尝试找到匹配的模型配置（从已启用的模型中查找）
      const foundModel = enabledModels.find(m => m.model === savedModel.model);
      if (foundModel) {
        this.currentModel = foundModel;
      }
    }
    
    // 如果没有找到保存的模型或保存的模型不可用（如自定义模型但未启用自定义API KEY），使用第一个已启用的模型
    if (!this.currentModel && enabledModels.length > 0) {
      this.currentModel = enabledModels[0];
      // 更新保存的模型配置
      this.saveChatModel(this.currentModel);
    }
  }

  /**
   * 保存AI模型到配置
   */
  saveChatModel(model: ModelConfig): void {
    this.currentModel = model;
    this.configService.data.aiChatModel = model;
    this.configService.save();
  }

  // 打开.history
  openHistoryFile(prjPath: string) {
    // 打开项目下的.chat_history/.chat文件
    this.ensureChatHistoryFolder(prjPath);
    const historyPath = this.getChatHistoryFolderPath(prjPath) + '/.chat';
    if (window['fs'].existsSync(historyPath)) {
      this.historyList = JSON.parse(window['fs'].readFileSync(historyPath, 'utf-8'));
    } else {
      // 如果历史文件不存在，清空历史列表
      this.historyList = [];
    }
  }

  // 保存.history
  saveHistoryFile(prjPath: string) {
    // 保存项目下的.chat_history/.chat文件
    this.ensureChatHistoryFolder(prjPath);
    const historyPath = this.getChatHistoryFolderPath(prjPath) + '/.chat';
    window['fs'].writeFileSync(historyPath, JSON.stringify(this.historyList, null, 2), 'utf-8');
  }

  /**
   * 获取 .chat_history 文件夹路径
   * @param prjPath 项目路径
   * @returns .chat_history 文件夹的完整路径
   */
  private getChatHistoryFolderPath(prjPath: string): string {
    return prjPath + '/.chat_history';
  }

  /**
   * 获取会话历史记录文件路径
   * @param prjPath 项目路径
   * @param sessionId 会话ID
   * @returns 会话历史记录文件的完整路径
   */
  private getSessionHistoryFilePath(prjPath: string, sessionId: string): string {
    return this.getChatHistoryFolderPath(prjPath) + '/' + sessionId + '.json';
  }

  /**
   * 确保 .chat_history 文件夹存在
   * @param prjPath 项目路径
   */
  private ensureChatHistoryFolder(prjPath: string): void {
    const folderPath = this.getChatHistoryFolderPath(prjPath);
    if (!window['fs'].existsSync(folderPath)) {
      window['fs'].mkdirSync(folderPath, { recursive: true });
    }
  }

  /**
   * 保存会话聊天记录到 .chat_history 文件夹
   * @param prjPath 项目路径
   * @param sessionId 会话ID
   * @param chatList 聊天记录列表
   */
  saveSessionChatHistory(prjPath: string, sessionId: string, chatList: any[]): void {
    if (!sessionId || !chatList || chatList.length === 0) {
      return;
    }
    
    this.ensureChatHistoryFolder(prjPath);
    const filePath = this.getSessionHistoryFilePath(prjPath, sessionId);
    
    try {
      window['fs'].writeFileSync(filePath, JSON.stringify(chatList, null, 2), 'utf-8');
    } catch (error) {
      console.warn('保存会话聊天记录失败:', error);
    }
  }

  /**
   * 从 .chat_history 文件夹加载会话聊天记录
   * @param prjPath 项目路径
   * @param sessionId 会话ID
   * @returns 聊天记录列表，如果不存在则返回 null
   */
  loadSessionChatHistory(prjPath: string, sessionId: string): any[] | null {
    if (!sessionId) {
      return null;
    }
    
    const filePath = this.getSessionHistoryFilePath(prjPath, sessionId);
    
    try {
      if (window['fs'].existsSync(filePath)) {
        const content = window['fs'].readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn('加载会话聊天记录失败:', error);
    }
    
    return null;
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

  startSession(mode: string, tools: MCPTool[] | null = null, maxCount?: number, customllmConfig?: any, customModel?: any): Observable<any> {
    const payload: any = { 
      session_id: this.currentSessionId, 
      tools: tools || [], 
      mode 
    };
    
    // 如果提供了 maxCount 参数，添加到请求中
    if (maxCount !== undefined && maxCount > 0) {
      payload.max_count = maxCount;
    }

    // 如果提供了自定义LLM配置，添加到请求中
    if (customllmConfig) {
      payload.llm_config = customllmConfig;
    }

    // 如果提供了自定义模型，添加到请求中
    if (customModel) {
      payload.custom_model = customModel;
    }
    
    return this.http.post(API.startSession, payload);
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
                  // console.log("Complete Msg: ", msg);
                  messageSubject.complete();
                  return;
                }
              } catch (error) {
                console.warn('解析JSON失败:', error, line);
              }
            }
          }

          // 处理缓冲区中剩余的内容
          if (buffer.trim()) {
            try {
              const msg = JSON.parse(buffer);
              messageSubject.next(msg);
            } catch (error) {
              console.warn('解析最后的JSON失败:', error, buffer);
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

  generateTitle(sessionId: string, content: string) {
    if (this.titleIsGenerating) {
      console.warn('标题生成中，忽略重复请求');
      return;
    }
    this.titleIsGenerating = true;
    this.http.post(`${API.generateTitle}`, { content }).subscribe(
      (res) => {
        if ((res as any).status === 'success' && sessionId === this.currentSessionId) {
          try {
            this.currentSessionTitle = JSON.parse((res as any).data).title;
          } catch (error) {
            this.currentSessionTitle = (res as any).data;
          }

          console.log("currentSessionTitle:", this.currentSessionTitle);
        }

        this.titleIsGenerating = false;
      },
      (error) => {
        console.error('生成标题失败:', error);
        this.titleIsGenerating = false;
      }
    );
  }
}
