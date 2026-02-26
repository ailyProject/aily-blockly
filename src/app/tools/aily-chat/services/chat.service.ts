import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { MCPTool } from './mcp.service';
import { API } from "../../../configs/api.config";
import { ConfigService } from '../../../services/config.service';
import { AilyChatConfigService, ModelConfigOption } from './aily-chat-config.service';
import { AuthService } from '../../../services/auth.service';
import { ProjectService } from '../../../services/project.service';
import { PlatformService } from '../../../services/platform.service';

// 使用 ModelConfigOption 作为统一的模型配置类型，保留 ModelConfig 别名以兼容旧代码
export type ModelConfig = ModelConfigOption;

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

  currentMode = 'agent'; // 默认为代理模式
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
    private ailyChatConfigService: AilyChatConfigService,
    private authService: AuthService,
    private projectService: ProjectService,
    private platformService: PlatformService
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

  startSession(mode: string, tools: MCPTool[] | null = null, maxCount?: number, customllmConfig?: any, selectModel?: string): Observable<any> {
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

    // 如果提供了选择的模型名称，添加到请求中
    if (selectModel) {
      payload.select_model = selectModel;
    }

    return this.http.post(API.startSession, payload);
  }

  closeSession(sessionId: string) {
    return this.http.post(`${API.closeSession}/${sessionId}`, {});
  }

  // 本地调试用：模拟服务端流式返回的字符串数据
  debugStream(sessionId: string = 'downey-test'): Observable<any> {
    return new Observable(observer => {
      let aborted = false;

      const thinking = `
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.862986Z", "content": "<think>\u7528\u6237", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.863805Z", "content": "\u8981\u6c42", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.864465Z", "content": "\\"", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.866282Z", "content": "\u6e32\u67d3", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.867863Z", "content": "\u6d41\u7a0b", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.869158Z", "content": "\u56fe", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.870102Z", "content": "\u6d4b\u8bd5", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.870590Z", "content": "\\"\uff0c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.871155Z", "content": "\u8fd9\u662f\u4e00\u4e2a", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:01.871718Z", "content": "\u6d4b\u8bd5", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.080280Z", "content": "\u8bf7\u6c42", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.081117Z", "content": "\uff0c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.081892Z", "content": "\u60f3", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.083477Z", "content": "\u770b\u770b", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.085274Z", "content": "\u6d41\u7a0b", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.450694Z", "content": "\u56fe", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.451908Z", "content": "\u6e32\u67d3", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.453456Z", "content": "\u6548\u679c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.793694Z", "content": "\u3002", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.794670Z", "content": "\u8fd9", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.795590Z", "content": "\u4e0d\u9700\u8981", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.797254Z", "content": "\u6267\u884c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.799429Z", "content": "\u4efb\u4f55", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.800124Z", "content": "\u5177\u4f53\u7684", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.800915Z", "content": "\u5de5\u7a0b", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.801702Z", "content": "\u4efb\u52a1", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.802513Z", "content": "\uff0c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.803142Z", "content": "\u4e5f\u4e0d", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.804690Z", "content": "\u9700\u8981", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.806506Z", "content": "\u4f7f\u7528", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.836511Z", "content": "\u5de5\u5177", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.837150Z", "content": "\u3002", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:02.993466Z", "content": "\u6211\u5e94\u8be5", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.855674Z", "content": "\u76f4\u63a5", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.856587Z", "content": "\u8f93\u51fa", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.857478Z", "content": "\u4e00\u4e2a", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.859465Z", "content": "\u7b80\u5355\u7684", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.861708Z", "content": "\u6d41\u7a0b", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.862542Z", "content": "\u56fe", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.863239Z", "content": "\u793a\u4f8b", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.863901Z", "content": "\u6765", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.864521Z", "content": "\u5c55\u793a", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.865165Z", "content": "\u6e32\u67d3", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:03.865823Z", "content": "\u6548\u679c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:04.207133Z", "content": "\u3002\\n\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:04.207926Z", "content": "\u6839\u636e", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:04.208543Z", "content": "\u6307\u5bfc", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:04.210213Z", "content": "\u539f\u5219", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:04.212085Z", "content": "\uff0c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:04.212722Z", "content": "\u6211\u5e94\u8be5", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:04.213414Z", "content": "\u7b80\u6d01", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:04.214136Z", "content": "\u3001", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.343760Z", "content": "\u76f4\u63a5", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.344453Z", "content": "\uff0c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.346415Z", "content": "\u4e0d\u9700\u8981", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.348056Z", "content": "\u8fc7\u591a\u7684", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.376601Z", "content": "\u89e3\u91ca", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.386191Z", "content": "\u3002", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.387115Z", "content": "\u76f4\u63a5", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.694118Z", "content": "\u8f93\u51fa", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.694789Z", "content": "\u4e00\u4e2a", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.695412Z", "content": "\u6d41\u7a0b", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.697009Z", "content": "\u56fe", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.698790Z", "content": "\u5373\u53ef", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.699440Z", "content": "\u3002", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.700118Z", "content": "</think>", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      `;
      
      const mermaid = `{"type": "connected", "session_id": "2eaf05cb-e537-4639-8372-088b927c9d3b"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.700241Z", "content": "\`\`\`", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.700817Z", "content": "aily", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.701529Z", "content": "-", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.703277Z", "content": "mer", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.703843Z", "content": "maid", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.705310Z", "content": "\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.705981Z", "content": "flow", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.706533Z", "content": "chart", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.707068Z", "content": " TD", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.707778Z", "content": "\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.708332Z", "content": " ", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.709632Z", "content": " A", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.711406Z", "content": "[", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.713304Z", "content": "\u5f00\u59cb", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.836274Z", "content": "]", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.836949Z", "content": " -->", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.837831Z", "content": " B", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.839311Z", "content": "[", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.850558Z", "content": "\u521d\u59cb\u5316", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.852040Z", "content": "]\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.853567Z", "content": " ", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:26.854903Z", "content": " B", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.278951Z", "content": " -->", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.279802Z", "content": " C", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.280443Z", "content": "{", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.568027Z", "content": "\u68c0\u67e5", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.569190Z", "content": "\u6761\u4ef6", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.570282Z", "content": "}\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.572606Z", "content": " ", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.574603Z", "content": " C", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.575549Z", "content": " -->", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.576464Z", "content": "|", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.577302Z", "content": "true", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.578203Z", "content": "|", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.578923Z", "content": " D", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.580676Z", "content": "[", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.582676Z", "content": "\u6267\u884c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.610695Z", "content": "\u64cd\u4f5c", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.611601Z", "content": "]\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.612395Z", "content": " ", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.614248Z", "content": " C", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.689452Z", "content": " -->", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.690373Z", "content": "|", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.691296Z", "content": "false", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.693229Z", "content": "|", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.724845Z", "content": " E", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.725744Z", "content": "[", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.727476Z", "content": "\u8df3", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.833416Z", "content": "\u8fc7", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.834355Z", "content": "]\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.835222Z", "content": " ", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.836857Z", "content": " D", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.974536Z", "content": " -->", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.976012Z", "content": " F", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.977719Z", "content": "[", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.979504Z", "content": "\u7ed3\u675f", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.980305Z", "content": "]\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:27.981136Z", "content": " ", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:28.111976Z", "content": " E", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:28.113152Z", "content": " -->", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:28.114414Z", "content": " F", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:28.117694Z", "content": "\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:28.118426Z", "content": "\`\`", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:28.119284Z", "content": "\`\\n", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      `;

      const terminate = `
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:28.224952Z", "content": "TER", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:28.225782Z", "content": "MIN", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      {"id": "58061d03-24ab-4d38-b989-74553f7025fb", "source": "mainAgent", "models_usage": null, "metadata": {}, "created_at": "2026-02-10T08:41:28.226586Z", "content": "ATE", "full_message_id": null, "type": "ModelClientStreamingChunkEvent"}
      
      {"type": "TaskCompleted", "stop_reason": "Text 'TERMINATE' mentioned"}
      `
      
      // 原始文本流数据（模拟服务端返回的格式）
      let mockText = [
        thinking,
        mermaid,
        terminate,
      ].join('\n');
      
      try {
        const logPath = this.projectService.projectRootPath + this.platformService.getPlatformSeparator() + 'stream_mock.txt';
        const mockfile = window['fs'].readFileSync(logPath, 'utf-8');
        mockText = mockfile;
      } catch (error) {
        console.warn('读取流式数据失败:', error);
      }

      let buffer = '';
      let offset = 0;
      const chunkSize = 500; // 模拟分块到达

      const intervalId = setInterval(() => {
        if (aborted) return;

        if (offset >= mockText.length) {
          clearInterval(intervalId);
          if (!aborted && buffer.trim()) {
            try {
              const msg = JSON.parse(buffer);
              observer.next(msg);
            } catch (error) {
              console.warn('解析最后的JSON失败:', error, buffer);
            }
          }
          if (!aborted) observer.complete();
          return;
        }

        buffer += mockText.slice(offset, offset + chunkSize);
        offset += chunkSize;

        const lines = buffer.split('\n');

        buffer = lines.pop() || '';

        for (const line of lines) {
          if (aborted) break;
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            observer.next(msg);
            if (msg.type === 'TaskCompleted') {
              clearInterval(intervalId);
              observer.complete();
              return;
            }
          } catch (error) {
            console.warn('解析JSON失败:', error, line);
          }
        }
      }, 0);

      // 取消订阅时停止定时器
      return () => {
        aborted = true;
        clearInterval(intervalId);
      };
    });
  }

  streamConnect(sessionId: string, options?: any): Observable<any> {
    // 使用 Observable 构造函数，确保只有在订阅时才开始执行
    return new Observable(observer => {
      let aborted = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

      // 获取 token 并添加 Authorization 头部
      this.authService.getToken2().then(token => {
        if (aborted) return;

        const headers: HeadersInit = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        fetch(`${API.streamConnect}/${sessionId}`, { headers })
          .then(async response => {
          if (aborted) return;

          if (!response.ok) {
            observer.error(new Error(`HTTP error! Status: ${response.status}`));
            return;
          }

          reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (!aborted) {
              const { value, done } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (aborted) break;
                if (!line.trim()) continue;
                try {
                  const msg = JSON.parse(line);
                  observer.next(msg);
                  // console.log("recv: ", msg);

                  if (msg.type === 'TaskCompleted') {
                    observer.complete();
                    return;
                  }
                } catch (error) {
                  console.warn('解析JSON失败:', error, line);
                }
              }
            }

            // 处理缓冲区中剩余的内容
            if (!aborted && buffer.trim()) {
              try {
                const msg = JSON.parse(buffer);
                observer.next(msg);
              } catch (error) {
                console.warn('解析最后的JSON失败:', error, buffer);
              }
            }

            if (!aborted) {
              observer.complete();
            }
          } catch (error) {
            if (!aborted) {
              observer.error(error);
            }
          }
        })
        .catch(error => {
          if (!aborted) {
            observer.error(error);
          }
        });
      }).catch(error => {
        if (!aborted) {
          observer.error(error);
        }
      });

      // 返回清理函数，在取消订阅时调用
      return () => {
        aborted = true;
        if (reader) {
          reader.cancel().catch(() => {});
        }
      };
    });
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
