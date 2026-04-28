/**
 * SubagentSessionService - Subagent 会话管理服务
 *
 * 当 mainAgent 通过 tool_call_request 下发 tool_type="subagent" 的工具调用时，
 * 前端需要直连对应的 subagent 执行任务，并将结果回传主会话。
 *
 * 核心职责：
 * 1. 为每个 subagent 创建/复用独立会话（与 BackgroundAgentService 的直连会话隔离）
 * 2. 通过 chatRequest 直连 subagent 执行任务，流式接收回复
 * 3. 支持同一轮中多个 subagent 并行执行
 * 4. 生命周期管理：主会话重置时清理所有 subagent 会话
 *
 * 与 BackgroundAgentService 的关系：
 * - BackgroundAgentService 用于「用户主动触发的后台任务」（如点击生成连线图按钮）
 * - SubagentSessionService 用于「mainAgent 作为工具调用的 subagent」
 * - 两者使用完全独立的 sessionId，互不干扰，可同时运行
 */

import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject, Observable, Subscription } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { ChatAPI } from '../core/api-endpoints';
import { AilyHost } from '../core/host';
import { AilyChatConfigService } from './aily-chat-config.service';
import { TOOLS, ToolUseResult, isDeferredTool, searchDeferredTools, getDeferredToolsListing } from '../tools/tools';
import { getRegisteredSubagents } from '../tools/runSubagentTool';
import { createSecurityContext } from './security.service';
// ToolRegistry: 统一工具调度
import { ToolRegistry } from '../core/tool-registry';
import '../tools/registered/register-all';

import { fetchTool, FetchToolService } from '../tools/fetchTool';
import { ChatService } from './chat.service';

// ===== 类型定义 =====

/** Subagent 工具调用请求（从 SSE 事件中解析） */
export interface SubagentToolCallRequest {
  tool_id: string;
  tool_name: string;
  tool_args: string | Record<string, any>;
  tool_type: 'subagent';
  agent_name: string;
  source?: string;
}

/** Subagent 执行进度事件 */
export interface SubagentProgressEvent {
  type: 'started' | 'streaming' | 'tool_call' | 'tool_call_start' | 'tool_call_end' | 'completed' | 'error';
  agentName: string;
  toolId: string;
  content: string;
  /** 流式文本累积（type=streaming 时持续更新） */
  accumulatedText?: string;
  /** subagent 内部工具调用名（type=tool_call_start/tool_call_end 时） */
  innerToolName?: string;
  /** subagent 内部工具调用 ID（type=tool_call_start/tool_call_end 时） */
  innerToolId?: string;
  /** 工具调用是否失败（type=tool_call_end 时） */
  isError?: boolean;
  timestamp: number;
}

/** Subagent 会话状态 */
interface SubagentSession {
  sessionId: string;
  agentName: string;
  /** 该 subagent 的对话历史（支持多轮内会话复用） */
  messages: any[];
  /** 是否正在执行中 */
  running: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 从持久化恢复的会话，服务端 session 尚未创建 */
  needsServerSession?: boolean;
}

/** Subagent 单轮 chatRequest 的状态收集器（局部变量，支持并发） */
interface SubagentTurnState {
  toolCalls: any[];
  pendingToolResults: any[];
  assistantContent: string;
  taskCompleted: boolean;
  stopReason: string;
}

@Injectable({
  providedIn: 'root'
})
export class SubagentSessionService implements OnDestroy {

  // ===== 状态 =====
  /** agentName → SubagentSession 映射（会话复用） */
  private sessions = new Map<string, SubagentSession>();
  /** 进度事件流（供 UI 消费，可在 subagent 面板实时展示） */
  private progress$ = new Subject<SubagentProgressEvent>();
  /** 活跃的 Observable 订阅 + 立即中止回调（unsubscribe + settleReject） */
  private activeSubscriptions = new Map<string, { sub: Subscription; abort: () => void }>();
  /** 取消标记 */
  private abortedToolIds = new Set<string>();
  /** 会话级：已激活的 deferred 工具名称（通过 search_available_tools 加载） */
  private activatedDeferredTools = new Set<string>();
  /** 工具 fetch 服务 */
  private fetchToolService: FetchToolService;
  /**
   * Per-agent 串行化队列：确保同一 agentName 的调用严格顺序执行。
   *
   * 参考 Copilot 模型：subagent 本质上是一个 tool，父 loop await 完成后才继续。
   * 由于我们的 subagent 从 SSE 事件中 fire-and-forget 调用，无法在调用侧 await，
   * 因此在 SubagentSessionService 内部通过 Promise chain 实现等效的串行化保证：
   * - 同一 agent 的多次调用排队执行，不会并发修改 session.messages
   * - 不同 agent 之间互不影响，可并行执行
   */
  private agentQueues = new Map<string, Promise<any>>();

