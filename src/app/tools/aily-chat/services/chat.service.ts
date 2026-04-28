import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, ReplaySubject, Subscription } from 'rxjs';
import { MCPTool } from './mcp.service';
import { ChatAPI } from '../core/api-endpoints';
import { AilyChatConfigService, ModelConfigOption } from './aily-chat-config.service';
import { AilyHost } from '../core/host';
import { isTransientNetworkError, isLikelySessionLostError } from './http-error-handler.service';
import { asyncJsonStringify } from '../core/async-json-stringify';
import { ChatKernelProxy } from './chat-kernel-proxy';

// 使用 ModelConfigOption 作为统一的模型配置类型，保留 ModelConfig 别名以兼容旧代码
export type ModelConfig = ModelConfigOption;

export interface ChatTextOptions {
  sender?: string;
  type?: string;
  cover?: boolean;  // 是否覆盖之前的内容
  autoSend?: boolean; // 是否自动发送
  newChatFirst?: boolean; // 发送前先新建会话
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

  currentSessionId = '';
  currentSessionTitle = '';

  // 记录当前会话创建时的项目路径，用于确保历史记录保存到正确位置
  currentSessionPath = '';

  titleIsGenerating = false;

  /** SSE Worker 代理 — 将 fetch + JSON.stringify + SSE 解析移至 Worker 线程 */
  readonly sseProxy = new ChatKernelProxy();

  /** 由 ChatEngineService 同步：是否正在等待 AI 响应 */
  isWaiting = false;

  /**
   * ReplaySubject(1) 仅用于“聊天面板尚未挂载时”暂存最近一条外部消息。
   * 消息被 ChatEngineService 消费后会立即清空，避免重新打开面板时重复自动发送。
   */
  private textSubject = new ReplaySubject<ChatTextMessage | null>(1);

  private async readHttpErrorBody(response: Response): Promise<any> {
    try {
      const rawText = await response.clone().text();
      if (!rawText) {
        return null;
      }

      try {
        return JSON.parse(rawText);
      } catch {
        return { message: rawText, detail: rawText };
      }
    } catch {
      return null;
    }
  }

  private extractErrorCode(errorBody: any): string | number | undefined {
    if (!errorBody || typeof errorBody !== 'object') {
      return undefined;
    }

    return errorBody.code ?? errorBody.error?.code ?? errorBody.data?.code;
  }

  private extractErrorMessage(errorBody: any): string {
    if (!errorBody) {
      return '';
    }

    if (typeof errorBody === 'string') {
      return errorBody.trim();
    }

    if (typeof errorBody !== 'object') {
      return '';
    }

    const messageCandidate =
      errorBody.message ??
      errorBody.msg ??
      errorBody.detail ??
      errorBody.error_description ??
      errorBody.error?.message ??
      errorBody.error;

    return typeof messageCandidate === 'string' ? messageCandidate.trim() : '';
  }

  private createNormalizedHttpError(response: Response, errorBody: any, fallbackMessage?: string): any {
    const detail = this.extractErrorMessage(errorBody);
    const code = this.extractErrorCode(errorBody);

    return {
      name: 'HttpRequestError',
      status: response.status,
      statusCode: response.status,
      code,
      message: detail || fallbackMessage || `HTTP error! Status: ${response.status}`,
      detail,
      error: errorBody,
      response: {
        status: response.status,
        statusText: response.statusText
      }
    };
  }

  constructor(
    private http: HttpClient,
    private ailyChatConfigService: AilyChatConfigService,
  ) {
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
    const config = AilyHost.get().config;
    if (config.data?.aiChatMode) {
      this.currentMode = config.data.aiChatMode;
    }
  }

  /**
   * 保存AI聊天模式到配置
   */
  saveChatMode(mode: 'agent' | 'ask'): void {
    this.currentMode = mode;
    const config = AilyHost.get().config;
    if (config.data) config.data.aiChatMode = mode;
    config.save?.();
  }

