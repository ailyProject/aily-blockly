/**
 * ChatEngineService — aily-chat 核心业务逻辑引擎
 *
 * 从 AilyChatComponent 中提取的全部业务逻辑、副作用和共享状态。
 * Component 仅保留 Angular 生命周期、模板绑定和 UI 事件处理器。
 *
 * 职责：
 * - 会话生命周期管理（start / stop / close / new / history）
 * - 消息发送与工具调用循环（stateless turn loop）
 * - SSE 流处理与事件分发
 * - 订阅管理（项目路径、登录状态、配置变更等）
 */

import { Injectable, ElementRef, NgZone } from '@angular/core';
import { Subscription, skip, distinctUntilChanged, combineLatest } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';

import { ChatService, ChatTextOptions, ModelConfig } from './chat.service';
import { McpService } from './mcp.service';
import { AilyChatConfigService } from './aily-chat-config.service';
import { ChatHistoryService } from './chat-history.service';
import { RepetitionDetectionService } from './repetition-detection.service';
import { ContextBudgetService, ContextBudgetSnapshot } from './context-budget.service';
import { SubagentSessionService, SubagentProgressEvent } from './subagent-session.service';
import { AbsAutoSyncService } from './abs-auto-sync.service';
import { EditCheckpointService } from './edit-checkpoint.service';
import { ScrollManagerService } from './scroll-manager.service';
import { ResourceManagerService } from './resource-manager.service';
import { MenuManagerService } from './menu-manager.service';
import { TodoUpdateService } from './todoUpdate.service';

import { ChatMessage, Tool, ToolCallState, ResourceItem } from '../core/chat-types';
import { AilyHost } from '../core/host';
import { ToolRegistry } from '../core/tool-registry';
import { createSecurityContext } from './security.service';
import { TOOLS } from '../tools/tools';
import { syncAbsFileHandler } from '../tools/syncAbsFileTool';
import { registerAskUserCallback, unregisterAskUserCallback, AskUserQuestion, AskUserFullResponse, AskUserAnswer } from '../tools/askUserTool';
import { cleanupAllTerminalSessions } from '../tools/terminalSessionTool';
import { toolRequiresApproval, requestToolApproval, registerToolApprovalCallback, unregisterToolApprovalCallback, approveToolForSession, enableSessionSafeMode, clearSessionApprovals, ToolApprovalRequest, ToolApprovalResult } from '../core/tool-approval';

import { AILY_CHAT_ONBOARDING_CONFIG } from '../../../configs/onboarding.config';

import { MessageDisplayHelper } from '../helpers/message-display.helper';
import { SessionLifecycleHelper } from '../helpers/session-lifecycle.helper';
import { StreamProcessorHelper } from '../helpers/stream-processor.helper';
import { ToolCallLoopHelper } from '../helpers/tool-call-loop.helper';
import { TurnManager } from '../core/turn-manager';
import { AilyChatHookService } from './chat-hook.service';
import { ChatViewAdapter } from './chat-view-adapter';
import { ChatPerformanceTracer } from './chat-perf-tracer';

@Injectable()
export class ChatEngineService {

  // ==================== 辅助类 ====================
  readonly msg = new MessageDisplayHelper(this);
  readonly session = new SessionLifecycleHelper(this);
  readonly stream = new StreamProcessorHelper(this);
  readonly turnLoop = new ToolCallLoopHelper(this);

  // ==================== rAF 批处理 UI 适配器 ====================
  /** 流式文本走 rAF 合并，每帧只触发一次 Angular CD（参考 Copilot FetchStreamSource pause/unpause） */
  readonly viewAdapter: ChatViewAdapter = null!; // 由 constructor 初始化

  // ==================== Hook 系统 — 参考 Copilot IChatHookService ====================
  /** 中心化 Hook 注册与执行引擎，支持 PreToolUse/PostToolUse/Stop 等生命周期拦截 */
  readonly hookService = new AilyChatHookService();

  // ==================== Turn 结构化存储（source of truth） ====================
  /** Copilot 风格 Turn[] 存储管理器，唯一 source of truth */
  readonly turnManager = new TurnManager();

  // ==================== 公共状态（模板绑定） ====================
  list: ChatMessage[] = [];
  inputValue = '';
  prjRootPath = '';
  prjPath = '';
  currentUserGroup: string[] = [];
  isCompleted = false;
  isLoggedIn = false;
  debug = false;

  // ==================== 半公共状态 ====================
  sessionAllowedPaths: string[] = [];
  currentMessageSource: string = 'mainAgent';
  toolCallStates: { [key: string]: string } = {};

  // ==================== 内置工具 ====================
  tools: Tool[] = TOOLS;

  // ==================== 内部状态（helper 可访问） ====================
  isSessionStarting = false;
  hasInitializedForThisLogin = false;
  isCancelled = false;
  useStatelessMode = true;
  /** 只读视图：从 Turn[] 派生的消息数组（不要直接修改） */
  get conversationMessages(): any[] { return this.turnManager.buildMessages(); }
  pendingToolResults: any[] = [];
  currentTurnAssistantContent = '';
  currentTurnToolCalls: any[] = [];
  toolCallingIteration = 0;
  activeToolExecutions = 0;
  sseStreamCompleted = false;
  currentStatelessMode = false;
  serverSessionActive = false;

  /** 缓存的编辑反馈（用户保留/撤销变更后，在下次发送时注入上下文） */
  private pendingEditFeedback: string | null = null;
  /** 用于中止当前轮次中工具执行的 AbortController */
  private abortController: AbortController | null = null;

  setServerSessionInactive() { this.serverSessionActive = false; }
  pendingUserInput = false;
  streamCompleted = false;
  private _isWaiting = false;
  insideThink = false;
  mcpInitialized = false;
  private _aiNoticeShown = false;
  lastStopReason = '';
  /** 会话级：已激活的 deferred 工具名称集合（通过 search_available_tools 加载） */
  activatedDeferredTools = new Set<string>();

  /** 延迟切换：活跃请求期间暂存待切换的模型/模式，完成后自动应用 */
  _pendingModelSwitch: ModelConfig | null = null;
  _pendingModeSwitch: string | null = null;

  /** autoSend 消息在 sessionId 未就绪时的暂存区，startSession 完成后自动冲刷 */
  private _pendingAutoSendText: string | null = null;

  /** ask_user 工具的 Promise resolve 回调（等待用户在聊天界面输入） */
  _resolveAskUser: ((response: AskUserFullResponse | undefined) => void) | null = null;
  /** 当前 ask_user 的问题列表（用于事件回调时组装答案） */
  private _askUserQuestions: AskUserQuestion[] | null = null;

  /** OnPush 组件变更检测回调，由 component 注入 */
  private detectChangesCallback?: () => void;

  /** 工具审批 Promise resolve 回调（等待用户在聊天界面确认） */
  _resolveToolApproval: ((result: ToolApprovalResult) => void) | null = null;

  // ==================== 订阅 ====================
  messageSubscription: any;
  private textMessageSubscription: Subscription;
  private loginStatusSubscription: Subscription;
  private aiWritingSubscription: Subscription;
  private aiWaitingSubscription: Subscription;
  private projectPathSubscription: Subscription;
  private configChangedSubscription: Subscription;
  private blockSelectionSubscription: Subscription;
  private subagentProgressSubscription: Subscription;
  private uiChatMessageSubscription: Subscription;
  private taskActionHandler: ((event: Event) => void) | null = null;

  // ==================== 外部引用 ====================
  private chatTextareaRef: ElementRef | null = null;

  // ==================== Getters / Setters ====================

  get sessionId() { return this.chatService.currentSessionId; }
  set sessionId(value: string) { this.chatService.currentSessionId = value; }

  get sessionTitle() { return this.chatService.currentSessionTitle; }

  get currentMode() { return this.chatService.currentMode; }

  get currentModel() { return this.chatService.currentModel; }

  get currentModelName() { return this.chatService.currentModel?.name; }

  get isWaiting() { return this._isWaiting; }
  set isWaiting(value: boolean) {
    this._isWaiting = value;
    this.chatService.isWaiting = value;
    AilyHost.get().blockly.aiWaiting = value;
    if (!value) {
      this.aiWriting = false;
      AilyHost.get().blockly.aiWaitWriting = false;
    }
  }

