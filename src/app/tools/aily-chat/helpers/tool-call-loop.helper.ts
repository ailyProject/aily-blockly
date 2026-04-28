/**
 * ToolCallLoopHelper — 无状态工具调用循环辅助类
 *
 * 负责 stateless chat turn 的发起、上下文压缩、
 * 工具调用结果收集、循环迭代和最终回合结算。
 */

import type { ChatEngineService } from '../services/chat-engine.service';
import { ToolCallState } from '../core/chat-types';
import { AilyHost } from '../core/host';
import { isDeferredTool } from '../tools/tools';
import { formatHookContext } from '../services/chat-hook.service';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';

export class ToolCallLoopHelper {
  /** 发送前准备好的消息（瞬态，仅承载未持久化的普通裁剪结果） */
  _preparedMessages: any[] | null = null;

  /**
   * AutoPilot 安全阀：单 Turn 内连续工具调用的软上限
   *
   * 参考 Copilot 的 MAX_AUTOPILOT_ITERATIONS 概念：
   * - 到达此阈值时注入 task_complete 期望提示，引导 LLM 收束输出
   * - 不直接硬中断（硬中断由 maxCount 兜底），而是给 LLM 一次机会完成总结
   * - 防止 LLM 无限循环调用工具而不产出有效回答
   */
  private static readonly AUTOPILOT_SOFT_LIMIT = 15;

  /**
   * Stop Hook 状态 — 参考 Copilot ToolCallingLoop.stopHookReason
   *
   * 当 Stop Hook 阻止停止时，将原因存储在此字段。
   * 下次 startChatTurn() 时作为 user 消息注入，
   * 引导 LLM 继续处理 Hook 指定的任务。
   */
  private _stopHookReason: string | undefined;
  private _stopHookActive = false;

  constructor(private engine: ChatEngineService) {}

  // ==================== 工具 / LLM 配置 ====================

  getCurrentTools(): any[] {
    // 1. 按 agents 字段过滤：mainAgent 只获取属于 mainAgent 的工具
    //    参考 SubagentSessionService.getToolsForAgent() 的同等逻辑
    let tools = this.engine.tools.filter(tool =>
      !tool.agents || tool.agents.includes('mainAgent')
    );

    // 2. 按 aily config 配置过滤（尊重用户的 enabledTools/disabledTools 设置）
    const mainAgentConfig = this.engine.ailyChatConfigService.getAgentToolsConfig('mainAgent');
    const enabledToolNames = mainAgentConfig?.enabledTools || [];
    const disabledToolNames = new Set(mainAgentConfig?.disabledTools || []);
    if (enabledToolNames.length > 0) {
      const enabledSet = new Set(enabledToolNames);
      tools = tools.filter(tool => enabledSet.has(tool.name) || !disabledToolNames.has(tool.name));
    } else if (disabledToolNames.size > 0) {
      tools = tools.filter(tool => !disabledToolNames.has(tool.name));
    }

    // 3. Deferred tool filtering: 只发送 core 工具 + 已激活的 deferred 工具
    // 参考 Copilot 的 deferred tool loading 策略
    const activated = this.engine.activatedDeferredTools;
    tools = tools.filter(tool => !isDeferredTool(tool.name) || activated.has(tool.name));

    let mcpTools = this.engine.mcpService.tools.map(tool => {
      if (!tool.name.startsWith('mcp_')) { tool.name = 'mcp_' + tool.name; }
      return tool;
    });
    if (mcpTools && mcpTools.length > 0) { tools = tools.concat(mcpTools); }
    return tools;
  }

  getCurrentLLMConfig(): any {
    if (this.engine.currentModel && this.engine.currentModel.baseUrl && this.engine.currentModel.apiKey) {
      return { apiKey: this.engine.currentModel.apiKey, baseUrl: this.engine.currentModel.baseUrl };
    } else if (this.engine.ailyChatConfigService.useCustomApiKey) {
      return { apiKey: this.engine.ailyChatConfigService.apiKey, baseUrl: this.engine.ailyChatConfigService.baseUrl };
    }
    return null;
  }

  // ==================== turn 发起 ====================