  /**
   * 从配置加载AI模型
   */
  private loadChatModel(): void {
    const savedModel = AilyHost.get().config.data?.aiChatModel;
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
    const config = AilyHost.get().config;
    if (config.data) config.data.aiChatModel = model;
    config.save?.();
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
  getTextMessages(): Observable<ChatTextMessage | null> {
    return this.textSubject.asObservable();
  }

  /**
   * 清空已消费的外部消息缓冲，避免 ReplaySubject 在新订阅时重放旧消息。
   */
  clearBufferedTextMessage(timestamp?: number): void {
    if (timestamp == null) {
      this.textSubject.next(null);
      return;
    }

    this.textSubject.next(null);
  }

  startSession(mode: string, tools: MCPTool[] | null = null, maxCount?: number, customllmConfig?: any, selectModel?: string, customSessionId?: string): Observable<any> {
    const payload: any = {
      session_id: customSessionId || this.currentSessionId,
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

    return this.http.post(ChatAPI.startSession, payload);
  }

  /**
   * 获取服务端准确的系统提示词 / 工具定义 token 数和模型上下文窗口大小。
   * 用于前端 ContextBudgetService 精确计算可用 token 预算。
   */
  async fetchContextInfo(sessionId: string): Promise<{
    system_tokens: number;
    tools_tokens: number;
    model_context_limit: number;
    model_name?: string;
  } | null> {
    try {
      const token = await AilyHost.get().auth.getToken!();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await fetch(`${ChatAPI.contextInfo}/${sessionId}`, { headers });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.warn('[ChatService] fetchContextInfo failed:', e);
      return null;
    }
  }

  closeSession(sessionId: string) {
    return this.http.post(`${ChatAPI.closeSession}/${sessionId}`, {});
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
        const logPath = AilyHost.get().project.projectRootPath + AilyHost.get().platform.pathSeparator + 'stream_mock.txt';
        const mockfile = AilyHost.get().fs.readFileSync(logPath, 'utf-8');
        mockText = mockfile;
      } catch (error) {
        console.warn('读取流式数据失败:', error);
      }

      let buffer = '';
      let offset = 0;
      const chunkSize = 100; // 模拟分块到达

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
      }, 300);

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
      let workerSub: Subscription | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const abortCtrl = new AbortController();

      // 获取 token 并添加 Authorization 头部
      AilyHost.get().auth.getToken!().then(token => {
        if (aborted) return;

        const headers: Record<string, string> = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const url = `${ChatAPI.streamConnect}/${sessionId}`;

        // ★ Worker 路径：fetch + SSE 解析在 Worker 线程执行
        if (this.sseProxy.isReady) {
          workerSub = this.sseProxy.sseFetch(url, 'GET', headers).subscribe({
            next: data => { if (!aborted) observer.next(data); },
            complete: () => { if (!aborted) observer.complete(); },
            error: err => { if (!aborted) observer.error(err); },
          });
          return;
        }

        // ★ 降级：主线程直接 fetch（原始实现）
        fetch(url, { headers, signal: abortCtrl.signal })
          .then(async response => {
          if (aborted) return;

          if (!response.ok) {
            const errorBody = await this.readHttpErrorBody(response);
            observer.error(this.createNormalizedHttpError(response, errorBody));
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
            if ((error as Error)?.name === 'AbortError' || aborted) return;
            observer.error(error);
          }
        })
        .catch(error => {
          if ((error as Error)?.name === 'AbortError') return;
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
        workerSub?.unsubscribe();
        abortCtrl.abort();
        if (reader) {
          reader.cancel().catch(() => {});
        }
      };
    });
  }

  sendMessage(sessionId: string, content: string, source: string = 'user') {
    return this.http.post(`${ChatAPI.sendMessage}/${sessionId}`, { content, source });
  }