  set aiWriting(value: boolean) {
    AilyHost.get().blockly.aiWriting = value;
  }

  get contextBudget$() { return this.contextBudgetService?.budget$; }

  get contextBudgetSnapshot(): ContextBudgetSnapshot | null {
    return this.contextBudgetService?.getSnapshot() ?? null;
  }

  // ==================== 构造函数 ====================

  constructor(
    public chatService: ChatService,
    public mcpService: McpService,
    public ailyChatConfigService: AilyChatConfigService,
    public chatHistoryService: ChatHistoryService,
    public repetitionDetectionService: RepetitionDetectionService,
    public contextBudgetService: ContextBudgetService,
    public subagentSessionService: SubagentSessionService,
    public ngZone: NgZone,
    private absAutoSyncService: AbsAutoSyncService,
    public editCheckpointService: EditCheckpointService,
    public translate: TranslateService,
    public message: NzMessageService,
    public scrollManager: ScrollManagerService,
    public resourceManager: ResourceManagerService,
    public menuManager: MenuManagerService,
    public todoUpdateService: TodoUpdateService,
  ) {
    // 初始化 viewAdapter（需要 ngZone 已注入）
    (this as any).viewAdapter = new ChatViewAdapter(
      () => this.list,
      (msg) => this.list.push(msg),
      () => this.currentMessageSource,
      () => this.currentModelName || undefined,
      () => this._isWaiting,
      () => { if (this.sessionId) { this.chatHistoryService.markDirty(this.sessionId); } },
      this.ngZone,
      undefined, // cdCallback — 由 component 通过 setCdCallback 注入
      () => this.scrollManager.scrollToBottom(), // scrollToBottom — 流式 rAF flush 后自动滚动
    );
  }

  /** 注册 OnPush CD 回调（由 component 调用 cdr.markForCheck） */
  setCdCallback(cb: () => void): void {
    this.detectChangesCallback = cb;
    (this.viewAdapter as any).cdCallback = cb;
  }

  // ==================== 初始化 / 销毁 ====================

  /**
   * 引擎初始化 — 由 Component 的 ngOnInit 调用
   * @param chatTextareaRef 输入框 ElementRef（用于自动聚焦）
   */
  init(chatTextareaRef: ElementRef | null): void {
    this.chatTextareaRef = chatTextareaRef;
    this.chatService.isWaiting = this._isWaiting;

    this.prjPath = AilyHost.get().project.currentProjectPath === AilyHost.get().project.projectRootPath
      ? '' : AilyHost.get().project.currentProjectPath;
    this.prjRootPath = AilyHost.get().project.projectRootPath;

    // 初始化时：如果项目已打开，立即执行孤儿领养（订阅的 skip(1) 会跳过初始值）
    if (this.prjPath) {
      const adopted = this.chatHistoryService.adoptOrphanSessions(this.prjPath, this.prjRootPath);
      if (adopted > 0) {
        console.log(`[ChatEngine] 初始化时领养 ${adopted} 个孤儿会话到: ${this.prjPath}`);
      }
    }

    // 注册 ask_user 回调：在聊天界面显示全部问题并等待用户回答
    registerAskUserCallback((questions) => this._handleAskUser(questions));

    // 注册工具审批回调：在聊天界面显示确认 UI 并等待用户批准
    registerToolApprovalCallback((request) => this._handleToolApproval(request));

    this.setupSubscriptions();
  }

  /**
   * 引擎销毁 — 由 Component 的 ngOnDestroy 调用
   */
  destroy(): void {
    this.viewAdapter.destroy();
    this.chatService.isWaiting = false;
    this.session.saveCurrentSession();
    this.chatHistoryService.flushAll();
    this.editCheckpointService.clear();

    unregisterAskUserCallback();
    unregisterToolApprovalCallback();
    cleanupAllTerminalSessions();
    this._resolveAskUser = null;
    this._resolveToolApproval = null;

    this.cleanupSubscriptions();
    this.session.disconnect();

    this.viewAdapter.markLastMessageDone();
  }

  // ==================== 订阅管理 ====================

  private setupSubscriptions(): void {
    // 订阅外部文本消息（ChatService 内部 Subject）
    this.textMessageSubscription = this.chatService.getTextMessages().subscribe(
      message => {
        if (!message) {
          return;
        }
        this.receiveTextFromExternal(message.text, message.options);
        this.chatService.clearBufferedTextMessage(message.timestamp);
      }
    );

    // 订阅通过 UiService 从外部发来的聊天消息（通过 AilyHost 抽象层解耦）
    const uiChatMessage$ = AilyHost.get().ui?.chatMessage$;
    if (uiChatMessage$) {
      this.uiChatMessageSubscription = uiChatMessage$.subscribe(
        (message: any) => {
          this.receiveTextFromExternal(message.text, message.options);
        }
      );
    }

    AilyHost.get().authFull?.initializeAuth().then(() => {
      AilyHost.get().authFull?.userInfo$.subscribe(userInfo => {
        this.currentUserGroup = userInfo?.groups || [];
      });
    });

    this.aiWritingSubscription = AilyHost.get().blockly.aiWriting$.subscribe(this.showAiWritingNotice.bind(this));
    this.aiWaitingSubscription = AilyHost.get().blockly.aiWaiting$.subscribe(this.showAiWritingNotice.bind(this));

    // 订阅 Blockly 块选中变化 + 代码映射变化
    this.blockSelectionSubscription = combineLatest([
      AilyHost.get().blockly.selectedBlockSubject,
      AilyHost.get().blockly.blockCodeMapSubject
    ]).subscribe((results: any[]) => {
      this.resourceManager.updateBlockContext(results[0], () => AilyHost.get().blockly.getSelectedBlockContextLabel());
    });

    // 绑定任务操作事件监听
    this.taskActionHandler = this.handleTaskAction.bind(this);
    document.addEventListener('aily-task-action', this.taskActionHandler);

    // 订阅 subagent 执行进度
    // viewAdapter 方法内部已处理 NgZone 边界，无需外部 ngZone.run()
    this.subagentProgressSubscription = this.subagentSessionService.onProgress()
      .subscribe((event: SubagentProgressEvent) => {
        if (!this.isWaiting) return;
        const agentSource = event.agentName || 'subAgent';
        switch (event.type) {
          case 'streaming':
            if (event.content) { this.msg.appendStreaming('aily', event.content, agentSource); }
            break;
          case 'tool_call_start': {
            const innerId = event.innerToolId || `${event.toolId}_inner_${Date.now()}`;
            const innerName = event.innerToolName || 'unknown';
            this.msg.startToolCall(innerId, innerName, `${agentSource}: ${innerName}...`, undefined, agentSource);
            break;
          }
          case 'tool_call_end': {
            const innerId = event.innerToolId || `${event.toolId}_inner_${Date.now()}`;
            const innerName = event.innerToolName || 'unknown';
            const state = event.isError ? ToolCallState.ERROR : ToolCallState.DONE;
            const text = event.isError ? `${agentSource}: ${innerName} 失败` : `${agentSource}: ${innerName} 完成`;
            this.msg.completeToolCall(innerId, innerName, state, text, agentSource);
            break;
          }
          case 'tool_call':
            this.msg.appendMessage('aily', `\n\n> 🛠️ ${event.content}\n\n`, agentSource);
            break;
          case 'error':
            this.msg.appendMessage('aily', `\n\n> ❌ ${event.content}\n\n`, agentSource);
            break;
        }
      });

    // 订阅项目路径变化
    this.projectPathSubscription = AilyHost.get().project.currentProjectPath$.pipe(
      distinctUntilChanged(), skip(1)
    ).subscribe((newPath: string) => {
      const rootPath = AilyHost.get().project.projectRootPath;
      this.prjPath = newPath === rootPath ? '' : newPath;
      this.prjRootPath = rootPath;

      // 同步更新 currentSessionPath，防止保存到旧路径/rootPath
      if (newPath && newPath !== rootPath) {
        this.chatService.currentSessionPath = newPath;
      }

      // 新建项目时自动领养根目录下的孤儿会话
      if (newPath && newPath !== rootPath) {
        // 先加载新项目的本地索引（项目级优先）
        this.chatHistoryService.reloadProjectIndex(newPath);
        const adopted = this.chatHistoryService.adoptOrphanSessions(newPath, rootPath);
        if (adopted > 0) {
          console.log(`[ChatEngine] 项目切换，自动领养 ${adopted} 个孤儿会话到: ${newPath}`);
        }
      }

      this.session.refreshHistoryList();
      if (newPath && newPath !== rootPath) {
        this.absAutoSyncService.initialize(newPath);
      }
    });

    // 订阅登录状态变化
    this.loginStatusSubscription = AilyHost.get().authFull?.isLoggedIn$.subscribe(
      async isLoggedIn => {
        if (!this.hasInitializedForThisLogin && !this.isSessionStarting && isLoggedIn) {
          this.isLoggedIn = isLoggedIn;
          this.hasInitializedForThisLogin = true;
          this.list = [];
          this.session.startSession().then(() => {
            this.session.getHistory();
            this.checkFirstUsage();
            // 冲刷因 sessionId 未就绪而暂存的 autoSend 消息
            if (this._pendingAutoSendText) {
              const txt = this._pendingAutoSendText;
              this._pendingAutoSendText = null;
              this.inputValue = txt;
              this.detectChangesCallback?.();
              setTimeout(() => this.send('user', txt, true), 50);
            }
          }).catch(() => {});
        }

        if (isLoggedIn) {
          // logged in
        } else {
          try { await this.session.stopAndCloseSession(); } catch (error) { console.warn('清理会话时出错:', error); }
          this.hasInitializedForThisLogin = false;
          this.mcpInitialized = false;
          this.isWaiting = false;
          this.isCompleted = false;
          this.isSessionStarting = false;
          this.chatService.currentSessionId = '';
          this.chatService.currentSessionPath = '';
          this.list = [];
          this.toolCallStates = {};
          if (this.messageSubscription) { this.messageSubscription.unsubscribe(); this.messageSubscription = null; }
        }
      }
    );

    // 订阅配置变更
    this.configChangedSubscription = this.ailyChatConfigService.configChanged$.subscribe(
      async (newConfig) => {
        const hasConversationHistory = this.list.length > 0;
        if (!hasConversationHistory && this.sessionId && this.isLoggedIn) {
          try {
            await this.session.stopAndCloseSession(true);
            await this.session.startSession();
            this.message.success('配置已更新并生效');
          } catch (error) {
            console.warn('重新启动会话失败:', error);
            this.message.warning('配置更新失败，请尝试新建对话');
          }
        } else if (hasConversationHistory) {
          this.message.info('配置已保存，将在下次新建对话时生效');
        }
      }
    );
  }