  async startChatTurn(): Promise<void> {
    const _turnSpan = ChatPerformanceTracer.begin('startChatTurn', `iter=${this.engine.toolCallingIteration}`);
    if (this.engine.isCancelled) { this.engine.isWaiting = false; ChatPerformanceTracer.end(_turnSpan, 'startChatTurn', 'cancelled'); return; }

    const toolCallLimit = this.engine.ailyChatConfigService.maxCount;
    if (this.engine.toolCallingIteration >= toolCallLimit) {
      console.warn(`[无状态模式] 工具调用循环已达上限 (${toolCallLimit})，强制结束`);
      this.engine.msg.appendMessage('aily', `\n\n> ⚠️ 工具调用轮次已达上限（${toolCallLimit}），请重新发送消息继续。\n\n`);
      this.engine.isWaiting = false;
      this.engine.isCompleted = true;
      return;
    }

    // Hook: SessionStart — 参考 Copilot executeSessionStartHook()
    // 仅在首轮（iteration=0）触发，注入额外上下文
    if (this.engine.toolCallingIteration === 0 && this.engine.hookService.hasHandlers('SessionStart')) {
      const hookResult = await this.engine.hookService.executeGeneric('SessionStart', {
        sessionId: this.engine.sessionId,
        mode: this.engine.currentMode,
      });
      if (hookResult?.additionalContext) {
        console.log('[Hook] SessionStart 注入额外上下文');
        // 将上下文注入到 prepared messages（类似 Copilot additionalHookContext）
        const base = this._preparedMessages ?? this.engine.turnManager.buildMessages();
        this._preparedMessages = [
          ...base,
          { role: 'user', content: hookResult.additionalContext },
        ];
      }
    }

    this.engine.contextBudgetService.updateModelContextSize(this.engine.currentModel?.model || null);
    // P0-perf: 直接调用 buildMessages() 一次并缓存，避免通过 conversationMessages getter 重复触发
    const _bmSpan = ChatPerformanceTracer.begin('buildMessages');
    const cachedMessages = this.engine.turnManager.buildMessages();
    ChatPerformanceTracer.end(_bmSpan, 'buildMessages', `${cachedMessages.length} msgs`);
    // Method C: 异步 token 计数，长文本卸载到 Worker 避免阻塞 UI
    const _budgetSpan = ChatPerformanceTracer.begin('updateBudgetAsync');
    await this.engine.contextBudgetService.updateBudgetAsync(cachedMessages, this.getCurrentTools());
    ChatPerformanceTracer.end(_budgetSpan, 'updateBudgetAsync');

    const preCompressBudget = this.engine.contextBudgetService.getSnapshot();

    // Hook: PreCompact — 参考 Copilot executeHook('PreCompact', ...)
    // 在压缩决策前允许外部模块注入自定义指令或阻止压缩
    if (this.engine.hookService.hasHandlers('PreCompact')) {
      const usageRatio = preCompressBudget.currentTokens / preCompressBudget.maxContextTokens;
      const hookResult = await this.engine.hookService.executeGeneric('PreCompact', {
        trigger: 'auto',
        usageRatio,
        currentTokens: preCompressBudget.currentTokens,
        maxTokens: preCompressBudget.maxContextTokens,
      });
      if (hookResult?.decision === 'block') {
        console.log('[Hook] PreCompact 被阻止:', hookResult.reason);
        // 跳过压缩，直接进入流连接
        this.engine.stream.streamConnect(true);
        return;
      }
    }

    const willSummarize = preCompressBudget.currentTokens >= preCompressBudget.summarizationThreshold;
    const bg = this.engine.contextBudgetService.backgroundSummarizer;
    const bgWaiting = bg.shouldBlockAndWait(preCompressBudget.currentTokens, preCompressBudget.maxContextTokens);
    const bgReady = bg.state === 'Completed';
    const showCompressionState = willSummarize || bgWaiting || bgReady;
    const compressionStateId = 'context-compression-' + Date.now();

    if (showCompressionState) {
      const stateText = bgWaiting ? `正在等待上下文摘要完成 (${preCompressBudget.usagePercent}%)...`
        : bgReady ? `正在应用上下文摘要 (${preCompressBudget.usagePercent}%)...`
        : `正在压缩上下文 (${preCompressBudget.usagePercent}%)...`;
      this.engine.msg.displayToolCallState({ id: compressionStateId, name: 'context_compression', state: ToolCallState.DOING, text: stateText });
    }

    try {
      // P0-perf: 复用 cachedMessages，不再重复调用 buildMessages()
      const turnSpans = this.engine.turnManager.turnSpans;
      const _compressSpan = ChatPerformanceTracer.begin('compressIfNeeded');
      const compressed = await this.engine.contextBudgetService.compressIfNeeded(
        cachedMessages, this.engine.sessionId, this.engine.turnManager,
        this.getCurrentLLMConfig(), this.engine.currentModel?.model || undefined,
        turnSpans,
        preCompressBudget.messagesTokens
      );
      ChatPerformanceTracer.end(_compressSpan, 'compressIfNeeded');
      // compress 可能修改了 turnManager 内部状态，获取最新的 canonical messages
      const canonicalMessages = this.engine.turnManager.buildMessages();
      this._preparedMessages = compressed === canonicalMessages ? null : compressed;
      if (showCompressionState) {
        this.engine.msg.displayToolCallState({ id: compressionStateId, name: 'context_compression', state: ToolCallState.DONE, text: '上下文摘要完成' });
      }
    } catch (error) {
      console.warn('[无状态模式] 上下文压缩失败，使用原始历史:', error);
      this._preparedMessages = null;
      if (showCompressionState) {
        this.engine.msg.displayToolCallState({ id: compressionStateId, name: 'context_compression', state: ToolCallState.WARN, text: '上下文摘要失败，使用原始历史继续' });
      }
    }

    this.engine.pendingToolResults = [];
    this.engine.currentTurnAssistantContent = '';
    this.engine.currentTurnToolCalls = [];
    this.engine.activeToolExecutions = 0;
    this.engine.sseStreamCompleted = false;
    this.engine.currentStatelessMode = true;

    // P10: AutoPilot 安全阀 — 到达软上限时注入收束提示
    // 参考 Copilot: 在接近迭代上限时注入 "please finalize" 指令
    if (this.engine.toolCallingIteration >= ToolCallLoopHelper.AUTOPILOT_SOFT_LIMIT) {
      const remaining = this.engine.ailyChatConfigService.maxCount - this.engine.toolCallingIteration;
      if (remaining > 0 && remaining <= 3) {
        // 将收束提示注入到 prepared messages 中
        const base = this._preparedMessages ?? this.engine.turnManager.buildMessages();
        this._preparedMessages = [
          ...base,
          {
            role: 'user',
            content: `[System notice: You have used ${this.engine.toolCallingIteration} tool call iterations. ` +
              `Only ${remaining} iteration(s) remain. Please wrap up your current task and provide a final response ` +
              `to the user. If you need more iterations, explain what remains to be done.]`
          }
        ];
      }
    }

    // 压缩期间用户可能已取消，再次检查
    if (this.engine.isCancelled) { this.engine.isWaiting = false; ChatPerformanceTracer.end(_turnSpan, 'startChatTurn', 'cancelled_post_compress'); return; }

    ChatPerformanceTracer.end(_turnSpan, 'startChatTurn', 'streamConnect');
    this.engine.stream.streamConnect(true);
  }