  /**
   * 无状态聊天请求（Copilot 式 Request-per-Turn）
   * 每次请求携带完整对话历史（含工具结果），返回 SSE 流。
   * 服务端不需要等待工具执行结果，工具调用由前端控制循环。
   *
   * @param sessionId  会话ID
   * @param messages   完整对话历史 [{role,content,tool_calls?,tool_call_id?,name?}]
   * @param tools      可用工具列表
   * @param mode       模式 'agent' | 'ask'
   * @param llmConfig  自定义 LLM 配置（可选）
   * @param selectModel 选择的模型名称（可选）
   * @param maxCount   最大消息轮数（可选）
   */
  chatRequest(
    sessionId: string,
    messages: any[],
    tools: any[] | null = null,
    mode: string = 'agent',
    llmConfig?: any,
    selectModel?: string,
    maxCount?: number,
    agent?: string,
  ): Observable<any> {
    return new Observable(observer => {
      let aborted = false;
      let workerSub: Subscription | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const abortCtrl = new AbortController();

      const payload: any = {
        session_id: sessionId,
        messages,
        tools: tools || [],
        mode
      };

      if (maxCount !== undefined && maxCount > 0) {
        payload.max_count = maxCount;
      }
      if (llmConfig) {
        payload.llm_config = llmConfig;
      }
      if (selectModel) {
        payload.select_model = selectModel;
      }
      if (agent) {
        payload.agent = agent;
      }

      AilyHost.get().auth.getToken!().then(async (token) => {
        if (aborted) return;

        // 调试异常注入：在控制台设置 localStorage.ailyChatDebugForceError 后自动附带请求头
        let debugForceErrorCode = '';
        try {
          debugForceErrorCode = (localStorage.getItem('ailyChatDebugForceError') || '').trim();
        } catch {
          debugForceErrorCode = '';
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        if (debugForceErrorCode) {
          headers['X-Debug-Force-Error'] = debugForceErrorCode;
        }

        const url = `${ChatAPI.chatRequest}/${sessionId}`;

        // ★ Worker 路径：JSON.stringify + fetch + SSE 解析均在 Worker 线程
        // 替代 asyncJsonStringify（payload 直接传给 Worker，Worker 内部 JSON.stringify）
        if (this.sseProxy.isReady) {
          workerSub = this.sseProxy.sseFetch(url, 'POST', headers, payload).subscribe({
            next: data => { if (!aborted) observer.next(data); },
            complete: () => { if (!aborted) observer.complete(); },
            error: err => { if (!aborted) observer.error(err); },
          });
          return;
        }

        // ★ 降级：主线程直接 fetch（原始实现，含完整重试逻辑）
        // P0: 将 JSON 序列化移至 Web Worker，避免 100KB+ payload 阻塞主线程
        const buildRequestBody = (effectiveSessionId: string) => asyncJsonStringify({
          ...payload,
          session_id: effectiveSessionId,
        });

        const MAX_NETWORK_RETRIES = 3;
        const RETRY_BASE_DELAY = 2000; // ms
        const RETRY_INITIAL_DELAY = 3000; // ms — 首次重试多等一会，服务重启通常需要几秒

        const attemptFetch = async (attempt: number): Promise<void> => {
          try {
            let effectiveSessionId = sessionId;
            let requestBody = await buildRequestBody(effectiveSessionId);
            if (aborted) return;

            const response = await fetch(`${ChatAPI.chatRequest}/${effectiveSessionId}`, {
              method: 'POST',
              headers,
              body: requestBody,
              signal: abortCtrl.signal
            });
            if (aborted) return;

            let streamResponse = response;
            if (!response.ok) {
              const errorBody = await this.readHttpErrorBody(response);
              const normalizedErr = this.createNormalizedHttpError(response, errorBody);

              // 会话丢失（404/21001 或 500 通用错误）→ 重建会话并重试
              if (isLikelySessionLostError(normalizedErr) && attempt === 0) {
                try {
                  console.warn(`[chatRequest] 检测到会话可能丢失 (HTTP ${response.status})，重建会话...`);
                  await this.startSession(mode, tools as any, maxCount, llmConfig, selectModel).toPromise();
                  if (aborted) return;
                  effectiveSessionId = this.currentSessionId || sessionId;
                  requestBody = await buildRequestBody(effectiveSessionId);
                  const retryResp = await fetch(`${ChatAPI.chatRequest}/${effectiveSessionId}`, {
                    method: 'POST',
                    headers,
                    body: requestBody,
                    signal: abortCtrl.signal
                  });
                  if (aborted) return;
                  if (!retryResp.ok) {
                    const retryErrorBody = await this.readHttpErrorBody(retryResp);
                    observer.error(this.createNormalizedHttpError(
                      retryResp,
                      retryErrorBody,
                      `HTTP error after session restart! Status: ${retryResp.status}`
                    ));
                    return;
                  }
                  streamResponse = retryResp;
                } catch (retryErr) {
                  if (!aborted) observer.error(retryErr);
                  return;
                }
              } else if (isTransientNetworkError(normalizedErr) && attempt < MAX_NETWORK_RETRIES) {
                // 502/503/504 + 连接类错误消息 → 瞬态，可重试
                const delay = attempt === 0 ? RETRY_INITIAL_DELAY : RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
                console.warn(`[chatRequest] HTTP ${response.status} 瞬态错误，${delay}ms 后第 ${attempt + 1} 次重试`);
                await new Promise(r => setTimeout(r, delay));
                if (!aborted) {
                  return attemptFetch(attempt + 1);
                }
                return;
              } else {
                observer.error(normalizedErr);
                return;
              }
            }

            reader = streamResponse.body!.getReader();
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
              if ((error as Error)?.name === 'AbortError' || aborted) return;
              // 流读取中途断连（如 ERR_INCOMPLETE_CHUNKED_ENCODING）→ 向外抛给重试逻辑
              throw error;
            }
          } catch (error) {
            if ((error as Error)?.name === 'AbortError' || aborted) return;
            // 瞬态网络错误自动重试（如 TypeError: network / ERR_INCOMPLETE_CHUNKED_ENCODING）
            if (isTransientNetworkError(error) && attempt < MAX_NETWORK_RETRIES) {
              const delay = attempt === 0 ? RETRY_INITIAL_DELAY : RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
              console.warn(`[chatRequest] 网络错误，${delay}ms 后第 ${attempt + 1} 次重试:`, (error as Error).message);
              await new Promise(r => setTimeout(r, delay));
              if (!aborted) {
                return attemptFetch(attempt + 1);
              }
              return;
            }
            if (!aborted) {
              observer.error(error);
            }
          }
        };

        attemptFetch(0);
      }).catch(error => {
        if (!aborted) {
          observer.error(error);
        }
      });

      // 返回清理函数，在取消订阅时调用
      return () => {
        aborted = true;
        workerSub?.unsubscribe();
        abortCtrl.abort();
        if (reader) {
          reader.cancel().catch(() => {});
        }
      };
    });
  }