  private cleanupSubscriptions(): void {
    if (this.messageSubscription) { this.messageSubscription.unsubscribe(); this.messageSubscription = null; }
    if (this.textMessageSubscription) { this.textMessageSubscription.unsubscribe(); this.textMessageSubscription = null; }
    if (this.loginStatusSubscription) { this.loginStatusSubscription.unsubscribe(); this.loginStatusSubscription = null; }
    if (this.aiWritingSubscription) { this.aiWritingSubscription.unsubscribe(); this.aiWritingSubscription = null; }
    if (this.aiWaitingSubscription) { this.aiWaitingSubscription.unsubscribe(); this.aiWaitingSubscription = null; }
    if (this.projectPathSubscription) { this.projectPathSubscription.unsubscribe(); this.projectPathSubscription = null; }
    if (this.configChangedSubscription) { this.configChangedSubscription.unsubscribe(); this.configChangedSubscription = null; }
    if (this.blockSelectionSubscription) { this.blockSelectionSubscription.unsubscribe(); this.blockSelectionSubscription = null; }
    if (this.subagentProgressSubscription) { this.subagentProgressSubscription.unsubscribe(); this.subagentProgressSubscription = null; }
    if (this.uiChatMessageSubscription) { this.uiChatMessageSubscription.unsubscribe(); this.uiChatMessageSubscription = null; }
    if (this.taskActionHandler) { document.removeEventListener('aily-task-action', this.taskActionHandler); this.taskActionHandler = null; }
    this.isSessionStarting = false;
    this.mcpInitialized = false;
    this.hasInitializedForThisLogin = false;
  }

  // ==================== 辅助方法 ====================

  getCurrentProjectPath(): string {
    return AilyHost.get().project.currentProjectPath !== AilyHost.get().project.projectRootPath
      ? AilyHost.get().project.currentProjectPath : '';
  }

  private get securityContext(): ReturnType<typeof createSecurityContext> {
    const securityWorkspaces = this.ailyChatConfigService.securityWorkspaces;
    return createSecurityContext(this.getCurrentProjectPath(), {
      allowProjectPathAccess: securityWorkspaces.project,
      allowNodeModulesAccess: securityWorkspaces.library,
      additionalAllowedPaths: this.sessionAllowedPaths
    });
  }

  private buildToolContext(): any {
    return {
      host: AilyHost.get(),
      securityContext: this.securityContext,
      sessionId: this.sessionId,
      editCheckpoint: this.editCheckpointService,
      abortSignal: this.abortController?.signal,
    };
  }