  constructor(
    private http: HttpClient,
    private ailyChatConfigService: AilyChatConfigService,
    private chatService: ChatService,
  ) {
    this.fetchToolService = new FetchToolService(this.http);
  }

  ngOnDestroy(): void {
    this.cleanupAll();
  }

  // =========================================================================
  // 公共 API
  // =========================================================================

  /** 进度事件流（供 UI 订阅） */
  onProgress(): Observable<SubagentProgressEvent> {
    return this.progress$.asObservable();
  }

  /**
   * 执行一个 subagent 工具调用
   *
   * 完整流程：
   * 1. 获取/创建 subagent 会话
   * 2. 构建用户消息（task + context）
   * 3. 通过 chatRequest 直连 subagent 执行
   * 4. 流式接收回复，实时推送进度
   * 5. 返回完整回复文本
   *
   * @param request 工具调用请求
   * @param timeout 超时时间（ms），默认 120s
   * @returns subagent 的完整回复文本
   */
  async executeSubagentToolCall(
    request: SubagentToolCallRequest,
    timeout?: number,
  ): Promise<string> {
    const { tool_id, tool_name, agent_name } = request;

    // 解析参数
    let args: Record<string, any>;
    try {
      args = typeof request.tool_args === 'string'
        ? JSON.parse(request.tool_args)
        : request.tool_args || {};
    } catch (e) {
      const errMsg = `Subagent 工具参数解析失败: ${(e as Error).message}`;
      this.emitProgress('error', agent_name, tool_id, errMsg);
      throw new Error(errMsg);
    }

    const task = args['task'] || args['content'] || JSON.stringify(args);
    const context = args['context'] || '';
    const userContent = context
      ? `上下文信息:\n${context}\n\n任务:\n${task}`
      : task;

    // 通过 per-agent 队列串行化执行（未指定 timeout 则使用配置值）
    const effectiveTimeout = timeout ?? this.ailyChatConfigService.subagentTimeout;
    return this.enqueueAgentWork(agent_name, tool_id, userContent, effectiveTimeout);
  }

  /**
   * 判断给定的 SSE 事件是否为 subagent 工具调用
   */
  static isSubagentToolCall(event: any): event is SubagentToolCallRequest {
    return event?.tool_type === 'subagent' && !!event?.agent_name;
  }

  /**
   * 获取所有可用的 subagent 名称列表（从 runSubagentTool 注册表中获取）
   */
  static getAvailableAgents(): string[] {
    return getRegisteredSubagents().map(a => a.name);
  }

  /**
   * 用户通过 @agentName 直接与 subagent 对话
   *
   * 与 executeSubagentToolCall 的区别：
   * - 不需要主 Agent 调度，用户直接发起
   * - 使用虚拟 toolId 标识本次对话
   * - 复用相同的 chatWithSubagent 循环
   *
   * @param agentName subagent 名称，如 "schematicAgent"
   * @param userText 用户输入的文本（已去除 @agentName 前缀）
   * @returns subagent 完整回复文本
   */
  async directChat(
    agentName: string,
    userText: string,
    timeout?: number,
  ): Promise<string> {
    const toolId = `direct_${agentName}_${Date.now()}`;

    // 通过 per-agent 队列串行化执行（未指定 timeout 则使用配置值）
    const effectiveTimeout = timeout ?? this.ailyChatConfigService.subagentTimeout;
    return this.enqueueAgentWork(agentName, toolId, userText, effectiveTimeout);
  }

  // =========================================================================
  // Per-agent 串行化队列
  // =========================================================================

  /**
   * 将一次 agent 调用排入该 agent 的串行化队列。
   *
   * 保证同一 agentName 的调用严格顺序执行：
   * - 上一次调用完成（成功/失败）后，下一次才开始
   * - 不同 agentName 互不阻塞，可并行
   * - session.running 真正作为互斥标记生效
   */
  private enqueueAgentWork(
    agentName: string,
    toolId: string,
    userContent: string,
    timeout: number,
  ): Promise<string> {
    const prevWork = this.agentQueues.get(agentName) || Promise.resolve();

    const currentWork = prevWork.then(() =>
      this.doAgentWork(agentName, toolId, userContent, timeout)
    );

    // 更新队列（catch 防止上一个的 reject 阻塞后续入队）
    this.agentQueues.set(agentName, currentWork.catch(() => {}));

    return currentWork;
  }

