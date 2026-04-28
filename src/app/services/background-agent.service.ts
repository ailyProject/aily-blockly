/**
 * BackgroundAgentService - 后台 Agent 服务
 *
 * 对接服务端 SubAgent 直连模式（已改为 Copilot 式无状态 Request-per-Turn）：
 * - 通过 start_session({ agent: "schematicAgent" }) 创建独立会话
 * - 独立管理 sessionId，不影响 ChatService 的用户对话
 * - 本地执行工具，工具结果通过 messages[] 注入下一轮请求（无需回传等待）
 * - 通过 IPC 推送进度到连线图子窗口
 *
 * @see autogen-subagent-direct-connect.md
 * @see STATELESS_CHAT_API.md
 */

import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject, Observable, Subscription } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { API } from '../configs/api.config';
import { AuthService } from './auth.service';
import { ProjectService } from './project.service';
import { ConnectionGraphService } from './connection-graph.service';
import { ElectronService } from './electron.service';

// 统一从 aily-chat 公共 API 导入
import {
  AilyChatConfigService,
  ContextBudgetService,
  TiktokenService,
  createSecurityContext,
  TOOLS,
  ToolUseResult,
  // 连线图工具
  generateConnectionGraphTool,
  getPinmapSummaryTool,
  validateConnectionGraphTool,
  getSensorPinmapCatalogTool,
  getProjectContextTool,
  generatePinmapTool,
  savePinmapTool,
  getCurrentSchematicTool,
  applySchematicTool,
  // 共享工具
  getContextTool,
  getProjectInfoTool,
  readFileTool,
  createFileTool,
  editFileTool,
  deleteFileTool,
  deleteFolderTool,
  createFolderTool,
  listDirectoryTool,
  getDirectoryTreeTool,
  grepTool,
  globTool,
  getBoardParametersTool,
  fetchTool,
  FetchToolService,
} from '../tools/aily-chat/public-api';

// ===== 类型定义 =====

export type ProgressEventType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'text'
  | 'complete'
  | 'error';

export interface ProgressEvent {
  type: ProgressEventType;
  content: string;
  toolName?: string;
  timestamp: number;
  data?: any;
}

export type BackgroundAgentStatus = 'idle' | 'running' | 'completed' | 'error';