  public async executeRegisteredTool(
    toolCallId: string, toolName: string, toolArgs: any
  ): Promise<{ toolResult: any; resultState: string; resultText: string }> {
    const tool = ToolRegistry.get(toolName);
    if (!tool) {
      return { toolResult: { is_error: true, content: `未知工具: ${toolName}` }, resultState: 'error', resultText: `未知工具: ${toolName}` };
    }
    const displayMode = tool.displayMode || 'toolCall';
    const startText = ToolRegistry.getStartText(toolName, toolArgs);

    // ── 工具审批拦截 ──
    // 对需要审批的工具，等待用户确认后再执行（审批 UI 由 aily-approval 块提供，不需要额外 aily-state）
    if (toolRequiresApproval(toolName, toolArgs)) {
      const approval = await requestToolApproval(toolCallId, toolName, toolArgs);
      if (!approval.approved) {
        const rejectReason = approval.reason || '用户拒绝执行';
        const rejectResult = { is_error: false, content: `操作已取消: ${rejectReason}` };
        if (displayMode === 'toolCall') {
          this.msg.startToolCall(toolCallId, toolName, `已取消: ${startText}`, toolArgs);
          this.msg.completeToolCall(toolCallId, toolName, ToolCallState.WARN, `已取消: ${startText}`);
        } else if (displayMode === 'appendMessage') {
          const safeText = this.msg.makeJsonSafe(`已取消: ${startText}`);
          this.msg.appendMessage('aily', `\n\`\`\`aily-state\n{\n  "state": "warn",\n  "text": "${safeText}",\n  "id": "${toolCallId}"\n}\n\`\`\`\n\n`);
        }
        return { toolResult: rejectResult, resultState: 'warn', resultText: `已取消: ${startText}` };
      }
      // 用户已批准，处理会话级授权
      if (approval.scope === 'session') {
        approveToolForSession(toolName);
      } else if (approval.scope === 'session-safe') {
        enableSessionSafeMode();
      }
      // 批准后显示正常执行状态
      if (displayMode === 'toolCall') {
        if (startText) { this.msg.startToolCall(toolCallId, toolName, startText, toolArgs); }
      } else if (displayMode === 'appendMessage') {
        const safeText = startText.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '').replace(/\t/g, ' ');
        if (safeText) {
          this.msg.appendMessage('aily', `\n\`\`\`aily-state\n{\n  "state": "doing",\n  "text": "${safeText}",\n  "id": "${toolCallId}"\n}\n\`\`\`\n\n`);
        }
      }
    } else {
      // 不需要审批的工具，直接显示正常执行状态
      if (displayMode === 'appendMessage') {
        const safeText = startText.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '').replace(/\t/g, ' ');
        if (safeText) {
          this.msg.appendMessage('aily', `\n\`\`\`aily-state\n{\n  "state": "doing",\n  "text": "${safeText}",\n  "id": "${toolCallId}"\n}\n\`\`\`\n\n`);
        }
      } else if (displayMode === 'toolCall') {
        if (startText) { this.msg.startToolCall(toolCallId, toolName, startText, toolArgs); }
      }
    }

    const ctx = this.buildToolContext();

    // ★ P0-perf: flushDataOnly 已在 tool_call_request 入口同步提交数据到 list，
    // 不触发 NgZone CD，x-markdown 渲染在下一帧异步完成。
    // 无需 yield 等待渲染，直接执行工具。

    const _execSpan = ChatPerformanceTracer.begin('tool_execute', toolName);
    const toolResult = await ToolRegistry.execute(toolName, toolArgs, ctx);
    ChatPerformanceTracer.end(_execSpan, 'tool_execute', `${toolName} err=${toolResult?.is_error ?? false}`);
    const resultText = ToolRegistry.getResultText(toolName, toolArgs, toolResult);
    if (toolName === 'create_project' && toolResult?.is_error) {
      AilyHost.get().ui?.updateFooterState({ state: 'warn', text: '项目创建失败' });
    }
    let resultState = 'done';
    if (toolResult?.is_error) { resultState = 'error'; }
    else if (toolResult?.warning) { resultState = 'warn'; }
    return { toolResult, resultState, resultText };
  }

  getKeyInfo = async () => {
    const shell = await AilyHost.get().terminal.getShell();
    return `
<keyinfo>
项目存放根路径(**rootFolder**): ${AilyHost.get().project.projectRootPath || '无'}
当前项目路径(**path**): ${this.getCurrentProjectPath() || '无'}
当前项目库存放路径(**librariesPath**): ${this.getCurrentProjectPath() ? this.getCurrentProjectPath() + '/node_modules/@aily-project' : '无'}
appDataPath(**appDataPath**): ${AilyHost.get().path.getAppDataPath() || '无'}
 - 包含SDK文件、编译器工具等，boards.json-开发板列表 libraries.json-库列表 等缓存到此路径
转换库存放路径(**libraryConversionPath**): ${this.getCurrentProjectPath() ? this.getCurrentProjectPath() : (AilyHost.get().path.join(AilyHost.get().path.getAppDataPath(), 'libraries') || '无')}
当前使用的语言(**lang**)： ${AilyHost.get().config.data?.lang || 'zh-cn'}
操作系统(**os**): ${AilyHost.get().platform.type || 'unknown'}
当前命令行终端(**terminal**): ${shell || 'unknown'}
</keyinfo>
<keyinfo>
uses get_hardware_categories tool to get hardware categories before searching boards and libraries.
uses search_boards_libraries tool to search for boards and libraries based on user needs.
Do not create non-existent boards and libraries.
</keyinfo>
`;
  }

  generateTitle(content: string): void {
    if (this.sessionTitle) return;
    const initialTitle = content.length > 20 ? content.substring(0, 20) + '...' : content;
    this.chatService.currentSessionTitle = initialTitle;
    this.chatHistoryService.updateTitle(this.sessionId, initialTitle);
    this.session.refreshHistoryList();
    if (content.length <= 20) return;
    const titleContent = content.length > 500 ? content.substring(0, 500) : content;
    this.chatService.generateTitle(this.sessionId, titleContent, (title: string) => {
      this.chatService.currentSessionTitle = title;
      this.chatHistoryService.updateTitle(this.sessionId, title);
      this.session.refreshHistoryList();
    });
  }

  showAiWritingNotice(isWaiting: boolean): void {
    if (isWaiting) {
      this._aiNoticeShown = true;
      AilyHost.get().notice?.update({
        title: 'AI正在操作', state: 'doing', showProgress: false, setTimeout: 0,
        stop: () => { this.stop(); },
      });
    } else if (this._aiNoticeShown) {
      this._aiNoticeShown = false;
      AilyHost.get().notice?.clear();
    }
  }

  receiveTextFromExternal(text: string, options?: ChatTextOptions): void {
    if (options?.type === 'button') {
      if (text === '重试') { this.retryLastAction(); return; }
      if (text === '重新生成') { this.regenerateTurn(); return; }
      if (text === '撤销变更') { this.undoLastEdits(); return; }
      if (text === '新建会话') { this.newChat(); return; }
      this.send('user', text, false);
      this.scrollManager.autoScrollEnabled = true;
      this.scrollManager.scrollToBottom();
      return;
    }
    // 当前有对话正在执行时，拦截 autoSend 请求并提示用户
    if (options?.autoSend && this.isWaiting) {
      this.message.warning('当前对话正在执行中，请等待完成后再试');
      return;
    }
    if (options?.cover === false) {
      this.inputValue = this.inputValue ? this.inputValue + '\n' + text : text;
    } else {
      this.inputValue = text;
    }
    this.detectChangesCallback?.();
    setTimeout(() => {
      if (this.chatTextareaRef?.nativeElement) {
        const textarea = this.chatTextareaRef.nativeElement;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
      if (options?.autoSend) {
        if (this.sessionId) {
          // sessionId 已就绪，直接发送
          this.send('user', this.inputValue, true);
        } else {
          // sessionId 尚未就绪（startSession 仍在进行 / 未登录）
          // 暂存文本，等待 startSession 完成后自动冲刷
          this._pendingAutoSendText = this.inputValue;
        }
      }
    }, 100);
  }

  // ==================== 外观方法（转发到 helper） ====================

  saveCurrentSession(): void { this.session.saveCurrentSession(); }
  refreshHistoryList(): void { this.session.refreshHistoryList(); }
  newChat(): Promise<void> { return this.session.newChat(); }
  getHistory(): void { this.session.getHistory(); }
  getCurrentTools(): any[] { return this.turnLoop.getCurrentTools(); }
  getCurrentLLMConfig(): any { return this.turnLoop.getCurrentLLMConfig(); }

  // ==================== 消息发送 ====================

  async send(sender: string, content: string, clear: boolean = true): Promise<void> {
    if (this.isCancelled && sender === 'tool') return;

    if (this.isCompleted) {
      this.isCancelled = false;
      if (this.useStatelessMode) {
        this.isCompleted = false;
        if (!this.serverSessionActive) { await this.session.ensureServerSession(); }
      } else {
        await this.session.resetChat();
      }
    }

    this.scrollManager.autoScrollEnabled = true;
    let text = content.trim();
    if (!this.sessionId || !text) return;

    let llmText = text;
    let displayText = text;

    if (sender === 'user') {
      if (this.isWaiting) return;
      if (this.isCancelled) {
        this.isCancelled = false;
        this.pendingUserInput = false;
        this.streamCompleted = false;
        this.sseStreamCompleted = false;
        this.activeToolExecutions = 0;
      }
      this.repetitionDetectionService.resetStreamTokens();
      this.insideThink = false;
      this.generateTitle(text);

      // @agentName 直连路由：跳过 mainAgent，直接与子 Agent 对话
      const atMatch = text.match(/^@(\w+)\s+([\s\S]+)/);
      if (atMatch) {
        const targetAgent = atMatch[1];
        const agentText = atMatch[2].trim();
        const availableAgents = SubagentSessionService.getAvailableAgents();
        if (availableAgents.includes(targetAgent) && agentText) {
          this.isWaiting = true;
          this.msg.appendMessage('user', text);
          this.msg.appendMessage('aily', '[thinking...]', targetAgent);
          if (clear) { this.inputValue = ''; }
          this.sendToSubagentDirect(targetAgent, agentText);
          return;
        }
      }

      const resourcesText = this.resourceManager.getResourcesText();
      // 消费缓存的编辑反馈（保留/撤销），作为附加上下文注入
      const editFeedback = this.pendingEditFeedback;
      this.pendingEditFeedback = null;

      let contextPrefix = '';
      if (editFeedback) contextPrefix += editFeedback + '\n';
      if (resourcesText) contextPrefix += resourcesText + '\n\n';

      if (contextPrefix) {
        llmText = contextPrefix + text;
        displayText = (resourcesText ? resourcesText + '\n\n' : '') + text;
      } else {
        llmText = text;
        displayText = text;
      }

      this.msg.appendMessage('user', displayText);

      if (this.useStatelessMode) {
        this.turnManager.startTurn(llmText);
        this.isWaiting = true;
        this.msg.appendMessage('aily', '[thinking...]');
        this.currentMessageSource = 'mainAgent';
        this.toolCallingIteration = 0;
        // 创建新的 AbortController 用于本轮工具执行中止
        this.abortController = new AbortController();
        // Turn 开始前自动导出 ABS，确保磁盘态与图形工作区同步
        this.ensureAbsExport();
        // 同步自动保存配置
        this.editCheckpointService.autoSaveEdits = this.ailyChatConfigService.autoSaveEdits;
        // Turn 开始前先持久化前一轮 checkpoint（防止崩溃丢数据）
        this.saveCheckpointToDisk();
        // 启动新 turn 的 checkpoint
        this.editCheckpointService.startTurn(
          0,
          this.conversationMessages.length - 1,
          this.list.length - 1,
          this.turnManager.currentTurnId
        );
        this.contextBudgetService.updateBudget(this.conversationMessages, this.turnLoop.getCurrentTools());
        if (clear) { this.inputValue = ''; }
        this.turnLoop.startChatTurn();
        return;
      }
    } else if (sender === 'tool') {
      if (!this.isWaiting) return;
    } else {
      console.warn('未知发送者类型:', sender);
      return;
    }

    this.isWaiting = true;
    this.currentMessageSource = 'mainAgent';
    this.sendMessageWithRetry(this.sessionId, llmText, sender, clear, 3);
  }

  private sendMessageWithRetry(sessionId: string, text: string, sender: string, clear: boolean, retryCount: number): void {
    this.chatService.sendMessage(sessionId, text, sender).subscribe({
      next: (res: any) => {
        if (res.status === 'success') {
          if (res.data) { this.msg.appendMessage('aily', res.data); }
          if (clear) { this.inputValue = ''; }
        }
      },
      error: (error) => {
        console.warn('发送消息失败:', error);
        if ((error.status === 502 || error.status === 503 || error.status === 504) && retryCount > 0) {
          setTimeout(() => { this.sendMessageWithRetry(sessionId, text, sender, clear, retryCount - 1); }, 1500);
        } else {
          this.isWaiting = false;
          let errorMessage = '发送消息失败';
          if (error.status === 502) { errorMessage = '服务器暂时无法响应，请稍后重试'; }
          else if (error.message) { errorMessage = error.message; }
          this.msg.appendMessage('aily', `\n\`\`\`aily-error\n{\n  "message": "${errorMessage}",\n  "status": ${error.status || 'unknown'}\n}\n\`\`\`\n\n\`\`\`aily-button\n[{"text":"重试","action":"retry","type":"primary"}]\n\`\`\`\n\n`);
          this.isWaiting = false;
          this.viewAdapter.markLastMessageDone();
        }
      }
    });
  }

  resetChat(): Promise<void> { return this.session.startSession(); }

  // ==================== @agent 直连对话 ====================

  /**
   * 用户通过 @agentName 直接与 subagent 对话
   * 跳过 mainAgent 调度，直连目标 agent
   */
  private async sendToSubagentDirect(agentName: string, userText: string): Promise<void> {
    this.isWaiting = true;
    this.currentMessageSource = agentName;

    // Turn 结构化存储
    this.turnManager.startTurn(`@${agentName} ${userText}`);

    try {
      const result = await this.subagentSessionService.directChat(agentName, userText);

      this.turnManager.finalizeTurn(`[${agentName}] ${result}`);
    } catch (error: any) {
      this.turnManager.finalizeTurn('');
      // 用户主动停止时不显示错误消息
      if (!this.isCancelled) {
        const errMsg = error?.message || `${agentName} 执行失败`;
        this.msg.appendMessage('aily', `\n\`\`\`aily-error\n{\n  "message": "${this.msg.makeJsonSafe(errMsg)}"}\n\`\`\`\n\n`, agentName);
      }
    } finally {
      // 确保最后一条消息标记完成（包括超时/错误场景）
      this.viewAdapter.markLastMessageDone();
      this.currentMessageSource = 'mainAgent';
      this.isWaiting = false;
      this.isCompleted = true;
      this.session.saveCurrentSession();
    }
  }

  // ==================== 停止 ====================

  stop(): void {
    this.isCancelled = true;
    // 中止正在进行的异步工具操作
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // 取消正在进行的前台/后台摘要（避免 stop 后仍消耗 LLM 资源）
    this.contextBudgetService.backgroundSummarizer.cancelActive();
    const wasStatelessTurn = this.currentStatelessMode;
    if (this.messageSubscription) { this.messageSubscription.unsubscribe(); this.messageSubscription = null; }
    this.pendingUserInput = false;
    this.streamCompleted = false;
    this.sseStreamCompleted = false;
    this.activeToolExecutions = 0;
    this.currentStatelessMode = false;
    if (this.messageSubscription) { this.messageSubscription.unsubscribe(); this.messageSubscription = null; }
    this.subagentSessionService.cleanupAll();

    if (wasStatelessTurn) {
      // 保存已收到的 assistant 内容和工具结果到 TurnManager
      const hasAssistantContent = !!this.currentTurnAssistantContent;
      const hasToolCalls = this.currentTurnToolCalls.length > 0;
      const hasToolResults = this.pendingToolResults.length > 0;

      if (hasAssistantContent || hasToolCalls) {
        if (hasToolCalls) {
          this.turnManager.addToolCallRound(
            this.currentTurnAssistantContent || '',
            this.currentTurnToolCalls.map(tc => ({
              id: tc.tool_id,
              name: tc.tool_name,
              arguments: typeof tc.tool_args === 'string' ? tc.tool_args : JSON.stringify(tc.tool_args),
            }))
          );
        }

        if (hasToolResults) {
          for (const result of this.pendingToolResults) {
            this.turnManager.addToolResult(result.tool_id, {
              content: result.content,
              isError: result.is_error ?? false,
              toolName: result.tool_name,
            });
          }
        }

        this.turnManager.finalizeTurn(this.currentTurnAssistantContent || '');
      } else {
        // 没有 assistant 输出也没有工具调用，移除未完成的 turn
        this.turnManager.removeIncompleteLast();
      }
      this.currentTurnAssistantContent = '';
      this.currentTurnToolCalls = [];
      this.pendingToolResults = [];
      this.contextBudgetService.updateBudget(this.conversationMessages, this.turnLoop.getCurrentTools());
      const budget = this.contextBudgetService.getSnapshot();
      this.contextBudgetService.backgroundSummarizer.checkAndTrigger(
        this.conversationMessages, budget.maxContextTokens, budget.currentTokens,
        this.sessionId, this.turnManager,
        this.turnLoop.getCurrentLLMConfig(), this.currentModel?.model || undefined
      );
    }

    // stop 时提交当前 turn 的快照，确保 checkpoint 数据完整
    this.editCheckpointService.commitCurrentTurn();

    this.viewAdapter.markLastMessageDone();
    this.isWaiting = false;
    this.isCompleted = true;
    if (this.useStatelessMode || wasStatelessTurn) { this.session.saveCurrentSession(); }

    this.chatService.cancelTask(this.sessionId).subscribe({
      next: (res: any) => { if (res.status !== 'success') { console.warn('取消任务失败:', res); } },
      error: (err) => { console.warn('取消任务请求失败:', err); }
    });

    // 停止后应用延迟切换
    this.applyPendingSwitch();
  }

  /**
   * 确保 absAutoSyncService 已初始化并执行导出
   */
  private ensureAbsExport(): void {
    const projectPath = this.getCurrentProjectPath()
      || AilyHost.get().project.currentProjectPath
      || AilyHost.get().project.projectRootPath;
    if (projectPath) {
      this.absAutoSyncService.initialize(projectPath);
    }
    this.absAutoSyncService.exportToAbs().catch(err => {
      console.warn('[ChatEngine] ABS 自动导出失败:', err);
    });
  }

  /**
   * Turn 开始前将已有 checkpoint 数据持久化到磁盘。
   * 确保前一轮的快照不因崩溃而丢失（基线快照策略）。
   */
  private saveCheckpointToDisk(): void {
    if (this.editCheckpointService.getTotalEditCount() === 0) return;
    const projectPath = this.prjPath
      || this.chatService.currentSessionPath
      || AilyHost.get().project.currentProjectPath;
    if (projectPath && this.sessionId) {
      try {
        this.editCheckpointService.commitCurrentTurn();
        this.editCheckpointService.saveToDisk(projectPath, this.sessionId);
      } catch (err) {
        console.warn('[ChatEngine] checkpoint saveToDisk before turn failed:', err);
      }
    }
  }

  // ==================== 模式 / 模型切换 ====================

  async switchToModel(model: ModelConfig): Promise<void> {
    if (model.model === this.currentModel?.model) return;
    // 活跃请求期间：保存偏好并暂存，待当前请求完成后自动应用
    if (this.isWaiting) {
      this.chatService.saveChatModel(model);
      this._pendingModelSwitch = model;
      this._pendingModeSwitch = null; // 模型切换优先，清除待切换模式
      this.message.info('模型将在当前对话完成后切换');
      return;
    }
    await this._doSwitchModel(model);
  }

  /** 实际执行模型切换（重建会话） */
  private async _doSwitchModel(model: ModelConfig): Promise<void> {
    this.chatService.saveChatModel(model);
    const savedTurns = this.turnManager.serialize();
    const savedIteration = this.toolCallingIteration;
    const savedTitle = this.chatService.currentSessionTitle;
    const savedPath = this.chatService.currentSessionPath;
    const savedList = [...this.list];
    const oldSessionId = this.sessionId;
    await this.session.stopAndCloseSession();
    try { await this.session.startSession(); } catch (err) {
      console.error('切换模型失败:', err);
      this.turnManager.deserialize(savedTurns);
      this.toolCallingIteration = savedIteration;
      this.list = savedList;
      return;
    }
    this.turnManager.deserialize(savedTurns);
    this.toolCallingIteration = savedIteration;
    this.chatService.currentSessionTitle = savedTitle;
    this.chatService.currentSessionPath = savedPath;
    this.list = savedList;
    const newSessionId = this.sessionId;
    if (oldSessionId && newSessionId && oldSessionId !== newSessionId) {
      this.chatHistoryService.migrateSessionId(oldSessionId, newSessionId);
    }
    // 切换模型后立即更新上下文窗口大小 + 预算快照
    this.contextBudgetService?.updateModelContextSize(model.model || null);
    this.contextBudgetService?.updateBudget(this.conversationMessages, this.turnLoop.getCurrentTools());
  }

  async switchToMode(mode: string): Promise<void> {
    if (mode === this.currentMode) return;
    // 活跃请求期间：保存偏好并暂存，待当前请求完成后自动应用
    if (this.isWaiting) {
      this.chatService.saveChatMode(mode as 'agent' | 'ask');
      this._pendingModeSwitch = mode;
      this._pendingModelSwitch = null; // 模式切换优先，清除待切换模型
      this.message.info('模式将在当前对话完成后切换');
      return;
    }
    await this._doSwitchMode(mode);
  }

  /** 实际执行模式切换（重建会话） */
  private async _doSwitchMode(mode: string): Promise<void> {
    this.chatService.saveChatMode(mode as 'agent' | 'ask');
    const savedTurns = this.turnManager.serialize();
    const savedIteration = this.toolCallingIteration;
    const savedTitle = this.chatService.currentSessionTitle;
    const savedPath = this.chatService.currentSessionPath;
    const savedList = [...this.list];
    const oldSessionId = this.sessionId;
    await this.session.stopAndCloseSession();
    try { await this.session.startSession(); } catch (err) {
      console.error('切换模式失败:', err);
      this.turnManager.deserialize(savedTurns);
      this.toolCallingIteration = savedIteration;
      this.list = savedList;
      this.chatService.saveChatMode('agent');
      return;
    }
    this.turnManager.deserialize(savedTurns);
    this.toolCallingIteration = savedIteration;
    this.chatService.currentSessionTitle = savedTitle;
    this.chatService.currentSessionPath = savedPath;
    this.list = savedList;
    const newSessionId = this.sessionId;
    if (oldSessionId && newSessionId && oldSessionId !== newSessionId) {
      this.chatHistoryService.migrateSessionId(oldSessionId, newSessionId);
    }
    this.contextBudgetService?.updateBudget(this.conversationMessages, this.turnLoop.getCurrentTools());
  }

  /**
   * 应用延迟的模型/模式切换。
   * 在 turn 完成（finalizeStatelessTurn / stream complete / stop）后调用。
   */
  async applyPendingSwitch(): Promise<void> {
    const pendingModel = this._pendingModelSwitch;
    const pendingMode = this._pendingModeSwitch;
    this._pendingModelSwitch = null;
    this._pendingModeSwitch = null;
    if (pendingModel) {
      await this._doSwitchModel(pendingModel);
    } else if (pendingMode) {
      await this._doSwitchMode(pendingMode);
    }
  }

  // ==================== 任务操作 ====================

  private handleTaskAction(event: Event): void {
    const customEvent = event as CustomEvent;
    const { action, checkpointId } = customEvent.detail || {};
    switch (action) {
      case 'continue': this.continueConversation(); break;
      case 'retry': this.retryLastAction(); break;
      case 'regenerate': this.regenerateTurn(checkpointId); break;
      case 'undoEdits': this.undoLastEdits(); break;
      case 'redoEdits': this.redoEdits(); break;
      case 'keepEdits': this.onKeepEdits(customEvent.detail); break;
      case 'acceptFile': this.onAcceptFile(customEvent.detail?.filePath); break;
      case 'rejectFile': this.onRejectFile(customEvent.detail?.filePath); break;
      case 'restoreCheckpoint': this.restoreToCheckpoint(customEvent.detail.listIndex); break;
      case 'newChat': this.newChat(); break;
      case 'dismiss': break;
      default: console.warn('未知的任务操作:', action);
    }
  }

  async continueConversation(): Promise<void> {
    if (this.isWaiting) { this.message.warning('正在处理中，请稍候...'); return; }
    if (!this.sessionId) { this.message.warning('会话不存在，请开始新对话'); return; }
    await this.send('user', '请继续完成之前的任务。', false);
  }

  async retryLastAction(): Promise<void> {
    if (this.isWaiting) { this.message.warning('正在处理中，请稍候...'); return; }
    if (!this.sessionId) { this.message.warning('会话不存在，请开始新对话'); return; }
    await this.send('user', '请重试上次的操作。', false);
    this.scrollManager.autoScrollEnabled = true;
    this.scrollManager.scrollToBottom();
  }

  /**
   * 回滚/还原后重新同步 ABS 到 Blockly 工作区。
   * 复用 sync_abs_file 工具的导入逻辑（BlocklyAbsParser + createBlockFromConfig），
   * 而非简化版的 convertAbsToAbi + Blockly.serialization.workspaces.load，
   * 确保动态块、扩展、mutator 等能正确加载。
   */
  private async reloadAbsWorkspace(): Promise<void> {
    const projectPath = this.getCurrentProjectPath()
      || AilyHost.get().project.currentProjectPath
      || AilyHost.get().project.projectRootPath;
    if (projectPath) {
      this.absAutoSyncService.initialize(projectPath);
    }
    try {
      const fsCompat = {
        exists: (p: string) => AilyHost.get().fs.existsSync(p),
        readFile: (p: string) => AilyHost.get().fs.readFileSync(p, 'utf-8'),
        writeFile: (p: string, data: string) => AilyHost.get().fs.writeFileSync(p, data),
      };
      const result = await syncAbsFileHandler(
        { operation: 'import' },
        AilyHost.get().project,
        fsCompat,
        this.absAutoSyncService
      );
      if (result.is_error) {
        console.warn('[reloadAbsWorkspace] ABS 导入失败:', result.content);
      }
    } catch (err) {
      console.warn('[reloadAbsWorkspace] ABS 导入异常:', err);
    }
  }

  /**
   * 用户保留文件变更 — 将当前状态设为新基线，保存反馈状态
   */
  private onKeepEdits(detail: any): void {
    const { fileCount, totalAdded, totalRemoved } = detail || {};
    this.pendingEditFeedback = `[用户已确认保留上一轮的文件变更：${fileCount || 0} 个文件，+${totalAdded || 0} / -${totalRemoved || 0} 行]`;
    this.editCheckpointService.acceptAllAsBaseline();
  }

  /**
   * 撤销最近一轮的文件变更（Undo，不截断对话历史，支持 Redo）
   */
  async undoLastEdits(): Promise<void> {
    if (this.isWaiting) { this.message.warning('正在处理中，请稍候...'); return; }

    if (!this.editCheckpointService.canUndo) {
      this.message.info('没有可撤销的文件变更');
      return;
    }

    const { rolledBackFiles, errors } = this.editCheckpointService.undo();

    this.pendingEditFeedback = `[用户撤销了上一轮的 ${rolledBackFiles} 个文件变更，文件已恢复到变更前的状态。后续操作请基于当前文件内容进行。]`;

    if (errors.length > 0) {
      this.msg.appendMessage('aily', `\n> ⚠️ 撤销了 ${rolledBackFiles} 个文件变更，但有 ${errors.length} 个错误：\n${errors.slice(0, 3).map(e => `> - ${e}`).join('\n')}\n\n`);
    } else {
      this.msg.appendMessage('aily', `\n> ✅ 已撤销 ${rolledBackFiles} 个文件变更\n\n`);
    }

    await this.reloadAbsWorkspace();
  }

  /**
   * 重做文件变更（Redo，恢复被撤销的文件状态）
   */
  async redoEdits(): Promise<void> {
    if (this.isWaiting) { this.message.warning('正在处理中，请稍候...'); return; }

    if (!this.editCheckpointService.canRedo) {
      this.message.info('没有可重做的文件变更');
      return;
    }

    const { rolledBackFiles, errors } = this.editCheckpointService.redo();

    this.pendingEditFeedback = `[用户重新应用了 ${rolledBackFiles} 个文件变更。]`;

    if (errors.length > 0) {
      this.msg.appendMessage('aily', `\n> ⚠️ 重做了 ${rolledBackFiles} 个文件变更，但有 ${errors.length} 个错误\n\n`);
    } else {
      this.msg.appendMessage('aily', `\n> ✅ 已重做 ${rolledBackFiles} 个文件变更\n\n`);
    }

    // 重做后重新推送摘要到面板
    this.editCheckpointService.publishCurrentSummary();
    await this.reloadAbsWorkspace();
  }

  /**
   * 接受单个文件的 AI 编辑
   */
  private onAcceptFile(filePath: string): void {
    if (!filePath) return;
    this.editCheckpointService.acceptFile(filePath);
    this.editCheckpointService.publishCurrentSummary();
  }

  /**
   * 拒绝单个文件的 AI 编辑（恢复到初始内容）
   */
  private async onRejectFile(filePath: string): Promise<void> {
    if (!filePath) return;
    this.editCheckpointService.rejectFile(filePath);
    this.editCheckpointService.publishCurrentSummary();
    await this.reloadAbsWorkspace();
  }

  async restoreToCheckpoint(listIndex: number): Promise<void> {
    if (this.isWaiting) { this.message.warning('正在处理中，请稍候...'); return; }

    const target = this.editCheckpointService.getSnapshotByListIndex(listIndex);
    if (!target) {
      this.message.info('未找到该消息对应的检查点');
      return;
    }

    const { rolledBackFiles, errors } = this.editCheckpointService.truncateFromSnapshot(target.requestId);
    if (errors.length > 0) {
      console.warn('[restoreToCheckpoint] 回滚文件部分失败:', errors);
    }
    if (rolledBackFiles > 0) {
      this.msg.appendMessage('aily', `\n> ✅ 已还原检查点，回滚了 ${rolledBackFiles} 个文件变更\n\n`);
    }

    await this.reloadAbsWorkspace();

    // Turn-native 截断：直接删除该 Turn 及之后的所有 Turn
    if (target.turnId) {
      this.turnManager.removeFromTurn(target.turnId);
    } else {
      // 兼容旧快照：fallback 到消息级截断
      const convCutIndex = target.conversationStartIndex;
      const messages = [...this.turnManager.buildMessages()];
      if (convCutIndex >= 0 && convCutIndex < messages.length) {
        messages.splice(convCutIndex);
        this.turnManager.rebuildFromMessages(messages);
      }
    }

    if (listIndex >= 0 && listIndex < this.list.length) {
      this.list.splice(listIndex);
    }

    this.isCompleted = false;
    this.isCancelled = false;
    this.editCheckpointService.dismissSummary();
  }

  /**
   * 编辑并重新发送 — 回滚到指定消息的检查点 + 用新内容重新发送
   */
  async editAndResendFromTurn(listIndex: number, newText: string, resources: ResourceItem[]): Promise<void> {
    if (this.isWaiting) { this.message.warning('正在处理中，请稍候...'); return; }
    await this.restoreToCheckpoint(listIndex);

    // 临时设置 resourceManager 的 items，send 会消费它们
    this.resourceManager.items = resources;
    await this.send('user', newText, false);
    this.resourceManager.mergePathsTo(this.sessionAllowedPaths);
    this.resourceManager.items = [];

    this.scrollManager.autoScrollEnabled = true;
    this.scrollManager.scrollToBottom();
  }

  /**
   * 重新生成 — 回滚文件变更 + 截断对话历史 + 重新发送
   * @param checkpointId 可选，指定从哪个 checkpoint 开始回滚（默认最新）
   */
  async regenerateTurn(checkpointId?: string): Promise<void> {
    if (this.isWaiting) { this.message.warning('正在处理中，请稍候...'); return; }
    if (!this.sessionId) { this.message.warning('会话不存在，请开始新对话'); return; }

    // 1. 找到目标快照
    const target = checkpointId
      ? this.editCheckpointService.getSnapshotByRequestId(checkpointId)
      : this.editCheckpointService.getLatestSnapshot();

    if (!target) {
      await this.send('user', '请重试上次的操作。', false);
      return;
    }

    // 2. 回滚文件变更并截断时间线
    if (target.stops.length > 0) {
      const { rolledBackFiles, errors } = this.editCheckpointService.truncateFromSnapshot(target.requestId);
      if (errors.length > 0) {
        console.warn('[Regenerate] 回滚文件部分失败:', errors);
      }
      console.log(`[Regenerate] 回滚了 ${rolledBackFiles} 个文件变更`);
    }

    // 3. Turn-native 截断：保留该 Turn 的 request，清除 response
    if (target.turnId) {
      this.turnManager.truncateToTurn(target.turnId);
    } else {
      // 兼容旧快照：fallback 到消息级截断
      const convCutIndex = target.conversationStartIndex;
      const messages = [...this.turnManager.buildMessages()];
      if (convCutIndex >= 0 && convCutIndex < messages.length) {
        messages.splice(convCutIndex + 1);
        this.turnManager.rebuildFromMessages(messages);
      }
    }

    // 4. 截断 UI list（回到 assistant 回复起始位置）
    const listCutIndex = target.listStartIndex;
    if (listCutIndex >= 0 && listCutIndex < this.list.length) {
      this.list.splice(listCutIndex);
    }

    // 5. 重新发起 turn
    this.isCompleted = false;
    this.isCancelled = false;
    this.isWaiting = true;
    this.currentMessageSource = 'mainAgent';
    this.toolCallingIteration = 0;
    this.repetitionDetectionService.resetStreamTokens();
    this.insideThink = false;

    // 添加新的助手消息占位
    this.msg.appendMessage('aily', '[thinking...]');

    // Turn 开始前自动导出 ABS，确保磁盘态与图形工作区同步
    this.ensureAbsExport();
    // 同步自动保存配置
    this.editCheckpointService.autoSaveEdits = this.ailyChatConfigService.autoSaveEdits;
    // Turn 开始前先持久化前一轮 checkpoint（防止崩溃丢数据）
    this.saveCheckpointToDisk();
    // 创建新的 checkpoint
    this.editCheckpointService.startTurn(
      0,
      this.conversationMessages.length - 1,
      this.list.length - 1,
      this.turnManager.currentTurnId
    );

    this.contextBudgetService.updateBudget(this.conversationMessages, this.turnLoop.getCurrentTools());
    this.scrollManager.autoScrollEnabled = true;
    this.turnLoop.startChatTurn();
  }

  // ==================== 新手引导 ====================

  private checkFirstUsage(): void {
    const hasSeenOnboarding = AilyHost.get().config.data?.ailyChatOnboardingCompleted;
    if (!hasSeenOnboarding && this.isLoggedIn) {
      setTimeout(() => {
        AilyHost.get().onboarding?.start(AILY_CHAT_ONBOARDING_CONFIG, {
          onClosed: () => this.onOnboardingClosed(),
          onCompleted: () => this.onOnboardingClosed()
        });
      }, 500);
    }
  }

  private onOnboardingClosed(): void {
    AilyHost.get().config.data.ailyChatOnboardingCompleted = true;
    AilyHost.get().config.save?.();
  }

  // ==================== ask_user 交互处理 ====================

  /**
   * ask_user 工具的 UI 层回调。
   * 在聊天界面显示全部问题，等待用户逐题回答后 resolve 完整结果。
   */
  private _handleAskUser(questions: AskUserQuestion[]): Promise<AskUserFullResponse | undefined> {
    return new Promise<AskUserFullResponse | undefined>((resolve) => {
      this._askUserQuestions = questions;

      const questionBlockData = { questions };
      this.msg.appendMessage('aily',
        `\n\`\`\`aily-question\n${JSON.stringify(questionBlockData)}\n\`\`\`\n\n`
      );

      this._resolveAskUser = resolve;

      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (!detail || !this._resolveAskUser) return;
        document.removeEventListener('aily-question-answer', handler);

        // 将用户回答写回 aily-question 块，供历史恢复时显示
        if (detail.answers) {
          this._patchAilyQuestionBlock(detail.answers);
        }

        const resolveRef = this._resolveAskUser;
        this._resolveAskUser = null;
        this._askUserQuestions = null;
        resolveRef(detail as AskUserFullResponse);
      };
      document.addEventListener('aily-question-answer', handler);
    });
  }

  /**
   * 将用户的回答数据写回 chatList 中的 aily-question 块，
   * 使其在历史模式加载时能恢复选择状态。
   * 使用 indexOf 替代 regex 以避免转义/匹配问题。
   */
  private _patchAilyQuestionBlock(answers: Record<string, any>): void {
    const MARKER = '```aily-question';
    const FENCE = '```';

    for (let i = this.list.length - 1; i >= 0; i--) {
      const item = this.list[i];
      if (item.role !== 'aily') continue;

      // 使用 lastIndexOf 找最后一个（最新的）aily-question 块
      const markerIdx = item.content.lastIndexOf(MARKER);
      if (markerIdx === -1) continue;

      // 找到 marker 后面的换行（JSON 起始位置）
      const jsonStart = item.content.indexOf('\n', markerIdx) + 1;
      if (jsonStart <= 0) continue;

      // 找到闭合 ``` （JSON 结束位置）
      const fenceEnd = item.content.indexOf(FENCE, jsonStart);
      if (fenceEnd <= jsonStart) continue;

      const jsonStr = item.content.substring(jsonStart, fenceEnd).trim();
      try {
        const data = JSON.parse(jsonStr);
        data.answers = answers;
        const patched = item.content.substring(0, jsonStart)
          + JSON.stringify(data) + '\n'
          + item.content.substring(fenceEnd);
        item.content = patched;
        console.log('[ChatEngine] aily-question block patched with answers, keys:', Object.keys(answers));
      } catch (e) {
        console.warn('[ChatEngine] Failed to patch aily-question JSON:', e);
      }
      break;
    }

    // 标记脏数据确保 autoSave 能捕获
    if (this.sessionId) {
      this.chatHistoryService.markDirty(this.sessionId);
    }
  }

  /**
   * 用户在聊天界面回答 ask_user 问题后调用此方法（兼容外部调用）。
   */
  resolveAskUserResponse(answer: string, wasFreeform: boolean): void {
    if (this._resolveAskUser && this._askUserQuestions) {
      const resolve = this._resolveAskUser;
      this._resolveAskUser = null;

      const q = this._askUserQuestions[0];
      const questionKey = q?.question || 'unknown';
      const ans: AskUserAnswer = wasFreeform
        ? { selected: [], freeText: answer, skipped: false }
        : { selected: [answer], freeText: null, skipped: false };
      this._askUserQuestions = null;
      resolve({ answers: { [questionKey]: ans } });
    }
  }

  /**
   * 用户跳过/取消 ask_user 问题。
   */
  skipAskUserResponse(): void {
    if (this._resolveAskUser) {
      const resolve = this._resolveAskUser;
      this._resolveAskUser = null;
      this._askUserQuestions = null;
      resolve(undefined);
    }
  }

  // ==================== 工具审批交互处理 ====================

  /**
   * 工具审批的 UI 层回调。
   * 在聊天界面显示确认按钮，等待用户批准或拒绝后 resolve。
   */
  private _handleToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalResult> {
    return new Promise<ToolApprovalResult>((resolve) => {
      this._resolveToolApproval = resolve;

      // 将审批请求以 aily-approval 块的形式追加到聊天界面
      // 注意：不包含 args 字段，args 中可能含有换行/特殊字符，
      // 经 fixContent 的 \n→newline 全局替换后会破坏 JSON 解析
      const approvalBlockData = {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        title: request.title,
        message: request.message,
      };
      this.msg.appendMessage('aily',
        `\n\`\`\`aily-approval\n${JSON.stringify(approvalBlockData)}\n\`\`\`\n\n`
      );

      // 监听审批结果事件
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (!detail || !this._resolveToolApproval) return;
        // 检查事件是否对应当前审批请求
        if (detail.toolCallId && detail.toolCallId !== request.toolCallId) return;

        document.removeEventListener('aily-approval-result', handler);

        // 更新审批块为已处理状态
        this._patchAilyApprovalBlock(request.toolCallId, detail.approved, detail.scope);

        const resolveRef = this._resolveToolApproval;
        this._resolveToolApproval = null;
        resolveRef({
          approved: !!detail.approved,
          reason: detail.reason || (detail.approved ? undefined : '用户拒绝执行'),
          scope: detail.scope || 'once'
        });
      };
      document.addEventListener('aily-approval-result', handler);
    });
  }

  /**
   * 将审批结果写回 chatList 中的 aily-approval 块，
   * 使其在历史模式加载时能恢复状态。
   */
  private _patchAilyApprovalBlock(toolCallId: string, approved: boolean, scope?: string): void {
    const MARKER = '```aily-approval';
    const FENCE = '```';

    for (let i = this.list.length - 1; i >= 0; i--) {
      const item = this.list[i];
      if (item.role !== 'aily') continue;

      const markerIdx = item.content.lastIndexOf(MARKER);
      if (markerIdx === -1) continue;

      const jsonStart = item.content.indexOf('\n', markerIdx) + 1;
      if (jsonStart <= 0) continue;

      const fenceEnd = item.content.indexOf(FENCE, jsonStart);
      if (fenceEnd <= jsonStart) continue;

      const jsonStr = item.content.substring(jsonStart, fenceEnd).trim();
      try {
        const data = JSON.parse(jsonStr);
        if (data.toolCallId !== toolCallId) continue;
        data.resolved = true;
        data.approved = approved;
        if (scope) data.scope = scope;
        const patched = item.content.substring(0, jsonStart)
          + JSON.stringify(data) + '\n'
          + item.content.substring(fenceEnd);
        item.content = patched;
      } catch (e) {
        console.warn('[ChatEngine] Failed to patch aily-approval JSON:', e);
      }
      break;
    }

    if (this.sessionId) {
      this.chatHistoryService.markDirty(this.sessionId);
    }
  }

  /**
   * 外部调用：用户批准工具执行。
   */
  approveToolExecution(toolCallId: string, scope: 'once' | 'session' | 'session-safe' = 'once'): void {
    if (this._resolveToolApproval) {
      document.dispatchEvent(new CustomEvent('aily-approval-result', {
        detail: { toolCallId, approved: true, scope }
      }));
    }
  }

  /**
   * 外部调用：用户拒绝工具执行。
   */
  rejectToolExecution(toolCallId: string, reason?: string): void {
    if (this._resolveToolApproval) {
      document.dispatchEvent(new CustomEvent('aily-approval-result', {
        detail: { toolCallId, approved: false, reason: reason || '用户拒绝执行' }
      }));
    }
  }
}