  /**
   * 实际执行一次 agent 调用（串行化保证只有一个同时在跑）
   */
  private async doAgentWork(
    agentName: string,
    toolId: string,
    userContent: string,
    timeout: number,
  ): Promise<string> {
    const session = await this.getOrCreateSession(agentName);

    // session.running 此时一定是 false（队列串行化保证）
    session.running = true;
    this.emitProgress('started', agentName, toolId, `正在执行 ${agentName}...`);

    try {
      const result = await this.chatWithSubagent(session, userContent, toolId, timeout);
      this.emitProgress('completed', agentName, toolId, `${agentName} 执行完成`);
      return result;
    } catch (error: any) {
      const errMsg = error.message || `${agentName} 执行失败`;
      this.emitProgress('error', agentName, toolId, errMsg);
      throw error;
    } finally {
      session.running = false;
    }
  }

  /**
   * 取消指定工具调用
   */
  cancelToolCall(toolId: string): void {
    this.abortedToolIds.add(toolId);
    const entry = this.activeSubscriptions.get(toolId);
    if (entry) {
      entry.abort();  // 立即 unsubscribe + reject Promise
      this.activeSubscriptions.delete(toolId);
    }
  }

  /**
   * 清理所有 subagent 会话（主会话重置时调用）
   */
  cleanupAll(): void {
    // 先标记所有活跃工具为已取消（确保正在执行中的 chatWithSubagent 循环能检测到）
    for (const toolId of this.activeSubscriptions.keys()) {
      this.abortedToolIds.add(toolId);
    }

    // 立即中止所有活跃的 turn Promise（unsubscribe + settleReject）
    for (const [, entry] of this.activeSubscriptions) {
      entry.abort();
    }
    this.activeSubscriptions.clear();

    // 清空所有 agent 队列（排队中的调用不再执行）
    this.agentQueues.clear();

    // 清空已激活的 deferred 工具
    this.activatedDeferredTools.clear();

    // 取消服务端任务并关闭会话
    for (const [_, session] of this.sessions) {
      session.running = false;
      this.chatService.cancelTask(session.sessionId).subscribe({ error: () => {} });
      this.closeServerSession(session.sessionId);
    }
    this.sessions.clear();

    // 延迟清理 abortedToolIds（给正在执行的工具一点时间检测到取消标记）
    setTimeout(() => this.abortedToolIds.clear(), 2000);
  }

  /**
   * 清理指定 agent 的会话
   */
  cleanupAgent(agentName: string): void {
    const session = this.sessions.get(agentName);
    if (session) {
      session.running = false;
      this.closeServerSession(session.sessionId);
      this.sessions.delete(agentName);
    }
    // 清除该 agent 的串行化队列
    this.agentQueues.delete(agentName);
  }

  // =========================================================================
  // 持久化：导出 / 导入 / Plan C 压缩
  // =========================================================================

  /**
   * 导出所有 subagent 会话数据（供 saveCurrentSession 调用）。
   * 导出前执行 Plan C 压缩：每个 subagent 仅保留最近 maxPairs 轮 user/assistant 对。
   */
  exportSessions(maxPairs: number = 3): Record<string, { sessionId: string; messages: any[] }> {
    const result: Record<string, { sessionId: string; messages: any[] }> = {};
    for (const [agentName, session] of this.sessions) {
      if (session.messages.length === 0) continue;
      result[agentName] = {
        sessionId: session.sessionId,
        messages: this.trimMessages(session.messages, maxPairs),
      };
    }
    return result;
  }

  /**
   * 从持久化数据恢复 subagent 会话（供 getHistory 调用）。
   * 仅恢复内存中的 messages，不重建服务端 session（下次使用时会 getOrCreateSession）。
   */
  importSessions(histories: Record<string, { sessionId: string; messages: any[] }>): void {
    if (!histories) return;
    for (const [agentName, data] of Object.entries(histories)) {
      if (!data.messages || data.messages.length === 0) continue;
      // 如果已有运行中的会话，不覆盖
      if (this.sessions.has(agentName) && this.sessions.get(agentName)!.running) continue;
      this.sessions.set(agentName, {
        sessionId: data.sessionId,  // 旧 ID，首次使用时会重建
        agentName,
        messages: [...data.messages],
        running: false,
        createdAt: Date.now(),
        needsServerSession: true,
      });
    }
  }