  getHistory(sessionId: string) {
    return this.http.get(`${ChatAPI.getHistory}/${sessionId}`);
  }

  stopSession(sessionId: string) {
    return this.http.post(`${ChatAPI.stopSession}/${sessionId}`, {});
  }

  cancelTask(sessionId: string) {
    return this.http.post(`${ChatAPI.cancelTask}/${sessionId}`,{});
  }

  /**
   * 生成会话标题
   * @param sessionId 会话ID
   * @param content 用户消息内容
   * @param onTitleReady 标题生成成功时的回调（可选）
   */
  generateTitle(sessionId: string, content: string, onTitleReady?: (title: string) => void) {
    if (this.titleIsGenerating) {
      console.warn('标题生成中，忽略重复请求');
      return;
    }
    this.titleIsGenerating = true;
    this.http.post(`${ChatAPI.generateTitle}`, { content }).subscribe(
      (res) => {
        if ((res as any).status === 'success' && sessionId === this.currentSessionId) {
          let title: string;
          try {
            title = JSON.parse((res as any).data).title;
          } catch (error) {
            title = (res as any).data;
          }

          this.currentSessionTitle = title;
          console.log("currentSessionTitle:", this.currentSessionTitle);

          // 调用回调，通知标题已就绪
          if (onTitleReady && title) {
            onTitleReady(title);
          }
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
