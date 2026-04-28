/**
 * StreamProcessorHelper — SSE 流处理辅助类
 *
 * 负责 SSE 流的连接、事件分发、工具调用请求处理、
 * 子代理分发、流完成/错误处理等逻辑。
 */

import type { ChatEngineService } from '../services/chat-engine.service';
import { ToolCallState } from '../core/chat-types';
import { AilyHost } from '../core/host';
import { ToolRegistry } from '../core/tool-registry';
import { toolRequiresApproval, requestToolApproval, approveToolForSession, enableSessionSafeMode } from '../core/tool-approval';
import { SubagentSessionService } from '../services/subagent-session.service';
import { validateRunSubagentArgs, getSubagentDefinition } from '../tools/runSubagentTool';
import { injectTodoReminder } from '../tools';
import { getMemoryPromptSnippet } from '../tools/memoryTool';
import {
  getPreferredHttpErrorMessage as _getPreferredHttpErrorMessage,
  isTransientNetworkError as _isTransientNetworkError,
  isLikelySessionLostError as _isLikelySessionLostError,
} from '../services/http-error-handler.service';
import {
  BLOCK_TOOLS,
  ASK_MODE_ROLE_TEXT,
} from '../services/stream-constants';
import { searchDeferredTools, getDeferredToolsListing } from '../tools/tools';
import { SkillRegistry } from '../core/skill-registry';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';
import { loadSkillHandler } from '../tools/loadSkillTool';
import { PromptPipeline } from '../core/prompt-pipeline';
import { PromptBuildContext } from '../core/prompt-elements';
import {
  ContextInjectionProvider,
  ConversationHistoryProvider,
  ToolContinuationProvider,
} from '../core/prompt-providers';
// import { manageSkillsHandler } from '../tools/manageSkillsTool'; // TODO: Skills Hub 后续完善

export class StreamProcessorHelper {
  constructor(private engine: ChatEngineService) {}

  /** 流连接网络错误自动重试计数 */
  private streamNetworkRetryCount = 0;
  private static readonly MAX_STREAM_NETWORK_RETRIES = 2;
  private static readonly STREAM_RETRY_INITIAL_DELAY = 4000; // ms — 首次重连多等一会，服务通常需要 3-5s 重启
  private static readonly STREAM_RETRY_BASE_DELAY = 3000; // ms — 后续重连基础延迟

  /** 会话丢失重建是否已尝试（每次用户发起的新连接重置） */
  private sessionRebuildAttempted = false;

  /**
   * 构建瞬态上下文消息（不存储到 Turn 中）。
   *
   * 将活跃 skills + 延迟工具索引 + skills 索引 + memory
   * 组装为 `<aily-context>` 消息，在 API 调用时注入。
   *
   * 参考 Copilot 的 CustomInstructions 组件以 priority 750 渲染到 UserMessage 的模式。
   */
  private buildContextMessage(): any | null {
    const messageSource = this.engine.currentMessageSource || 'mainAgent';
    if (messageSource !== 'mainAgent') return null;

    const parts: string[] = [];

    if (this.engine.currentMode === 'agent') {
      const skillsContent = SkillRegistry.getActiveSkillsContent(messageSource);
      if (skillsContent) parts.push(skillsContent);
    } else {
      parts.push(`<rules>${ASK_MODE_ROLE_TEXT}</rules>`);
    }

    const deferredListing = getDeferredToolsListing(messageSource, this._getAgentExcludedTools(messageSource));
    if (deferredListing) parts.push(deferredListing);

    const skillsListing = SkillRegistry.getSkillsListing(messageSource);
    if (skillsListing) parts.push(skillsListing);

    const memorySnippet = getMemoryPromptSnippet();
    if (memorySnippet) parts.push(memorySnippet);

    if (parts.length === 0) return null;

    const content = `<aily-context>\n${parts.join('\n')}\n</aily-context>`;
    return { role: 'user', content };
  }

  /** 获取指定 agent 在 aily config 中被禁用的工具名称集合 */
  private _getAgentExcludedTools(agentName: string): Set<string> {
    const config = this.engine.ailyChatConfigService.getAgentToolsConfig(agentName);
    return new Set(config.disabledTools || []);
  }

  finalizeUserInput(): void {
    this.engine.pendingUserInput = false;
    this.engine.streamCompleted = false;
    this.engine.viewAdapter.markLastMessageDone();
    this.engine.isWaiting = false;
  }