  /**
   * Plan C 压缩：保留最近 N 轮 user/assistant 对话对。
   * 规则：从尾部向前扫描，保留最近 maxPairs 个 user 消息及其后的所有非 user 消息。
   * tool 消息视为与其前面的 assistant 消息同组。
   */
  private trimMessages(messages: any[], maxPairs: number): any[] {
    if (messages.length === 0) return [];

    // 找出所有 user 消息的索引
    const userIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') userIndices.push(i);
    }

    if (userIndices.length <= maxPairs) return [...messages];

    // 保留最后 maxPairs 个 user 及其后续消息
    const cutIndex = userIndices[userIndices.length - maxPairs];
    return messages.slice(cutIndex);
  }

  // =========================================================================
  // 会话管理
  // =========================================================================

  /**
   * 获取或创建 subagent 会话
   * 同名 subagent 会复用已有会话（避免每次 tool call 都重建）
   */
  private async getOrCreateSession(agentName: string): Promise<SubagentSession> {
    const existing = this.sessions.get(agentName);
    if (existing && !existing.needsServerSession) {
      return existing;
    }

    // 创建新的服务端会话（新建 or 从持久化恢复后首次使用）
    const sessionId = uuidv4();

    const agentTools = this.getToolsForAgent(agentName);

    const payload = {
      session_id: sessionId,
      agent: agentName,
      tools: agentTools,
      mode: 'agent',
    };

    try {
      const result: any = await this.http.post(ChatAPI.startSession, payload).toPromise();
      if (result?.status !== 'success') {
        throw new Error(result?.message || `创建 ${agentName} 会话失败`);
      }
    } catch (error: any) {
      throw new Error(`创建 ${agentName} 会话失败: ${error.message}`);
    }

    if (existing && existing.needsServerSession) {
      // 恢复场景：保留历史 messages，更新 sessionId
      existing.sessionId = sessionId;
      existing.needsServerSession = false;
      return existing;
    }

    const session: SubagentSession = {
      sessionId,
      agentName,
      messages: [],
      running: false,
      createdAt: Date.now(),
    };

    this.sessions.set(agentName, session);
    return session;
  }

  /**
   * 关闭服务端会话
   */
  private closeServerSession(sessionId: string): void {
    this.http.post(`${ChatAPI.closeSession}/${sessionId}`, {}).toPromise().catch(() => {});
  }

  // =========================================================================
  // 直连执行（Copilot 式无状态 Request-per-Turn 工具调用循环）
  // =========================================================================

  /**
   * 通过 chatRequest 直连 subagent 执行任务 —— 完整工具调用循环
   *
   * 流程：
   * 1. 将用户消息加入会话历史
   * 2. 循环：发送 chatRequest → 处理 SSE → 若有本地工具调用则执行并注入结果 → 重复
   * 3. 收到 TaskCompleted(COMPLETED|TERMINATE|end_turn) 或无更多工具调用时返回最终文本
   *
   * 与之前的区别：
   * - 之前只发一轮 chatRequest，subagent 内部工具调用无法被本地执行，导致结果不完整
   * - 现在实现了与 BackgroundAgentService.runToolCallingLoop() 同等的多轮循环
   */
  private async chatWithSubagent(
    session: SubagentSession,
    userContent: string,
    toolId: string,
    _timeout: number,  // 保留参数签名兼容，实际使用 per-turn idle timeout
  ): Promise<string> {
    session.messages.push({ role: 'user', content: userContent });

    // 参考 Copilot：不设总 deadline，循环仅受迭代次数限制 + 用户取消
    // 每轮 SSE 使用 idle timeout（收到事件重置计时器，仅检测连接卡死）
    const idleTimeout = this.ailyChatConfigService.subagentTimeout;  // 默认 300s 作为单轮空闲上限
    const toolCallLimit = this.ailyChatConfigService?.maxCount || 30;
    let iteration = 0;
    let finalText = '';

    while (iteration < toolCallLimit) {
      if (this.abortedToolIds.has(toolId)) break;

      const turnState: SubagentTurnState = {
        toolCalls: [],
        pendingToolResults: [],
        assistantContent: '',
        taskCompleted: false,
        stopReason: '',
      };

      // console.log(`[SubagentSession] ${session.agentName} 第 ${iteration + 1} 轮请求, messages: ${session.messages.length} 条`);

      await this.processSubagentChatTurn(session, toolId, idleTimeout, turnState);

      if (this.abortedToolIds.has(toolId)) break;

      finalText = turnState.assistantContent;

      // TaskCompleted 且 stop_reason 为终止类型 → 循环结束
      if (turnState.taskCompleted &&
          ['COMPLETED', 'TERMINATE', 'end_turn'].includes(turnState.stopReason)) {
        // console.log(`[SubagentSession] ${session.agentName} 任务完成, stop_reason: ${turnState.stopReason}`);
        break;
      }

      // 没有待处理的工具结果 → 循环结束（纯文本回复或 internal 工具已由服务端处理完）
      if (turnState.pendingToolResults.length === 0) {
        // 如果 taskCompleted 但 stopReason 不是终止类型（如 tool_calls），且没有本地工具结果
        // 说明是 internal 工具循环，但服务端应该在流中已处理完，直接结束
        break;
      }

      // 有本地工具执行结果 → 将 assistant 消息(含 tool_calls) + 工具结果加入对话历史，继续下一轮
      const assistantMessage: any = {
        role: 'assistant',
        content: turnState.assistantContent || ''
      };
      if (turnState.toolCalls.length > 0) {
        assistantMessage.tool_calls = turnState.toolCalls.map(tc => ({
          id: tc.tool_id,
          type: 'function',
          function: {
            name: tc.tool_name,
            arguments: typeof tc.tool_args === 'string' ? tc.tool_args : JSON.stringify(tc.tool_args)
          }
        }));
      }
      session.messages.push(assistantMessage);

      for (const result of turnState.pendingToolResults) {
        session.messages.push({
          role: 'tool',
          tool_call_id: result.tool_id,
          name: result.tool_name,
          content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        });
      }

      iteration++;
      // console.log(`[SubagentSession] ${session.agentName} ${turnState.pendingToolResults.length} 个工具结果已加入对话历史，继续第 ${iteration + 1} 轮`);
    }

    // 将最终的 assistant 回复加入会话历史（支持后续复用）
    if (finalText) {
      session.messages.push({ role: 'assistant', content: finalText });
    }

    return finalText || '(subagent 未返回内容)';
  }

  /**
   * 发送一轮 chatRequest 并处理 SSE 流
   *
   * 与 mainAgent 使用相同的 ChatService.chatRequest() Observable 基础设施：
   * - 取消 = subscription.unsubscribe() → teardown 设 aborted=true + reader.cancel()
   * - 空闲超时 = 每收到 SSE 事件重置计时器，仅检测连接卡死
   * - 错误 = Observable error 回调，不会产生 BodyStreamBuffer was aborted
   *
   * 流事件中遇到非 internal 的 tool_call_request 会立即本地执行，结果收集到 turnState
   */
  private processSubagentChatTurn(
    session: SubagentSession,
    toolId: string,
    idleTimeout: number,
    turnState: SubagentTurnState,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.activeSubscriptions.delete(toolId);
      };
      const settleResolve = () => {
        if (settled) return; settled = true; cleanup(); resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return; settled = true; cleanup(); reject(err);
      };

      // 空闲超时：每收到 SSE 事件重置，仅在连接完全无响应时触发
      const resetIdleTimer = () => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          sub.unsubscribe();
          settleReject(new Error(
            `${session.agentName} 空闲超时 (${idleTimeout / 1000}s 未收到响应)`
          ));
        }, idleTimeout);
      };

      const agentTools = this.getToolsForAgent(session.agentName);

      // 复用 ChatService.chatRequest()，与 mainAgent 完全一致的流处理
      const source$ = this.chatService.chatRequest(
        session.sessionId,
        session.messages,
        agentTools,
        'agent',
        undefined, undefined, undefined,
        session.agentName,
      );

      // 收集异步工具执行的 Promise（tool_call_request 触发的 handleLocalToolCall）
      const pendingWork: Promise<void>[] = [];

      const sub = source$.subscribe({
        next: (event: any) => {
          // 收到事件 → 重置空闲计时器
          resetIdleTimer();

          if (this.abortedToolIds.has(toolId)) {
            sub.unsubscribe();
            settleReject(new Error(`${session.agentName} 执行被取消`));
            return;
          }
          const work = this.handleSubagentStreamEvent(event, session.agentName, toolId, turnState);
          pendingWork.push(work);
        },
        error: (err: any) => {
          // Observable teardown（unsubscribe）触发时不会进入 error
          // 这里只处理真正的网络/HTTP 错误
          if (this.abortedToolIds.has(toolId)) {
            settleReject(new Error(`${session.agentName} 执行被取消`));
          } else {
            const msg = err?.preferredMessage || err?.message || `${session.agentName} 请求失败`;
            settleReject(new Error(msg));
          }
        },
        complete: () => {
          // 流读取完成，等待所有异步工具执行结束
          Promise.all(pendingWork)
            .then(() => settleResolve())
            .catch(err => settleReject(err));
        },
      });

      this.activeSubscriptions.set(toolId, {
        sub,
        abort: () => {
          sub.unsubscribe();
          settleReject(new Error(`${session.agentName} 执行被取消`));
        },
      });

      // 启动首次空闲计时器
      resetIdleTimer();
    });
  }

  // =========================================================================
  // 流事件处理
  // =========================================================================

  /**
   * 处理 subagent SSE 流中的单个事件（async — 支持本地工具执行）
   */
  private async handleSubagentStreamEvent(
    event: any,
    agentName: string,
    toolId: string,
    turnState: SubagentTurnState,
  ): Promise<void> {
    switch (event.type) {
      case 'ModelClientStreamingChunkEvent': {
        const content = event.content || '';
        turnState.assistantContent += content;
        this.emitProgress('streaming', agentName, toolId, content, turnState.assistantContent);
        break;
      }

      case 'tool_call_request': {
        const innerToolName = event.tool_name || 'unknown';
        const innerToolId = event.tool_id || `${toolId}_inner_${Date.now()}`;

        this.emitProgressEx('tool_call_start', agentName, toolId, `${agentName}: 调用 ${innerToolName}...`, {
          innerToolName,
          innerToolId,
        });

        if (event.internal === true) {
          break;
        }

        await this.handleLocalToolCall(event, agentName, toolId, turnState);
        break;
      }

      case 'tool_call_execution': {
        const innerToolName2 = event.tool_name || 'unknown';
        const innerToolId2 = event.tool_id || `${toolId}_inner_${Date.now()}`;
        const isError = !!event.is_error;
        const execResult = isError ? `执行失败` : '执行完成';
        this.emitProgressEx('tool_call_end', agentName, toolId, `${agentName}: ${innerToolName2} ${execResult}`, {
          innerToolName: innerToolName2,
          innerToolId: innerToolId2,
          isError,
        });
        break;
      }

      case 'TaskCompleted': {
        turnState.taskCompleted = true;
        turnState.stopReason = event.stop_reason || event.data?.stop_reason || '';
        // console.log(`[SubagentSession] ${agentName} TaskCompleted, stop_reason: ${turnState.stopReason}`);
        break;
      }

      case 'error': {
        const errMsg = event.message || event.content || '未知错误';
        console.error(`[SubagentSession] ${agentName} 服务端错误:`, errMsg);
        break;
      }
    }
  }

  // =========================================================================
  // 本地工具执行（与 BackgroundAgentService.handleToolCallRequest 同逻辑）
  // =========================================================================

  /**
   * 处理非 internal 的 tool_call_request：本地执行工具并收集结果
   */
  private async handleLocalToolCall(
    event: any,
    agentName: string,
    toolId: string,
    turnState: SubagentTurnState,
  ): Promise<void> {
    const toolName = event.tool_name;
    const innerToolId = event.tool_id;

    turnState.toolCalls.push({
      tool_id: innerToolId,
      tool_name: toolName,
      tool_args: event.tool_args,
    });

    let toolArgs: any;
    try {
      toolArgs = typeof event.tool_args === 'string'
        ? JSON.parse(event.tool_args)
        : event.tool_args || {};
    } catch {
      turnState.pendingToolResults.push({
        tool_id: innerToolId,
        tool_name: toolName,
        content: '参数解析失败',
        is_error: true,
      });
      this.emitProgressEx('tool_call_end', agentName, toolId, `${agentName}: ${toolName} 参数解析失败`, {
        innerToolName: toolName, innerToolId, isError: true,
      });
      return;
    }

    let result: ToolUseResult;
    try {
      result = await this.executeTool(toolName, toolArgs, agentName);
    } catch (error: any) {
      result = { is_error: true, content: `工具执行异常: ${error.message}` };
    }

    const isError = result.is_error || false;
    this.emitProgressEx('tool_call_end', agentName, toolId,
      `${agentName}: ${toolName} ${isError ? '失败' : '完成'}`, {
        innerToolName: toolName, innerToolId, isError,
      });

    turnState.pendingToolResults.push({
      tool_id: innerToolId,
      tool_name: toolName,
      content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
      is_error: isError,
    });
  }

  /**
   * 路由工具调用到具体的处理函数。
   * 优先通过 ToolRegistry 统一调度，减少重复 switch/case。
   */
  private async executeTool(toolName: string, args: any, agentName?: string): Promise<ToolUseResult> {
    // 元工具：search_available_tools — 搜索并激活 deferred 工具
    if (toolName === 'search_available_tools') {
      return this.handleSearchAvailableTools(args, agentName);
    }

    // 已注册工具：通过 ToolRegistry 统一调度
    if (ToolRegistry.has(toolName)) {
      const ctx = {
        host: AilyHost.get(),
        securityContext: createSecurityContext(AilyHost.get().project.currentProjectPath || ''),
      };
      return ToolRegistry.execute(toolName, args, ctx);
    }

    // 未注册工具：返回错误
    return { is_error: true, content: `Subagent 不支持工具: ${toolName}` };
  }

  /**
   * 处理 search_available_tools 元工具调用
   * 搜索匹配的 deferred 工具并激活，下一轮 chatRequest 会自动包含
   */
  private handleSearchAvailableTools(args: any, agentName?: string): ToolUseResult {
    const query = args?.query || '';
    const agentConfig = this.ailyChatConfigService.getAgentToolsConfig(agentName || '');
    const excludeTools = new Set(agentConfig.disabledTools || []);
    const allTools = TOOLS as any[];
    const matched = searchDeferredTools(query, allTools, agentName, excludeTools);

    if (matched.length > 0) {
      matched.forEach(t => this.activatedDeferredTools.add(t.name));
      const listing = matched.map(t => `- **${t.name}**: ${(t.description || '').split('\n')[0].slice(0, 80)}`).join('\n');
      return { is_error: false, content: `已加载 ${matched.length} 个工具，可在后续对话中直接调用：\n${listing}` };
    }
    return { is_error: false, content: `未找到匹配 "${query}" 的工具。\n${getDeferredToolsListing(agentName, excludeTools)}` };
  }

  // =========================================================================
  // 进度推送
  // =========================================================================

  private emitProgress(
    type: SubagentProgressEvent['type'],
    agentName: string,
    toolId: string,
    content: string,
    accumulatedText?: string,
  ): void {
    this.progress$.next({
      type,
      agentName,
      toolId,
      content,
      accumulatedText,
      timestamp: Date.now(),
    });
  }

  private emitProgressEx(
    type: SubagentProgressEvent['type'],
    agentName: string,
    toolId: string,
    content: string,
    extra: { innerToolName?: string; innerToolId?: string; isError?: boolean; accumulatedText?: string } = {},
  ): void {
    this.progress$.next({
      type,
      agentName,
      toolId,
      content,
      innerToolName: extra.innerToolName,
      innerToolId: extra.innerToolId,
      isError: extra.isError,
      accumulatedText: extra.accumulatedText,
      timestamp: Date.now(),
    });
  }

  // =========================================================================
  // 工具定义
  // =========================================================================

  private getToolsForAgent(agentName: string): any[] {
    // 1. 按 agents 字段过滤
    let tools = (TOOLS as any[]).filter(tool => {
      if (!tool.agents) return false;
      return tool.agents.includes(agentName);
    });
    // 2. 按 aily config 配置过滤（尊重用户的 enabledTools/disabledTools 设置）
    const agentConfig = this.ailyChatConfigService.getAgentToolsConfig(agentName);
    const disabledTools = new Set(agentConfig.disabledTools || []);
    if (disabledTools.size > 0) {
      tools = tools.filter(tool => !disabledTools.has(tool.name));
    }
    // 3. 过滤 deferred 工具（仅发送 core 工具 + 已激活的 deferred 工具）
    tools = tools.filter(tool =>
      !isDeferredTool(tool.name) || this.activatedDeferredTools.has(tool.name)
    );
    return tools;
  }
}