  // ==================== 循环迭代 ====================

  continueToolCallingLoop(): void {
    ChatPerformanceTracer.mark('continueToolCallingLoop', `iter=${this.engine.toolCallingIteration}`);
    // Turn 结构化存储：记录本轮工具调用
    if (this.engine.currentTurnToolCalls.length > 0) {
      this.engine.turnManager.addToolCallRound(
        this.engine.currentTurnAssistantContent || '',
        this.engine.currentTurnToolCalls.map(tc => ({
          id: tc.tool_id,
          name: tc.tool_name,
          arguments: typeof tc.tool_args === 'string' ? tc.tool_args : JSON.stringify(tc.tool_args),
        }))
      );
    }

    // Turn 结构化存储：记录工具结果
    for (const result of this.engine.pendingToolResults) {
      this.engine.turnManager.addToolResult(result.tool_id, {
        content: result.content,
        isError: result.is_error ?? false,
        toolName: result.tool_name,
      });
    }

    this.engine.toolCallingIteration++;
    // P0-perf: yield 一帧让 UI 更新（显示 pending 状态），再执行重计算
    // 移除了此处的 updateBudget（startChatTurn 开头会做同样的调用）
    setTimeout(() => this.startChatTurn(), 0);
  }

  // ==================== 完成回调 ====================