  streamConnect(statelessMode: boolean = false, _isNetworkRetry: boolean = false): void {
    console.log('发起流连接，statelessMode:', statelessMode, _isNetworkRetry ? `(网络重试 #${this.streamNetworkRetryCount})` : '');
    if (!this.engine.sessionId) { console.warn('无法建立流连接：sessionId 为空'); return; }

    // 用户发起的新连接重置重试计数；自动重试保持计数
    if (!_isNetworkRetry) {
      this.streamNetworkRetryCount = 0;
      this.sessionRebuildAttempted = false;
    }

    if (this.engine.messageSubscription) { this.engine.messageSubscription.unsubscribe(); this.engine.messageSubscription = null; }
    this.engine.pendingUserInput = false;
    this.engine.streamCompleted = false;

    // 从 Turn[] 构建消息（优先使用普通裁剪产出的瞬态 prepared messages），并注入上下文
    // 参考 Copilot PromptRenderer：instructions 在消息数组开头（历史对话之前），
    // 每轮 tool call 都重新注入，确保 LLM 始终看到完整指令。
    let apiMessages: any[] | undefined;
    if (statelessMode) {
      // ========== 声明式 Prompt 管线 ==========
      const _pipelineSpan = ChatPerformanceTracer.begin('PromptPipeline.render');
      const pipeline = new PromptPipeline();
      pipeline.registerAll([
        new ContextInjectionProvider(
          (agentName: string) => this._getAgentExcludedTools(agentName)
        ),
        new ConversationHistoryProvider(),
        new ToolContinuationProvider(),
      ]);

      const buildContext: PromptBuildContext = {
        mode: this.engine.currentMode,
        messageSource: this.engine.currentMessageSource || 'mainAgent',
        toolCallingIteration: this.engine.toolCallingIteration,
        engine: this.engine,
      };

      const tokenBudget = this.engine.contextBudgetService.getAvailableMessageBudget();
      const result = pipeline.render(buildContext, tokenBudget);

      apiMessages = result.messages;
      ChatPerformanceTracer.end(_pipelineSpan, 'PromptPipeline.render', `${result.totalTokens}tok, ${result.evictedCount}evicted`);

      // 更新 budget 中的瞬态上下文 token 计量（兼容旧路径）
      const contextElement = result.elementBreakdown.find(e => e.id === 'context-injection');
      if (contextElement && !contextElement.evicted) {
        this.engine.contextBudgetService.updateContextTokens(apiMessages[0]);
      }

      if (result.evictedCount > 0) {
        console.log('[PromptPipeline] 渲染完成:', {
          totalTokens: result.totalTokens,
          budget: result.budget,
          evicted: result.evictedCount,
          elements: result.elementBreakdown,
        });
      }
    }

    const source$ = statelessMode
      ? this.engine.chatService.chatRequest(
          this.engine.sessionId, apiMessages!, this.engine.turnLoop.getCurrentTools(),
          this.engine.currentMode, this.engine.turnLoop.getCurrentLLMConfig(),
          this.engine.currentModel?.model || undefined, this.engine.ailyChatConfigService.maxCount
        )
      : (this.engine.debug ? this.engine.chatService.debugStream(this.engine.sessionId) : this.engine.chatService.streamConnect(this.engine.sessionId));

    // SSE 回调在 Angular Zone 外执行 — 避免每个 SSE token 触发 CD
    // list 变更通过 viewAdapter._runInZone() 重新进入 Zone
    this.engine.ngZone.runOutsideAngular(() => {
    this.engine.messageSubscription = source$.subscribe({
      next: async (data: any) => {
        if (!this.engine.isWaiting) return;
        if (this.engine.isCancelled) return;

        const messageSource = this.engine.currentMessageSource || 'mainAgent';
        if (messageSource !== this.engine.currentMessageSource) {
          this.engine.viewAdapter.markLastMessageDone();
        }
        this.engine.currentMessageSource = messageSource;

        try {
          if (data.type === 'ModelClientStreamingChunkEvent') {
            if (data.content) {
              ChatPerformanceTracer.mark('sse_chunk', data.content.length > 30 ? data.content.slice(0, 30) + '...' : data.content);
              const streamRepetitionCheck = this.engine.repetitionDetectionService.checkStreamRepetition(data.content);
              // 同步 think 状态（由服务内部状态机驱动，支持跨 token 标签拆分）
              if (streamRepetitionCheck.thinkTransition === 'entered') { this.engine.insideThink = true; }
              if (streamRepetitionCheck.thinkTransition === 'exited') { this.engine.insideThink = false; }
              if (streamRepetitionCheck.isRepetitive) {
                console.warn('[重复检测] 流式文本重复:', streamRepetitionCheck.pattern);
                this.engine.msg.appendStreaming('aily', data.content, messageSource);
                this.engine.viewAdapter.flushNow(); // flush before reading list for closingTags
                const closingTags = this.engine.msg.getClosingTagsForOpenBlocks();
                this.engine.msg.appendMessage('aily', `${closingTags}\n\`\`\`aily-state\n{\n  "status": "warning",\n  "text": "模型已经处理了一段时间，请问需要继续吗？",\n  "id": "repetition-check-${Date.now()}"\n}\n\`\`\`\n\n\`\`\`aily-button\n[{"text":"继续","action":"retry","type":"primary"}]\n\`\`\`\n\n`);
                this.engine.stop();
                return;
              }
              // 大小软警告：不中断流，在流式内容中注入提示
              if (streamRepetitionCheck.sizeWarning) {
                console.warn('[大小警告]', streamRepetitionCheck.sizeWarning);
                this.engine.msg.appendStreaming('aily', `${data.content}\n\n\`\`\`aily-state\n{\n  "status": "warning",\n  "text": "${streamRepetitionCheck.sizeWarning}",\n  "id": "size-warn-${Date.now()}"\n}\n\`\`\`\n\n`, messageSource);
                if (statelessMode) { this.engine.currentTurnAssistantContent += data.content; }
                return;
              }
              // ★ 核心优化：流式 token 走 rAF 批处理，每帧合并一次而非每 token 触发 Angular CD
              this.engine.msg.appendStreaming('aily', data.content, messageSource);
              if (statelessMode) { this.engine.currentTurnAssistantContent += data.content; }

              if (!this.engine.insideThink && this.engine.msg.checkAndTruncateAilyButtonBlock()) {
                if (statelessMode) {
                  const ailyBtnMatch = this.engine.currentTurnAssistantContent.match(/```aily-button[\s\S]*?```/);
                  if (ailyBtnMatch) {
                    this.engine.currentTurnAssistantContent = this.engine.currentTurnAssistantContent.substring(0, ailyBtnMatch.index! + ailyBtnMatch[0].length);
                  }
                }
                this.engine.stop();
              }
            }
          } else if (data.type === 'TextMessage') {
            // noop
          } else if (data.type === 'ToolCallExecutionEvent') {
            if (data.content && Array.isArray(data.content)) {
              for (const result of data.content) {
                if (result.call_id && result?.name !== 'ask_approval') {
                  const resultState = result?.is_error ? ToolCallState.ERROR : ToolCallState.DONE;
                  const resultText = this.engine.toolCallStates[result.call_id];
                  if (resultText) { this.engine.msg.completeToolCall(result.call_id, result.name || 'unknown', resultState, resultText); }
                } else { this.engine.msg.appendMessage('aily', '\n\n', messageSource); }
              }
            }
          } else if (data.type === 'tool_call_execution') {
            if (data.tool_id) {
              const execResultText = data.is_error ? `执行失败: ${data.result || '未知错误'}` : '执行完成';
              const execState = data.is_error ? ToolCallState.ERROR : ToolCallState.DONE;
              this.engine.msg.completeToolCall(data.tool_id, data.tool_name || 'unknown', execState, execResultText);
            }
          } else if (data.type === 'context_trimmed' || data.type === 'safety_net_trimmed') {
            console.warn('[安全兜底] 服务端触发了上下文裁剪:', data);
          } else if (data.type.startsWith('context_compression_')) {
            if (data.type.startsWith('context_compression_start')) {
              this.engine.msg.appendMessage('aily', `\n\n\n\`\`\`aily-state\n{\n  "state": "doing",\n  "text": "${data.content}",\n  "id": "${data.id}"\n}\n\`\`\`\n\n\n`, messageSource);
            } else {
              this.engine.msg.appendMessage('aily', `\n\n\n\`\`\`aily-state\n{\n  "state": "done",\n  "text": "${data.content}",\n  "id": "${data.id}"\n}\n\`\`\`\n\n\n`, messageSource);
            }
          } else if (data.type === 'error') {
            this.engine.viewAdapter.markLastMessageDone();
            const errorClosingTags = this.engine.msg.getClosingTagsForOpenBlocks();
            this.engine.msg.appendMessage('aily', `${errorClosingTags}\n\`\`\`aily-error\n{\n  "message": "${this.engine.msg.makeJsonSafe(data.message || '未知错误')}"\n}\n\`\`\`\n\n\`\`\`aily-button\n[{"text":"重试","action":"retry","type":"primary"}]\n\`\`\`\n\n`, messageSource);
            this.engine.ngZone.run(() => { this.engine.isWaiting = false; });
          } else if (data.type === 'tool_call_request') {
            const _tcSpan = ChatPerformanceTracer.begin('tool_call_request', data.tool_name);
            // ★ P0-perf: 工具请求到达前将 pending 内容（含 </think>）提交到 list 数据层，
            // 使用 flushDataOnly 跳过 NgZone → 不触发同步 CD → x-markdown 不会阻塞 3s+。
            // 渲染在下一帧异步完成。
            const _fnSpan = ChatPerformanceTracer.begin('flushDataOnly_toolReq');
            this.engine.viewAdapter.flushDataOnly();
            ChatPerformanceTracer.end(_fnSpan, 'flushDataOnly_toolReq');
            this.engine.repetitionDetectionService.markBoundary('tool_call');

            // 内部工具（服务端已执行，前端仅展示）
            if (statelessMode && data.internal === true) {
              this.engine.msg.startToolCall(`${data.tool_id}`, data.tool_name, `服务端执行: ${data.tool_name}...`);
              return;
            }

            // Subagent 工具调用
            if (statelessMode && SubagentSessionService.isSubagentToolCall(data)) {
              // 泛化 run_subagent：从 tool_args 中提取真正的 agent 名称
              // 后端 SSE 事件的 agent_name 可能是 'subagent'（从 tool_name 去掉 run_ 得来），
              // 而非实际的子代理名称（如 'schematicAgent'），需要从 tool_args.agent 修正
              if (data.tool_name === 'run_subagent') {
                try {
                  const parsedArgs = typeof data.tool_args === 'string' ? JSON.parse(data.tool_args) : data.tool_args;
                  if (parsedArgs?.agent) {
                    data.agent_name = parsedArgs.agent;
                  }
                } catch { /* tool_args 解析失败则沿用原 agent_name */ }
              }
              console.log(`[Subagent] 🚀 调用 ${data.tool_name} (id=${data.tool_id})`, '\n  参数:', typeof data.tool_args === 'string' ? data.tool_args : JSON.stringify(data.tool_args, null, 2));
              this.engine.currentTurnToolCalls.push({ tool_id: data.tool_id, tool_name: data.tool_name, tool_args: data.tool_args });
              const subagentDisplayName = data.agent_name || data.tool_name;
              // this.engine.msg.startToolCall(data.tool_id, data.tool_name, `正在执行 ${subagentDisplayName}...`);
              const agentSource = data.agent_name || 'subAgent';
              if (this.engine.currentMessageSource !== agentSource) {
                this.engine.viewAdapter.markLastMessageDone();
                this.engine.currentMessageSource = agentSource;
              }
              this.engine.activeToolExecutions++;
              const subagentStartTime = Date.now();
              this.engine.subagentSessionService.executeSubagentToolCall(data as any).then(
                (result: string) => {
                  const elapsed = ((Date.now() - subagentStartTime) / 1000).toFixed(1);
                  console.log(`[Subagent] ✅ ${data.tool_name} 完成 (${elapsed}s)`, '\n  返回值:', result?.length > 500 ? result.slice(0, 500) + `...(共${result.length}字符)` : result);
                  // this.engine.msg.completeToolCall(data.tool_id, data.tool_name, ToolCallState.DONE, `${subagentDisplayName} 完成`);
                  if (this.engine.currentMessageSource !== 'mainAgent') {
                    this.engine.viewAdapter.markLastMessageDone();
                    this.engine.currentMessageSource = 'mainAgent';
                  }
                  this.engine.pendingToolResults.push({ tool_id: data.tool_id, tool_name: data.tool_name, content: result, is_error: false });
                  this.engine.turnLoop.onToolExecutionComplete();
                },
                (error: any) => {
                  const elapsed = ((Date.now() - subagentStartTime) / 1000).toFixed(1);
                  const errMsg = error?.message || `${subagentDisplayName} 执行失败`;
                  console.error(`[Subagent] ❌ ${data.tool_name} 失败 (${elapsed}s)`, '\n  错误:', errMsg);
                  // this.engine.msg.completeToolCall(data.tool_id, data.tool_name, ToolCallState.ERROR, errMsg);
                  if (this.engine.currentMessageSource !== 'mainAgent') {
                    this.engine.viewAdapter.markLastMessageDone();
                    this.engine.currentMessageSource = 'mainAgent';
                  }
                  this.engine.pendingToolResults.push({ tool_id: data.tool_id, tool_name: data.tool_name, content: errMsg, is_error: true });
                  this.engine.turnLoop.onToolExecutionComplete();
                }
              );
              return;
            }

            // 解析工具参数
            let toolArgs;
            if (typeof data.tool_args === 'string') {
              try {
                let processedString = data.tool_args;
                processedString = processedString.replace(
                  /"(path|cwd|directory|folder|filepath|dirpath)"\s*:\s*"([^"]*[\\][^"]*)"/g,
                  (match, fieldName, pathValue) => {
                    const fixedPath = pathValue.replace(/(?<!\\)\\(?!\\)/g, '\\\\');
                    return `"${fieldName}":"${fixedPath}"`;
                  }
                );
                toolArgs = JSON.parse(processedString);
              } catch (e) {
                console.warn('JSON解析失败，尝试备用方法:', e);
                try { toolArgs = new Function('return ' + data.tool_args)(); } catch (e2) {
                  console.warn('所有解析方法都失败:', e2);
                  const parseErrorContent = `参数解析失败: ${e.message}`;
                  if (statelessMode) {
                    this.engine.pendingToolResults.push({ tool_id: data.tool_id, tool_name: data.tool_name, content: parseErrorContent, is_error: true });
                  } else {
                    this.engine.send('tool', JSON.stringify({ type: 'tool_result', tool_id: data.tool_id, content: parseErrorContent, is_error: true }, null, 2), false);
                  }
                  return;
                }
              }
            } else if (typeof data.tool_args === 'object' && data.tool_args !== null) {
              toolArgs = data.tool_args;
            } else {
              toolArgs = data.tool_args;
            }

            const toolCallId = `${data.tool_id}`;

            // 无状态模式：记录工具调用元信息
            if (statelessMode) {
              this.engine.currentTurnToolCalls.push({ tool_id: data.tool_id, tool_name: data.tool_name, tool_args: data.tool_args });
            }

            let toolResult = null;
            let resultState = 'done';
            let resultText = '';

            // 检测重复工具调用
            const toolRepetitionCheck = this.engine.repetitionDetectionService.checkToolCallRepetition(data.tool_name, toolArgs, toolCallId);
            if (toolRepetitionCheck.isRepetitive) {
              console.warn('[重复检测] 工具调用重复:', toolRepetitionCheck.pattern);
              const repetitionErrorContent = `检测到重复调用模式 (${toolRepetitionCheck.pattern})。${toolRepetitionCheck.suggestion || '请重新思考解决方案。'}`;
              if (statelessMode) {
                this.engine.pendingToolResults.push({ tool_id: data.tool_id, tool_name: data.tool_name, content: repetitionErrorContent, is_error: true });
              } else {
                this.engine.send('tool', JSON.stringify({ type: 'tool_result', tool_id: data.tool_id, content: repetitionErrorContent, is_error: true }, null, 2), false);
              }
              return;
            }

            const isBlockTool = BLOCK_TOOLS.includes(data.tool_name);
            if (isBlockTool) { this.engine.aiWriting = true; }

            // Hook: PreToolUse — 参考 Copilot IChatHookService.executePreToolUseHook()
            // 工具调用前拦截：允许 Hook 修改参数、拒绝执行、或注入额外上下文
            if (this.engine.hookService.hasHandlers('PreToolUse')) {
              const preResult = await this.engine.hookService.executePreToolUse({
                toolName: data.tool_name,
                toolInput: toolArgs,
                toolCallId,
              });
              if (preResult) {
                if (preResult.permissionDecision === 'deny') {
                  const denyMsg = `工具调用被 Hook 拒绝: ${preResult.permissionDecisionReason || '未知原因'}`;
                  console.warn('[Hook] PreToolUse denied:', denyMsg);
                  if (statelessMode) {
                    this.engine.pendingToolResults.push({ tool_id: data.tool_id, tool_name: data.tool_name, content: denyMsg, is_error: true });
                    this.engine.turnLoop.onToolExecutionComplete();
                  }
                  return;
                }
                // Hook 可修改工具参数
                if (preResult.updatedInput) {
                  toolArgs = preResult.updatedInput;
                }
              }
            }

            if (statelessMode) { this.engine.activeToolExecutions++; }

            try {
              if (data.tool_name === 'run_subagent') {
                // run_subagent — LLM 主动调用子代理（泛化版）
                const validationError = validateRunSubagentArgs(toolArgs);
                if (validationError) {
                  toolResult = validationError;
                  resultState = 'error';
                  resultText = validationError.content as string;
                } else {
                  // ── 子代理审批拦截 ──
                  if (toolRequiresApproval('run_subagent')) {
                    const approval = await requestToolApproval(toolCallId, 'run_subagent', toolArgs);
                    if (!approval.approved) {
                      const rejectMsg = `操作已取消: ${approval.reason || '用户拒绝执行'}`;
                      this.engine.msg.startToolCall(toolCallId, data.tool_name, `已取消: 调用子代理 ${toolArgs.agent}`, toolArgs);
                      this.engine.msg.completeToolCall(toolCallId, data.tool_name, ToolCallState.WARN, `已取消: 调用子代理 ${toolArgs.agent}`);
                      if (statelessMode) {
                        this.engine.pendingToolResults.push({ tool_id: data.tool_id, tool_name: data.tool_name, content: rejectMsg, is_error: false });
                        this.engine.turnLoop.onToolExecutionComplete();
                      }
                      return;
                    }
                    if (approval.scope === 'session') {
                      approveToolForSession('run_subagent');
                    } else if (approval.scope === 'session-safe') {
                      enableSessionSafeMode();
                    }
                  }

                  const agentDef = getSubagentDefinition(toolArgs.agent);
                  const agentDisplayName = agentDef?.displayName || toolArgs.agent;
                  const agentSource = toolArgs.agent;

                  // 切换消息来源到子代理
                  if (this.engine.currentMessageSource !== agentSource) {
                    this.engine.viewAdapter.markLastMessageDone();
                    this.engine.currentMessageSource = agentSource;
                  }

                  // 构造 SubagentToolCallRequest 并执行
                  const subagentRequest = {
                    tool_id: data.tool_id,
                    tool_name: `run_${toolArgs.agent}`,
                    tool_type: 'subagent' as const,
                    agent_name: toolArgs.agent,
                    tool_args: JSON.stringify({ task: toolArgs.task, context: toolArgs.context || '' }),
                  };
                  const subagentStartTime = Date.now();
                  this.engine.subagentSessionService.executeSubagentToolCall(subagentRequest as any).then(
                    (result: string) => {
                      const elapsed = ((Date.now() - subagentStartTime) / 1000).toFixed(1);
                      console.log(`[Subagent] ✅ run_subagent(${toolArgs.agent}) 完成 (${elapsed}s)`);
                      if (this.engine.currentMessageSource !== 'mainAgent') {
                        this.engine.viewAdapter.markLastMessageDone();
                        this.engine.currentMessageSource = 'mainAgent';
                      }
                      this.engine.pendingToolResults.push({ tool_id: data.tool_id, tool_name: data.tool_name, content: result, is_error: false });
                      this.engine.turnLoop.onToolExecutionComplete();
                    },
                    (error: any) => {
                      const elapsed = ((Date.now() - subagentStartTime) / 1000).toFixed(1);
                      const errMsg = error?.message || `${agentDisplayName} 执行失败`;
                      console.error(`[Subagent] ❌ run_subagent(${toolArgs.agent}) 失败 (${elapsed}s):`, errMsg);
                      if (this.engine.currentMessageSource !== 'mainAgent') {
                        this.engine.viewAdapter.markLastMessageDone();
                        this.engine.currentMessageSource = 'mainAgent';
                      }
                      this.engine.pendingToolResults.push({ tool_id: data.tool_id, tool_name: data.tool_name, content: errMsg, is_error: true });
                      this.engine.turnLoop.onToolExecutionComplete();
                    }
                  );
                  return; // 异步处理，提前返回
                }
              } else if (data.tool_name.startsWith('mcp_')) {
                data.tool_name = data.tool_name.substring(4);
                toolResult = await this.engine.mcpService.use_tool(data.tool_name, toolArgs);
              } else if (data.tool_name === 'search_available_tools') {
                // 元工具：搜索并激活 deferred 工具（参考 Copilot tool_search_tool_regex）
                // 按当前 agent 权限 + aily config 配置过滤
                const query = toolArgs?.query || '';
                const agentExcluded = this._getAgentExcludedTools(messageSource);
                const matched = searchDeferredTools(query, this.engine.tools, messageSource, agentExcluded);
                if (matched.length > 0) {
                  matched.forEach(t => this.engine.activatedDeferredTools.add(t.name));
                  const listing = matched.map(t => `- **${t.name}**: ${(t.description || '').split('\n')[0].slice(0, 80)}`).join('\n');
                  toolResult = { is_error: false, content: `已加载 ${matched.length} 个工具，可在后续对话中直接调用：\n${listing}` };
                  resultText = `加载了 ${matched.length} 个工具`;
                } else {
                  toolResult = { is_error: false, content: `未找到匹配 "${query}" 的工具。\n${getDeferredToolsListing(messageSource, agentExcluded)}` };
                  resultText = `未找到匹配的工具`;
                }
              } else if (data.tool_name === 'load_skill') {
                // 技能加载器：搜索并加载领域技能的详细指南
                toolResult = await loadSkillHandler(toolArgs || {});
                resultText = toolResult.is_error ? '加载技能失败' : '技能已加载';
              /* } else if (data.tool_name === 'manage_skills') {
                // TODO: Skills Hub 后续完善
                const projectRoot = AilyHost.get().project?.currentProjectPath || AilyHost.get().project?.projectRootPath;
                toolResult = await manageSkillsHandler(toolArgs || {}, projectRoot);
                resultText = '技能管理完成'; */
              } else {
                if (ToolRegistry.has(data.tool_name)) {
                  console.log(`[ToolDispatch] 调用工具: ${data.tool_name}，参数:`, toolArgs);
                  const regResult = await this.engine.executeRegisteredTool(toolCallId, data.tool_name, toolArgs);
                  toolResult = regResult.toolResult;
                  resultState = regResult.resultState;
                  resultText = regResult.resultText;
                } else {
                  console.warn(`[ToolDispatch] 未知工具: ${data.tool_name}`);
                  toolResult = { is_error: true, content: `未知工具: ${data.tool_name}` };
                  resultState = 'error';
                  resultText = `未知工具: ${data.tool_name}`;
                }
              }
              if (resultState === 'done') {
                if (toolResult && toolResult?.is_error) { resultState = 'error'; }
                else if (toolResult && toolResult.warning) { resultState = 'warn'; }
              }
            } catch (error) {
              console.warn('工具执行出错:', error);
              resultState = 'error';
              resultText = `工具执行出错: ${error.message || '未知错误'}`;
              toolResult = { is_error: true, content: resultText };
            }

            const isSubagent = messageSource !== 'mainAgent';

            // Hook: PostToolUse — 参考 Copilot IChatHookService.executePostToolUseHook()
            // 工具调用后处理：允许 Hook 阻止结果或注入额外上下文
            if (this.engine.hookService.hasHandlers('PostToolUse')) {
              const postResult = await this.engine.hookService.executePostToolUse({
                toolName: data.tool_name,
                toolInput: toolArgs,
                toolResult,
                toolCallId,
                isError: toolResult?.is_error ?? resultState === 'error',
              });
              if (postResult?.decision === 'block') {
                console.warn('[Hook] PostToolUse blocked:', postResult.reason);
                toolResult = { is_error: true, content: `工具结果被 Hook 阻止: ${postResult.reason || '未知原因'}` };
                resultState = 'error';
                resultText = postResult.reason || '工具结果被阻止';
              }
            }

            let reminder = '';
            if (toolResult && data.tool_name !== 'todo_write_tool' && !isSubagent) {
              reminder = injectTodoReminder(data.tool_name);
            }

            let toolContent = '';

            // 所有上下文（skills + 延迟工具索引 + skills 索引 + memory）已通过
            // injectContextMessage() 作为独立 user 消息注入，tool result 只包含工具实际返回值。
            if (toolResult?.content) {
              toolContent = `<toolResult>${toolResult.content}</toolResult>${reminder}`;
            } else {
              toolContent = `<toolResult>${toolResult?.content || '工具执行完成，无返回内容'}</toolResult>`;
            }

            if ((data.tool_name !== 'todo_write_tool' && data.tool_name !== 'search_available_tools'
              && data.tool_name !== 'load_skill'
              && data.tool_name !== 'ask_user' && data.tool_name !== 'save_arch') && resultText) {
              let finalState: ToolCallState;
              switch (resultState) {
                case 'error': finalState = ToolCallState.ERROR; break;
                case 'warn': finalState = ToolCallState.WARN; break;
                default: finalState = ToolCallState.DONE; break;
              }
              const _ctcSpan = ChatPerformanceTracer.begin('completeToolCall', data.tool_name);
              this.engine.msg.completeToolCall(data.tool_id, data.tool_name, finalState, resultText);
              ChatPerformanceTracer.end(_ctcSpan, 'completeToolCall', data.tool_name);
            }

            this.engine.repetitionDetectionService.recordToolCallOutcome(toolCallId, data.tool_name, toolArgs, {
              content: toolResult?.content,
              resultText,
              isError: toolResult?.is_error ?? resultState === 'error',
              isWarning: resultState === 'warn'
            });

            // 工具返回 metadata.chatContent 时，追加内容到对话中（如框架图渲染）
            if (toolResult?.metadata?.chatContent) {
              this.engine.msg.appendMessage('aily', toolResult.metadata.chatContent, messageSource);
            }

            if (statelessMode) {
              console.log('工具调用结果（无状态模式）:', { tool_id: data.tool_id, tool_name: data.tool_name, content: toolContent, resultText, is_error: toolResult?.is_error ?? false });
              this.engine.pendingToolResults.push({
                tool_id: data.tool_id, tool_name: data.tool_name,
                content: toolContent, resultText: this.engine.msg.makeJsonSafe(resultText),
                is_error: toolResult?.is_error ?? false
              });
              ChatPerformanceTracer.end(_tcSpan, 'tool_call_request', data.tool_name);
              this.engine.turnLoop.onToolExecutionComplete();
            } else {
              this.engine.send('tool', JSON.stringify({
                type: 'tool', tool_id: data.tool_id, content: toolContent,
                resultText: this.engine.msg.makeJsonSafe(resultText), is_error: toolResult?.is_error ?? false
              }, null, 2), false);
            }
          } else if (data.type === 'user_input_required') {
            this.engine.pendingUserInput = true;
            if (this.engine.streamCompleted) { this.finalizeUserInput(); }
          } else if (data.type === 'StreamComplete') {
            this.engine.streamCompleted = true;
            if (this.engine.pendingUserInput) { this.finalizeUserInput(); }
          } else if (data.type === 'TaskCompleted') {
            const stopReason = data.stop_reason || 'unknown';
            if (statelessMode) {
              if (stopReason.includes('TERMINATE') || stopReason.includes('COMPLETED')) {
                this.engine.msg.cleanupLastAiMessage();
              }
            } else {
              this.engine.msg.cleanupLastAiMessage();
              if (stopReason.includes('TERMINATE') || stopReason.includes('COMPLETED')) {
                // pass
              } else if (stopReason.includes('Maximum number of messages')) {
                const maxMessagesMatch = stopReason.match(/(\d+)\s*reached/);
                const maxMessages = maxMessagesMatch ? parseInt(maxMessagesMatch[1], 10) : 10;
                this.engine.lastStopReason = stopReason;
                this.engine.msg.appendMessage('aily', `\n\`\`\`aily-task-action\n{\n  "actionType": "max_messages",\n  "message": "已达到本轮对话的最大消息数限制（${maxMessages}条），您可以选择继续对话或开始新会话。",\n  "stopReason": "${this.engine.msg.makeJsonSafe(stopReason)}",\n  "metadata": {\n    "maxMessages": ${maxMessages}\n  }\n}\n\`\`\`\n\n`);
              } else {
                this.engine.lastStopReason = stopReason;
                this.engine.msg.appendMessage('aily', `\n\`\`\`aily-error\n{\n  "message": "任务执行过程中遇到问题，请重试或开始新会话。"\n}\n\`\`\`\n\n\`\`\`aily-button\n[{"text":"重试","action":"retry","type":"primary"}]\n\`\`\`\n\n`);
              }
            }
          }
          // 滚动统一由 viewAdapter 的 rAF flush 回调处理（流式 + 非流式均通过 appendMessage→appendImmediate 触发 flush）
        } catch (e) {
          this.engine.msg.appendMessage('aily', `\n\`\`\`aily-error\n{\n  "message": "服务异常，请稍后重试。"\n}\n\`\`\`\n\n\`\`\`aily-button\n[{"text":"重试","action":"retry","type":"primary"}]\n\`\`\`\n\n`);
          this.engine.stop();
        }
      },
      complete: () => {
        this.engine.msg.cleanupLastAiMessage();
        this.engine.pendingUserInput = false;
        this.engine.streamCompleted = false;

        if (statelessMode && !this.engine.isCancelled) {
          this.engine.sseStreamCompleted = true;
          if (this.engine.activeToolExecutions > 0) return;
          this.engine.turnLoop.finalizeStatelessTurn();
          return;
        }


        this.engine.viewAdapter.markLastMessageDone();
        this.engine.ngZone.run(() => {
          this.engine.isWaiting = false;
          this.engine.isCompleted = true;
        });
        this.engine.session.saveCurrentSession();
        if (!AilyHost.get().electron?.isWindowFocused()) {
          AilyHost.get().electron?.notify('Aily', '对话已完成');
        }
        // 应用延迟的模型/模式切换
        this.engine.applyPendingSwitch();
      },
      error: (err) => {
        console.warn('流连接出错:', err);

        // 会话丢失检测（如服务重启后 500 "An unexpected error occurred"）
        // 重建会话后重新连接，仅尝试一次
        if (
          _isLikelySessionLostError(err) &&
          !this.sessionRebuildAttempted &&
          !this.engine.isCancelled
        ) {
          this.sessionRebuildAttempted = true;
          console.warn('[streamConnect] 检测到会话可能丢失，尝试重建会话...');
          this.engine.session.ensureServerSession().then(() => {
            if (!this.engine.isCancelled && this.engine.isWaiting) {
              console.log('[streamConnect] 会话重建成功，重新连接...');
              this.streamConnect(statelessMode, true);
            }
          }).catch(rebuildErr => {
            console.warn('[streamConnect] 会话重建失败:', rebuildErr);
            this._emitStreamError(err);
          });
          return;
        }

        // 瞬态网络错误自动重试（如 TypeError: network / Failed to fetch）
        if (
          _isTransientNetworkError(err) &&
          this.streamNetworkRetryCount < StreamProcessorHelper.MAX_STREAM_NETWORK_RETRIES &&
          !this.engine.isCancelled
        ) {
          this.streamNetworkRetryCount++;
          const delay = this.streamNetworkRetryCount === 1
            ? StreamProcessorHelper.STREAM_RETRY_INITIAL_DELAY
            : StreamProcessorHelper.STREAM_RETRY_BASE_DELAY * Math.pow(2, this.streamNetworkRetryCount - 2);
          console.warn(`[streamConnect] 网络错误，${delay}ms 后第 ${this.streamNetworkRetryCount} 次自动重连...`);
          setTimeout(() => {
            if (!this.engine.isCancelled && this.engine.isWaiting) {
              this.streamConnect(statelessMode, true);
            }
          }, delay);
          return;
        }

        this._emitStreamError(err);
      }
    });
    }); // end runOutsideAngular
  }

  /** 向用户展示流错误信息并结束等待状态 */
  private _emitStreamError(err: any): void {
    this.engine.viewAdapter.markLastMessageDone();
    const httpErrorText = _getPreferredHttpErrorMessage(err);
    const errorClosingTags = this.engine.msg.getClosingTagsForOpenBlocks();
    this.engine.msg.appendMessage('aily', `${errorClosingTags}\n\`\`\`aily-state\n{\n  "state": "warn",\n  "text": "${this.engine.msg.makeJsonSafe(httpErrorText)}",\n  "id": "network-error-${Date.now()}"\n}\n\`\`\`\n\n\`\`\`aily-button\n[{"text":"重试","action":"retry","type":"primary"}]\n\`\`\`\n\n`);
    this.engine.ngZone.run(() => { this.engine.isWaiting = false; });
    this.engine.viewAdapter.markLastMessageDone();
    // 应用延迟的模型/模式切换
    this.engine.applyPendingSwitch();
  }
}