/** 工具显示名称映射 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  'get_pinmap_summary': '获取引脚信息',
  'generate_schematic': '生成连线方案',
  'validate_schematic': '验证连线配置',
  'get_component_catalog': '获取组件目录',
  'get_project_context': '获取项目上下文',
  'generate_pinmap': '生成引脚图',
  'save_pinmap': '保存引脚图',
  'get_current_schematic': '获取当前电路图',
  'apply_schematic': '应用电路方案',
  'get_context': '获取上下文',
  'get_project_info': '获取项目信息',
  'read_file': '读取文件',
  'create_file': '创建文件',
  'edit_file': '编辑文件',
  'delete_file': '删除文件',
  'delete_folder': '删除文件夹',
  'create_folder': '创建文件夹',
  'list_directory': '列出目录',
  'get_directory_tree': '获取目录树',
  'grep_tool': '搜索内容',
  'glob_tool': '搜索文件',
  'get_board_parameters': '获取开发板参数',
  'fetch': '获取网页',
};

@Injectable({
  providedIn: 'root'
})
export class BackgroundAgentService implements OnDestroy {
  // ===== 状态 =====
  private sessionId: string | null = null;
  private progress$ = new Subject<ProgressEvent>();
  private status: BackgroundAgentStatus = 'idle';
  private aborted = false;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  // ===== 无状态模式状态 =====
  /** 客户端维护的完整对话历史 */
  private conversationMessages: any[] = [];
  /** 当前轮次收集的工具调用元信息 */
  private currentTurnToolCalls: any[] = [];
  /** 当前轮次收集的工具执行结果 */
  private pendingToolResults: any[] = [];
  /** 当前轮次的助手文本累积 */
  private currentTurnAssistantContent = '';
  /** 工具调用循环计数器 */
  private toolCallingIteration = 0;
  /** 当前任务可用的工具列表（缓存） */
  private currentTools: any[] = [];

  // ===== 依赖 =====
  private fetchToolService: FetchToolService;
  /**
   * BackgroundAgent 专用的 ContextBudgetService 实例（非全局单例）。
   * 避免与 mainAgent（AilyChatComponent）共享同一个 BehaviorSubject，
   * 防止 BackgroundAgent 的 updateBudget/reset 覆盖聊天界面的上下文用量显示。
   */
  private contextBudgetService: ContextBudgetService;

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private projectService: ProjectService,
    private connectionGraphService: ConnectionGraphService,
    private electronService: ElectronService,
    private ailyChatConfigService: AilyChatConfigService,
    private tiktokenService: TiktokenService,
  ) {
    this.fetchToolService = new FetchToolService(this.http);
    // 创建独立的 ContextBudgetService 实例，不污染全局单例
    this.contextBudgetService = new ContextBudgetService(null as any, this.ailyChatConfigService, this.tiktokenService);
    this.setupIpcListeners();
    console.log('[BackgroundAgent] 服务初始化');
  }

  ngOnDestroy(): void {
    this.cancel();
  }

  // =========================================================================
  // 公共 API
  // =========================================================================

  /** 当前状态 */
  get currentStatus(): BackgroundAgentStatus {
    return this.status;
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.status === 'running';
  }

  /** 进度事件流 */
  onProgress(): Observable<ProgressEvent> {
    return this.progress$.asObservable();
  }

  /**
   * 启动连线图生成任务
   * 完整流程：创建会话 → 发送提示词 → 监听流 → 执行工具 → 完成
   */
  async generateSchematic(): Promise<void> {
    if (this.isRunning) {
      console.warn('[BackgroundAgent] 任务已在运行中');
      return;
    }

    this.status = 'running';
    this.aborted = false;

    // 重置无状态模式状态
    this.conversationMessages = [];
    this.currentTurnToolCalls = [];
    this.pendingToolResults = [];
    this.currentTurnAssistantContent = '';
    this.toolCallingIteration = 0;
    this.contextBudgetService.reset();

    try {
      // 1. 创建独立会话
      this.sessionId = uuidv4();
      this.currentTools = this.getSchematicTools();
      await this.startSession(this.currentTools);
      console.log('[BackgroundAgent] 会话已创建:', this.sessionId);

      // 2. 构建带项目上下文的提示词
      const prompt = await this.buildGenerationPrompt();

      // 3. 将用户消息加入对话历史
      this.conversationMessages.push({ role: 'user', content: prompt });
      console.log('[BackgroundAgent] 提示词已准备，启动工具调用循环');

      // 4. 启动无状态工具调用循环
      await this.runToolCallingLoop();

      // 5. 完成
      if (!this.aborted) {
        this.status = 'completed';
        this.emitProgress('complete', '连线图生成完成');
      }
    } catch (error: any) {
      if (!this.aborted) {
        this.status = 'error';
        this.emitProgress('error', error.message || '连线图生成失败');
        console.error('[BackgroundAgent] 生成失败:', error);
      }
    }
  }

  /**
   * 取消当前任务
   */
  async cancel(): Promise<void> {
    this.aborted = true;

    // 关闭流
    if (this.streamReader) {
      try { await this.streamReader.cancel(); } catch { }
      this.streamReader = null;
    }

    // 关闭服务端会话
    if (this.sessionId) {
      try {
        await this.http.post(`${API.closeSession}/${this.sessionId}`, {}).toPromise();
      } catch { }
    }

    this.status = 'idle';
    this.sessionId = null;
  }

  // =========================================================================
  // IPC 监听（来自连线图子窗口的请求）
  // =========================================================================

  private setupIpcListeners(): void {
    if (!this.electronService.isElectron || !window['ipcRenderer']) return;

    window['ipcRenderer'].on('iframe-message-connection-graph', (_event: any, payload: { type: string; data?: unknown }) => {
      // send-to-chat：子窗口发送文本到 aily-chat
      if (payload?.type === 'send-to-chat') {
        const { text, autoSend } = (payload.data || {}) as { text?: string; autoSend?: boolean };
        if (text && window.openAndSendToAilyChat) {
          window.openAndSendToAilyChat(text, { autoSend: autoSend !== false });
        }
        return;
      }
      // generate-graph-code：兼容旧调用，转发到 aily-chat
      if (payload?.type === 'generate-graph-code') {
        console.log('[BackgroundAgent] 收到同步到代码请求');
        this.handleSyncToCodeRequest();
      }
    });
  }

  // =========================================================================
  // 会话管理（独立于 ChatService）
  // =========================================================================

  /**
   * 创建 schematicAgent 直连会话
   * POST /api/v1/start_session { agent: "schematicAgent", ... }
   */
  private async startSession(tools: any[]): Promise<void> {
    const payload: any = {
      session_id: this.sessionId,
      agent: 'schematicAgent',  // ← 直连 subAgent
      tools,
      mode: 'agent',
    };

    const result: any = await this.http.post(API.startSession, payload).toPromise();
    if (result?.status !== 'success') {
      throw new Error(result?.message || '创建会话失败');
    }
  }

  // =========================================================================
  // 无状态模式：工具调用循环（Copilot 式 Request-per-Turn）
  // =========================================================================

  /**
   * 工具调用循环主入口。
   * 循环：发送 chatRequest → 处理 SSE(文本+工具调用) → 执行工具 → 注入结果到对话历史 → 重复
   * 直到没有工具调用或达到循环上限。
   */
  private async runToolCallingLoop(): Promise<void> {
    while (!this.aborted) {
      // 检查循环次数限制（读取用户在设置面板中配置的 maxCount）
      const toolCallLimit = this.ailyChatConfigService.maxCount;
      if (this.toolCallingIteration >= toolCallLimit) {
        console.warn(`[BackgroundAgent] 工具调用循环已达上限 (${toolCallLimit})`);
        break;
      }

      // 重置当前轮次收集器
      this.currentTurnToolCalls = [];
      this.pendingToolResults = [];
      this.currentTurnAssistantContent = '';

      console.log(`[BackgroundAgent] 第 ${this.toolCallingIteration + 1} 轮请求, messages: ${this.conversationMessages.length} 条`);

      // 上下文预算检查与压缩
      this.contextBudgetService.updateBudget(this.conversationMessages);
      try {
        this.conversationMessages = await this.contextBudgetService.compressIfNeeded(
          this.conversationMessages,
          this.sessionId || '',
          undefined,
          undefined
        );
      } catch (error) {
        console.warn('[BackgroundAgent] 上下文压缩失败:', error);
      }

      // 发送 chatRequest 并处理 SSE 流
      await this.processChatTurn();

      // 如果被取消，直接退出
      if (this.aborted) break;

      // 如果没有工具调用，循环结束（纯文本回复）
      if (this.pendingToolResults.length === 0) {
        // 将最终的 assistant 消息加入对话历史
        if (this.currentTurnAssistantContent) {
          this.conversationMessages.push({
            role: 'assistant',
            content: this.currentTurnAssistantContent
          });
        }
        break;
      }

      // 有工具调用 → 将 assistant 消息(含 tool_calls) + 工具结果加入对话历史
      const assistantMessage: any = {
        role: 'assistant',
        content: this.currentTurnAssistantContent || ''
      };
      if (this.currentTurnToolCalls.length > 0) {
        assistantMessage.tool_calls = this.currentTurnToolCalls.map(tc => ({
          id: tc.tool_id,
          type: 'function',
          function: {
            name: tc.tool_name,
            arguments: typeof tc.tool_args === 'string' ? tc.tool_args : JSON.stringify(tc.tool_args)
          }
        }));
      }
      this.conversationMessages.push(assistantMessage);

      for (const result of this.pendingToolResults) {
        this.conversationMessages.push({
          role: 'tool',
          tool_call_id: result.tool_id,
          name: result.tool_name,
          content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        });
      }

      this.toolCallingIteration++;
      console.log(`[BackgroundAgent] ${this.pendingToolResults.length} 个工具结果已加入对话历史，继续下一轮`);
    }
  }

  /**
   * 发送一轮无状态聊天请求（POST /chat/{sessionId}），处理 SSE 流。
   * SSE 流中遇到 tool_call_request 时立即执行工具，结果收集到 pendingToolResults。
   * 流结束后返回，由 runToolCallingLoop 判断是否继续循环。
   */
  private async processChatTurn(): Promise<void> {
    const token = await this.authService.getToken2();
    const headers: HeadersInit = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const payload = {
      session_id: this.sessionId,
      messages: this.conversationMessages,
      tools: this.currentTools,
      mode: 'agent',
      agent: 'schematicAgent',
    };

    const response = await fetch(`${API.chatRequest}/${this.sessionId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    this.streamReader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!this.aborted) {
        const { value, done } = await this.streamReader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (this.aborted) break;
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);
            await this.handleStreamEvent(event);
          } catch (e) {
            console.warn('[BackgroundAgent] JSON 解析失败:', e);
          }
        }
      }

      // 处理缓冲区剩余
      if (!this.aborted && buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          await this.handleStreamEvent(event);
        } catch { }
      }
    } finally {
      this.streamReader = null;
    }
  }

  // =========================================================================
  // 流事件处理
  // =========================================================================

  /**
   * 处理单个流事件
   */
  private async handleStreamEvent(event: any): Promise<void> {
    switch (event.type) {
      case 'ModelClientStreamingChunkEvent': {
        const content = event.content || '';
        // 累积助手文本内容（无状态模式用于构建 assistant 消息）
        this.currentTurnAssistantContent += content;
        // 检测 <think> 标签
        if (content.includes('<think>') || content.includes('</think>')) {
          this.emitProgress('thinking', '正在分析项目...');
        }
        break;
      }

      case 'tool_call_request': {
        // 服务端内部工具（internal: true）——仅记录进度，不在本地执行
        if (event.internal === true) {
          console.log(`[BackgroundAgent] 服务端内部工具: ${event.tool_name}，仅展示`);
          this.emitProgress('tool_call', `服务端执行: ${event.tool_name}...`, event.tool_name);
          break;
        }
        await this.handleToolCallRequest(event);
        break;
      }

      case 'ToolCallExecutionEvent': {
        // 服务端工具执行完成通知（传统格式）
        break;
      }

      case 'tool_call_execution': {
        // 服务端内部工具执行结果通知（无状态模式新事件）
        const execResult = event.is_error ? `执行失败: ${event.result || ''}` : '执行完成';
        this.emitProgress('tool_result', execResult, event.tool_name);
        break;
      }

      case 'TaskCompleted': {
        const reason = event.stop_reason || event.data?.stop_reason;
        // 无状态模式下 TaskCompleted 仅表示当前轮次 SSE 结束，非 TERMINATE 的 stop_reason 是预期行为
        // 只有真正的 error 且没有待处理工具结果时才报错
        if (reason === 'error' && this.pendingToolResults.length === 0) {
          this.emitProgress('error', '任务异常结束');
        } else {
          console.log(`[BackgroundAgent] TaskCompleted, stop_reason: ${reason}`);
        }
        break;
      }

      case 'error': {
        this.emitProgress('error', event.message || event.content || '服务端错误');
        break;
      }
    }
  }

  // =========================================================================
  // 工具调用处理
  // =========================================================================

  /**
   * 处理 tool_call_request：本地执行工具 → 收集结果（不回传，由循环在下一轮携带）
   */
  private async handleToolCallRequest(event: any): Promise<void> {
    const toolName = event.tool_name;
    const toolId = event.tool_id;
    let toolArgs: any;

    // 记录工具调用元信息（用于构建 assistant 消息的 tool_calls 字段）
    this.currentTurnToolCalls.push({
      tool_id: toolId,
      tool_name: toolName,
      tool_args: event.tool_args
    });

    // 解析参数
    try {
      toolArgs = typeof event.tool_args === 'string'
        ? JSON.parse(event.tool_args)
        : event.tool_args || {};
    } catch {
      this.pendingToolResults.push({
        tool_id: toolId,
        tool_name: toolName,
        content: '参数解析失败',
        is_error: true
      });
      return;
    }

    // 推送进度
    const displayName = TOOL_DISPLAY_NAMES[toolName] || toolName;
    this.emitProgress('tool_call', `正在${displayName}...`, toolName);

    // 执行工具
    let result: ToolUseResult;
    try {
      result = await this.executeTool(toolName, toolArgs);
    } catch (error: any) {
      result = { is_error: true, content: `工具执行异常: ${error.message}` };
    }

    // 推送工具结果进度
    this.emitProgress('tool_result', result.is_error ? `${displayName}失败` : `${displayName}完成`, toolName);

    // 收集工具结果（不回传，由 runToolCallingLoop 在下一轮请求中携带）
    this.pendingToolResults.push({
      tool_id: toolId,
      tool_name: toolName,
      content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
      is_error: result.is_error || false
    });
  }

  /**
   * 路由工具调用到具体的处理函数
   */
  private async executeTool(toolName: string, args: any): Promise<ToolUseResult> {
    const secCtx = createSecurityContext(this.projectService.currentProjectPath || '');

    switch (toolName) {
      // ===== 连线图专属工具 =====
      case 'generate_schematic':
        return generateConnectionGraphTool(this.connectionGraphService, this.projectService, args);
      case 'get_pinmap_summary':
        return getPinmapSummaryTool(this.connectionGraphService, this.projectService, args);
      case 'get_component_catalog':
        return getSensorPinmapCatalogTool(this.connectionGraphService, this.projectService, args);
      case 'get_project_context':
        return getProjectContextTool(this.connectionGraphService, this.projectService, args);
      case 'validate_schematic':
      case 'apply_schematic': // 已废弃，转发到 validate_schematic（功能已合并）
        return validateConnectionGraphTool(this.connectionGraphService, this.projectService, args);
      case 'get_current_schematic':
        return getCurrentSchematicTool(this.connectionGraphService, this.projectService, args);
      case 'generate_pinmap':
        return generatePinmapTool(this.connectionGraphService, this.projectService, args);
      case 'save_pinmap':
        return savePinmapTool(this.connectionGraphService, this.projectService, args);

      // ===== 共享工具 =====
      case 'get_context':
        return getContextTool(this.projectService, args);
      case 'get_project_info':
        return getProjectInfoTool(this.projectService, args);
      case 'read_file':
        return readFileTool(args, secCtx);
      case 'create_file':
        return createFileTool(args, secCtx);
      case 'edit_file':
        return editFileTool(args);
      case 'delete_file':
        return deleteFileTool(args, secCtx);
      case 'delete_folder':
        return deleteFolderTool(args, secCtx);
      case 'create_folder':
        return createFolderTool(args);
      case 'list_directory':
        return listDirectoryTool(args);
      case 'get_directory_tree':
        return getDirectoryTreeTool(args);
      case 'grep_tool':
        return grepTool(args);
      case 'glob_tool':
        return globTool(args);
      case 'get_board_parameters':
        return getBoardParametersTool.handler(this.projectService, args);
      case 'fetch':
        return fetchTool(this.fetchToolService, args);

      default:
        return { is_error: true, content: `后台 Agent 不支持工具: ${toolName}` };
    }
  }

  // sendToolResult 和 sendMessage 已废弃（无状态模式下工具结果通过 messages[] 携带）
  // 保留方法签名以防需要回退

  /** @deprecated 无状态模式下不再使用 */
  private async sendToolResult(toolId: string, result: ToolUseResult): Promise<void> {
    const content = JSON.stringify({
      type: 'tool',
      tool_id: toolId,
      content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
      is_error: result.is_error || false,
    });

    try {
      await this.sendMessage(content, 'tool');
    } catch (error) {
      console.error('[BackgroundAgent] 回传工具结果失败:', error);
    }
  }

  /** @deprecated 无状态模式下不再使用 */
  private async sendMessage(content: string, source: string = 'user'): Promise<void> {
    await this.http.post(`${API.sendMessage}/${this.sessionId}`, { content, source }).toPromise();
  }

  // =========================================================================
  // 工具定义
  // =========================================================================

  /**
   * 获取 schematicAgent 可用的工具列表
   * 从 TOOLS 中按 agents 字段过滤
   */
  private getSchematicTools(): any[] {
    return (TOOLS as any[]).filter(tool => {
      if (!tool.agents) return false;
      return tool.agents.includes('schematicAgent');
    });
  }

  // =========================================================================
  // 提示词构建
  // =========================================================================

  /**
   * 构建生成连线图的提示词，附带项目代码上下文
   */
  private async buildGenerationPrompt(): Promise<string> {
    let contextInfo = '';

    try {
      // 获取项目上下文
      const ctxResult = await getContextTool(this.projectService, { info_type: 'project' });
      if (!ctxResult.is_error) {
        contextInfo += `\n## 项目上下文\n${ctxResult.content}\n`;
      }

      // 获取项目目录树
      const projectPath = this.projectService.currentProjectPath;
      if (projectPath) {
        const treeResult = await getDirectoryTreeTool({ path: projectPath, maxDepth: 2 });
        if (!treeResult.is_error) {
          contextInfo += `\n## 项目目录结构\n${treeResult.content}\n`;
        }

        // 尝试读取主要代码文件（如 project.abs 或 main.ino）
        const mainFiles = ['project.abs', 'src/main.ino', 'src/main.cpp', 'main.ino'];
        for (const file of mainFiles) {
          const filePath = projectPath.replace(/[\\/]$/, '') + '/' + file;
          if (this.electronService.exists(filePath)) {
            const fileResult = await readFileTool({ path: filePath }, createSecurityContext(projectPath));
            if (!fileResult.is_error) {
              contextInfo += `\n## 项目代码 (${file})\n\`\`\`\n${fileResult.content}\n\`\`\`\n`;
            }
            break; // 只读取第一个找到的主文件
          }
        }
      }
    } catch (e) {
      console.warn('[BackgroundAgent] 收集项目上下文失败:', e);
    }

    return `请分析当前项目的代码，自动生成对应的硬件连线图（电路连线方案）。

${contextInfo}

## 要求
1. 根据代码中使用的传感器/模块，确定需要的硬件组件
2. 查询各组件的引脚信息
3. 生成合理的连线方案
4. 验证连线配置的正确性
5. 应用连线方案到项目中

请开始分析并生成连线图。`;
  }

  // =========================================================================
  // "同步到代码" 处理
  // =========================================================================

  /**
   * 处理"同步到代码"请求
   * 将预设提示词发送到 aily-chat 输入框并自动发送
   */
  private handleSyncToCodeRequest(): void {
    const connectionData = this.connectionGraphService.getConnectionGraph();
    if (!connectionData) {
      console.warn('[BackgroundAgent] 同步到代码: 无连线图数据');
      return;
    }

    const componentSummary = (connectionData.components || [])
      .map((c: any) => `- ${c.title || c.refId || c.id}`)
      .join('\n');

    const prompt = `请根据当前连线图方案，将硬件连线配置同步到项目代码中。

## 当前连线组件
${componentSummary}

## 连线数量
${(connectionData.connections || []).length} 条连线

请分析连线图，在代码中添加或修改对应的传感器初始化和引脚配置代码。`;

    // 通过全局 API 发送到 aily-chat 并自动发送
    if (window.openAndSendToAilyChat) {
      window.openAndSendToAilyChat(prompt, { autoSend: true });
    }
  }

  // =========================================================================
  // 进度推送
  // =========================================================================

  /**
   * 发出进度事件 → Subject + IPC 双通道
   */
  private emitProgress(type: ProgressEventType, content: string, toolName?: string, data?: any): void {
    const event: ProgressEvent = {
      type,
      content,
      toolName,
      timestamp: Date.now(),
      data,
    };

    // RxJS Subject（供主窗口内组件订阅）
    this.progress$.next(event);

    // IPC 推送到连线图子窗口（规范：iframe-message-connection-graph）
    if (this.electronService.isElectron && window['ipcRenderer']) {
      window['ipcRenderer'].send('iframe-message-connection-graph', { type: 'generate-graph-progress', data: event });
    }
  }
}