  onToolExecutionComplete(): void {
    ChatPerformanceTracer.mark('onToolExecutionComplete', `active=${this.engine.activeToolExecutions - 1}, sseComplete=${this.engine.sseStreamCompleted}`);
    this.engine.activeToolExecutions--;
    // 取消后不再触发循环迭代（stop() 已负责保存已完成的结果）
    if (this.engine.isCancelled) return;
    if (this.engine.activeToolExecutions === 0 && this.engine.sseStreamCompleted) {
      this.finalizeStatelessTurn();
    }
  }

  async finalizeStatelessTurn(): Promise<void> {
    if (this.engine.pendingToolResults.length > 0 && !this.engine.isCancelled) {
      this.continueToolCallingLoop();
    } else {
      // Hook: Stop — 参考 Copilot ToolCallingLoop.executeStopHook()
      // 在 Agent 循环结束前允许 Hook 阻止停止，注入后续任务
      if (this.engine.hookService.hasHandlers('Stop')) {
        this.engine.hookService.executeStop({
          stopHookActive: this._stopHookActive,
          toolCallingIteration: this.engine.toolCallingIteration,
        }).then(async (stopResult) => {
          if (stopResult.shouldContinue && stopResult.reasons && stopResult.reasons.length > 0) {
            // 参考 Copilot: 将 Hook 原因格式化为 user 消息，注入下轮
            this._stopHookReason = formatHookContext(stopResult.reasons);
            this._stopHookActive = true;
            console.log('[Hook] Stop 被阻止，将继续循环:', stopResult.reasons);

            // 注入 Hook 原因作为 user 消息，然后继续循环
            const base = this._preparedMessages ?? this.engine.turnManager.buildMessages();
            this._preparedMessages = [
              ...base,
              { role: 'user', content: this._stopHookReason },
            ];
            this._stopHookReason = undefined;
            this.engine.toolCallingIteration++;
            this.startChatTurn();
            return;
          }
          // Hook 未阻止，正常完成
          await this._doFinalize();
        }).catch(async (err) => {
          console.error('[Hook] Stop hook 执行异常，正常完成:', err);
          await this._doFinalize();
        });
        return;
      }

      await this._doFinalize();
    }
  }

  /**
   * 实际完成逻辑（从 finalizeStatelessTurn 抽取，供 Hook 流程复用）
   */
  private async _doFinalize(): Promise<void> {
    // Turn 结构化存储：最终 assistant 响应
    this.engine.turnManager.finalizeTurn(this.engine.currentTurnAssistantContent || '');
    // P0-perf: 构建一次 messages 并复用，避免通过 getter 重复触发 buildMessages()
    const finalMessages = this.engine.turnManager.buildMessages();
    // Method C: 异步 token 计数
    await this.engine.contextBudgetService.updateBudgetAsync(finalMessages, this.getCurrentTools());
    const budget = this.engine.contextBudgetService.getSnapshot();
    this.engine.contextBudgetService.backgroundSummarizer.checkAndTrigger(
      finalMessages, budget.maxContextTokens, budget.currentTokens,
      this.engine.sessionId, this.engine.turnManager,
      this.getCurrentLLMConfig(), this.engine.currentModel?.model || undefined
    );

    // 提交当前 turn 的 checkpoint
    this.engine.editCheckpointService.commitCurrentTurn();

    // 如果本轮有文件变更，通过服务推送摘要到面板
    if (this.engine.editCheckpointService.hasEditsInCurrentTurn()) {
      if (this.engine.ailyChatConfigService.autoSaveEdits) {
        // 自动保存模式：直接保留变更，不弹出面板
        this.engine.editCheckpointService.acceptAllAsBaseline();
        this.engine.editCheckpointService.dismissSummary();
      } else {
        const summary = this.engine.editCheckpointService.getEditsSummary();
        this.engine.editCheckpointService.publishSummary(summary);
      }
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

    // 重置 Stop Hook 状态
    this._stopHookActive = false;
  }
}
