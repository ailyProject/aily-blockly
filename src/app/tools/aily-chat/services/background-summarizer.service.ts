import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { ChatService } from './chat.service';
import { AilyChatConfigService } from './aily-chat-config.service';
import { estimateMessagesTokens, estimateTokenCount } from './context-budget.service';
import type { TurnSpan } from '../core/turn-types';
import { TurnManager } from '../core/turn-manager';

// ==================== 后台摘要化状态机 ====================

/**
 * 后台摘要化状态
 *
 * 状态机：Idle → InProgress → Completed/Failed → (consume) → Idle
 */
export enum BackgroundSummarizationState {
  /** 空闲，未启动摘要 */
  Idle = 'Idle',
  /** 正在后台执行 LLM 摘要 */
  InProgress = 'InProgress',
  /** 摘要完成，等待消费 */
  Completed = 'Completed',
  /** 摘要失败 */
  Failed = 'Failed',
}

/**
 * 后台摘要化结果
 */
export interface BackgroundSummaryResult {
  /** 摘要文本 */
  summary: string;
  /** 被摘要覆盖的 Turn ID 列表 */
  coveredTurnIds: string[];
  /** 摘要锚定的 Turn ID */
  anchorTurnId: string;
  /** 摘要优先锚定的 ToolCallRound ID（Copilot 对齐） */
  anchorRoundId?: string;
  /** 被摘要的消息数量（可见消息视角，仅用于日志） */
  summarizedMessageCount: number;
  /** 摘要来源 */
  source: 'background' | 'foreground';
  /** 摘要生成时间戳 */
  timestamp: number;
  /** 摘要生成时的 Turn 历史版本号（用于写回防竞态） */
  historyRevision: number;
}

interface SummaryPlan {
  coveredTurnIds: string[];
  anchorTurnId: string;
  anchorRoundId?: string;
  toSummarizeMessages: any[];
  historyRevision: number;
}

// ==================== 摘要提示模板 ====================

/**
 * 参考 Copilot SummarizedConversationHistory 的 8-section 结构
 *
 * Copilot 原文：
 * "Your task is to create a comprehensive, detailed summary of the entire
 * conversation that captures all essential information needed to seamlessly
 * continue the work without any loss of context"
 *
 * 额外增加了 Copilot 特有的 "Analysis Process"（在 <analysis> 标签中进行分析后再输出最终摘要）
 * 以及 "Recent Commands Analysis" 部分。
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `你是一个对话历史摘要专家。你的任务是创建一份全面、详细的对话摘要，捕获所有关键信息以确保后续对话能无缝继续。

## 分析过程

在生成最终摘要之前，先在 <analysis> 标签中进行分析：

<analysis>
1. **时间线回顾** — 按时间顺序列出所有关键事件和操作
2. **意图映射** — 用户的原始需求 → 中间调整 → 当前目标
3. **技术清单** — 涉及的所有技术组件、文件、工具
4. **代码考古** — 已修改的代码结构和设计决策
5. **进度评估** — 完成了什么、什么正在进行、什么还没开始
6. **上下文验证** — 确认所有关键信息（路径、名称、配置）已记录
7. **最近命令分析** — 最后几轮工具调用的详细操作和结果
</analysis>

## 摘要结构（8个分区）

基于以上分析，输出结构化摘要：

### 1. 对话概览
- 用户的主要目标和需求
- 会话的整体方向和进展
- 用户意图的演变过程

### 2. 技术基础
- 涉及的技术栈、框架、语言
- 关键的技术约束和依赖关系
- 重要的配置信息（路径、环境、版本等）

### 3. 代码库状态
- 已修改的文件列表及变更内容摘要
- 关键的代码结构和设计决策
- 重要的函数/类/变量名称及其作用
- 代码段的关键依赖关系

### 4. 问题解决
- 已解决的问题列表及解决方案
- 未解决的问题和待办事项
- 当前正在处理的任务
- 遇到的错误及修复方法

### 5. 进度跟踪
- [x] 已完成的任务
- [ ] 进行中的任务
- [ ] 未开始的任务

### 6. 活跃工作状态
- 最后正在执行的操作
- 代码/文件的当前修改状态
- 触发摘要化的上下文（什么导致了 token 超限）

### 7. 最近操作
- **最后的 Agent 命令**：最近几次工具调用的具体操作
- **工具结果**：关键输出和发现
- **即时状态**：摘要化前系统正在做什么

### 8. 继续计划
- 下一步应该执行的操作
- 任何未完成的工作流
- 需要用户确认的决策

## 注意事项
- 保留所有重要的文件路径、变量名、函数名等具体信息
- 工具调用结果中的关键数据要保留（如搜索到的文件列表、代码片段的关键部分）
- 不要遗漏任何可能影响后续对话的技术细节
- 摘要应当详细到让一个新的 AI 接手也能无缝继续工作
- 使用简洁的结构化格式，避免冗余描述`;

export const SUMMARIZATION_USER_PROMPT_TEMPLATE = `请为以下对话历史创建一份详细的结构化摘要。

特别注意：
1. 保留最近几轮的完整上下文（最后的 agent 操作和工具结果）
2. 确保所有文件路径、变量名、函数签名等具体信息不丢失
3. 工具执行的关键结果要保留
4. 当前正在进行的任务状态要清晰

对话历史：
{conversation}`;

// ==================== 后台摘要化服务 ====================

/**
 * 后台摘要化服务
 *
 * 参考 Copilot 的 BackgroundSummarizer + SummarizedConversationHistory 实现。
 *
 * ## 核心设计
 *
 * Copilot 的 fallback 链为：
 * 1. prompt-tsx PrioritizedList 自动优先级丢弃
 * 2. 后台摘要化（75%/95% 双阈值）      ← 本服务实现此层
 * 3. 前台 Full mode LLM 摘要
 * 4. Simple mode 纯文本截断
 *
 * ## 双阈值策略
 *
 * - **≥ 75% maxContextTokens**：后台启动 LLM 摘要，用户无感
 * - **≥ 95% maxContextTokens**：如果后台摘要正在进行，阻塞等待完成
 * - 摘要完成后下次 `compressIfNeeded` 会自动应用结果
 *
 * ## 摘要 token 上限
 *
 * 参考 Copilot 的 `maxSummaryTokens: 7_000`，防止摘要本身过长。
 *
 * @see ContextBudgetService — 压缩分层的上层调度
 */
@Injectable({
  providedIn: 'root'
})
export class BackgroundSummarizerService {

  // ==================== 阈值 ====================

  /** 后台摘要触发阈值比例（Copilot: 75%） */
  private static readonly BACKGROUND_TRIGGER_RATIO = 0.75;

  /** 阻塞等待阈值比例（Copilot: 95%） */
  private static readonly BLOCKING_WAIT_RATIO = 0.95;

  /** 摘要最大 token 数（Copilot: 7000） */
  static readonly MAX_SUMMARY_TOKENS = 7000;

  /** 摘要请求超时（毫秒） */
  private static readonly SUMMARY_TIMEOUT_MS = 60000;

  // ==================== 状态 ====================

  /** 当前状态 */
  private _state: BackgroundSummarizationState = BackgroundSummarizationState.Idle;

  /** 摘要结果 */
  private _result: BackgroundSummaryResult | null = null;

  /** 正在执行的摘要 Promise（用于 await） */
  private _pendingPromise: Promise<BackgroundSummaryResult | null> | null = null;

  /** 当前活跃的 subscription（用于取消后台摘要） */
  private _activeSubscription: Subscription | null = null;

  /** 前台摘要的 subscription（用于取消前台摘要） */
  private _foregroundSubscription: Subscription | null = null;

  /** 状态 Observable */
  private stateSubject = new BehaviorSubject<BackgroundSummarizationState>(BackgroundSummarizationState.Idle);
  public state$ = this.stateSubject.asObservable();

  get state(): BackgroundSummarizationState {
    return this._state;
  }

  get result(): BackgroundSummaryResult | null {
    return this._result;
  }

  constructor(
    private chatService: ChatService,
    private ailyChatConfigService: AilyChatConfigService
  ) {}

  // ==================== 公共 API ====================

  /**
   * 检查当前 token 使用率并决定是否后台启动摘要化
   *
   * 调用时机：每轮对话结束后（`finalizeStatelessTurn` / `continueToolCallingLoop`）
   *
   * @param messages     当前完整对话历史
   * @param maxTokens    模型上下文窗口大小
   * @param currentTokens 当前 token 使用量
   * @param sessionId    会话 ID
   * @param llmConfig    LLM 配置
   * @param selectModel  模型名称
   */
  checkAndTrigger(
    messages: any[],
    maxTokens: number,
    currentTokens: number,
    sessionId: string,
    turnManager: TurnManager,
    llmConfig?: any,
    selectModel?: string
  ): void {
    const ratio = currentTokens / maxTokens;

    // 已有结果或正在执行中，不重复触发
    if (this._state === BackgroundSummarizationState.Completed ||
        this._state === BackgroundSummarizationState.InProgress) {
      return;
    }

    // ≥ 75%：启动后台摘要
    if (ratio >= BackgroundSummarizerService.BACKGROUND_TRIGGER_RATIO) {
      console.log(`[后台摘要] token 使用率 ${(ratio * 100).toFixed(1)}% ≥ 75%，启动后台摘要化`);
      this.startBackground(messages, turnManager, sessionId, llmConfig, selectModel);
    }
  }

  /**
   * 阻塞等待后台摘要完成（≥ 95% 时调用）
   *
   * @returns 摘要结果，或 null（超时/失败）
   */
  async waitForCompletion(): Promise<BackgroundSummaryResult | null> {
    if (this._state === BackgroundSummarizationState.Completed) {
      return this._result;
    }
    if (this._state === BackgroundSummarizationState.InProgress && this._pendingPromise) {
      console.log(`[后台摘要] token ≥ 95%，阻塞等待后台摘要完成...`);
      return await this._pendingPromise;
    }
    return null;
  }

  /**
   * 消费摘要结果：获取结果并重置状态为 Idle
   *
   * @returns 摘要结果，或 null
   */
  consumeResult(): BackgroundSummaryResult | null {
    if (this._state !== BackgroundSummarizationState.Completed || !this._result) {
      return null;
    }
    const result = this._result;
    this.resetToIdle();
    return result;
  }

  /**
   * 应用摘要结果到消息数组
   *
   * @param messages 当前对话历史
   * @param result 摘要结果
   * @returns 压缩后的消息数组
   */
  applySummary(turnManager: TurnManager, result: BackgroundSummaryResult): { messages: any[]; success: boolean } {
    const summary = this.validateAndTruncateSummary(result.summary);
    const success = turnManager.applySummary(
      result.coveredTurnIds,
      result.anchorTurnId,
      summary,
      result.source,
      result.anchorRoundId,
      result.historyRevision
    );
    if (success) {
      console.log(`[后台摘要] 已写回 Turn 历史：覆盖 ${result.coveredTurnIds.length} 个 turn，锚点 ${result.anchorRoundId ?? result.anchorTurnId}`);
    } else {
      console.warn(`[后台摘要] 写回 Turn 历史失败：摘要与当前历史不一致，覆盖 ${result.coveredTurnIds.length} 个 turn`);
    }
    return { messages: turnManager.buildMessages(), success };
  }

  /**
   * 判断当前是否应阻塞等待（≥ 95% 且 InProgress）
   */
  shouldBlockAndWait(currentTokens: number, maxTokens: number): boolean {
    return (currentTokens / maxTokens) >= BackgroundSummarizerService.BLOCKING_WAIT_RATIO
      && this._state === BackgroundSummarizationState.InProgress;
  }

  /**
   * 重置状态（新会话时调用）
   */
  reset(): void {
    this.cancelActive();
    this.resetToIdle();
  }

  // ==================== 前台摘要（Layer 3 委托） ====================

  /**
   * 前台同步摘要 — 供 ContextBudgetService Layer 3 直接调用
   *
   * 复用 findPreservePoint / buildConversationText / validateAndTruncateSummary，
   * 但使用独立的 LLM 调用（不影响后台 _activeSubscription）。
   * 超时 30s（前台需快速返回，不能像后台那样等 60s）。
   *
   * 参考 Copilot 的 Full → Simple 降级链：
   * 1. 优先使用 LLM 生成高质量摘要（Full mode）
   * 2. LLM 失败/超时时，降级为纯文本压缩（Simple mode）
   *    而非直接抛异常让上层回退到优先级裁剪
   *
   * @returns 压缩后的消息数组 [summaryMessage, ...preservedMessages]
   */
  async foregroundSummarize(
    messages: any[],
    turnManager: TurnManager,
    sessionId: string,
    llmConfig?: any,
    selectModel?: string
  ): Promise<any[]> {
    const plan = this.buildSummaryPlan(messages, turnManager);
    if (!plan) {
      return messages;
    }

    // Full mode: LLM 摘要
    try {
      const conversationText = this.buildConversationText(plan.toSummarizeMessages);
      const userPrompt = SUMMARIZATION_USER_PROMPT_TEMPLATE.replace('{conversation}', conversationText);
      const summaryMessages = [
        { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ];

      let summary = await this.callLLMForeground(sessionId, summaryMessages, llmConfig, selectModel);

      if (!summary) {
        throw new Error('LLM 摘要返回空结果');
      }

      summary = this.validateAndTruncateSummary(summary);

      const result: BackgroundSummaryResult = {
        summary,
        coveredTurnIds: plan.coveredTurnIds,
        anchorTurnId: plan.anchorTurnId,
        anchorRoundId: plan.anchorRoundId,
        summarizedMessageCount: plan.toSummarizeMessages.length,
        source: 'foreground',
        timestamp: Date.now(),
        historyRevision: plan.historyRevision,
      };

      console.log(`[前台摘要] Full mode: 将 ${plan.toSummarizeMessages.length} 条消息收敛为 LLM 摘要，覆盖 ${plan.coveredTurnIds.length} 个 turn`);
      return this.applySummary(turnManager, result).messages;
    } catch (fullModeError) {
      // Simple mode fallback: 纯文本压缩（参考 Copilot SummarizedConversationHistory 降级链）
      console.warn(`[前台摘要] Full mode 失败，降级为 Simple mode:`, fullModeError);
      return this.simpleFallback(plan, turnManager);
    }
  }

  /**
   * Simple mode 降级 — 纯文本压缩（不依赖 LLM）
   *
   * 参考 Copilot 的 Simple mode：当 Full mode（LLM 摘要）失效时，
   * 用纯文本压缩替代：对旧历史的工具结果截断到 50%，
   * 并生成一份结构化的纯文本摘要替换最旧的 Turn。
   *
   * 比单纯的优先级裁剪（Layer 2）更好：
   * - 优先级裁剪直接丢弃整个 Turn，丢失全部上下文
   * - Simple mode 保留 Turn 结构但压缩内容，保留更多信息
   */
  private simpleFallback(plan: SummaryPlan, turnManager: TurnManager): any[] {
    // 构建纯文本摘要：提取每个被覆盖 Turn 的关键信息
    const lines: string[] = [
      '<conversation-summary>',
      '## Summary (auto-generated, Simple mode)',
      '',
    ];

    for (const msg of plan.toSummarizeMessages) {
      if (msg.role === 'user') {
        const content = (msg.content || '').substring(0, 500);
        lines.push(`**User**: ${content}${msg.content?.length > 500 ? '...' : ''}`);
      } else if (msg.role === 'assistant') {
        const content = (msg.content || '')
          .replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/```aily-state[\s\S]*?```/g, '')
          .replace(/```aily-mermaid[\s\S]*?```/g, '')
          .substring(0, 800);
        if (content.trim()) {
          lines.push(`**Assistant**: ${content}${msg.content?.length > 800 ? '...' : ''}`);
        }
        if (msg.tool_calls) {
          const toolNames = msg.tool_calls.map((tc: any) => tc.function?.name || 'unknown').join(', ');
          lines.push(`  [Called tools: ${toolNames}]`);
        }
      } else if (msg.role === 'tool') {
        const truncContent = (msg.content || '').substring(0, 200);
        lines.push(`  [Tool ${msg.name || 'unknown'} result]: ${truncContent}${msg.content?.length > 200 ? '...' : ''}`);
      }
    }

    lines.push('', '</conversation-summary>');
    const simpleSummary = lines.join('\n');

    const result: BackgroundSummaryResult = {
      summary: simpleSummary,
      coveredTurnIds: plan.coveredTurnIds,
      anchorTurnId: plan.anchorTurnId,
      anchorRoundId: plan.anchorRoundId,
      summarizedMessageCount: plan.toSummarizeMessages.length,
      source: 'foreground',
      timestamp: Date.now(),
      historyRevision: plan.historyRevision,
    };

    console.log(`[前台摘要] Simple mode: 纯文本压缩 ${plan.toSummarizeMessages.length} 条消息，覆盖 ${plan.coveredTurnIds.length} 个 turn`);
    return this.applySummary(turnManager, result).messages;
  }

  // ==================== 内部实现 ====================

  /**
   * 启动后台摘要
   */
  private startBackground(
    messages: any[],
    turnManager: TurnManager,
    sessionId: string,
    llmConfig?: any,
    selectModel?: string
  ): void {
    this._state = BackgroundSummarizationState.InProgress;
    this.stateSubject.next(this._state);

    // 快照消息数组（不修改原数组）
    const snapshot = [...messages];

    this._pendingPromise = this.executeSummarization(snapshot, turnManager, sessionId, llmConfig, selectModel)
      .then(result => {
        if (this._state === BackgroundSummarizationState.InProgress) {
          this._result = result;
          this._state = BackgroundSummarizationState.Completed;
          this.stateSubject.next(this._state);
          console.log(`[后台摘要] 完成：${result.summarizedMessageCount} 条消息已摘要，覆盖 ${result.coveredTurnIds.length} 个 turn`);
        }
        return result;
      })
      .catch(err => {
        if (this._state === BackgroundSummarizationState.InProgress) {
          console.warn(`[后台摘要] 失败:`, err);
          this._state = BackgroundSummarizationState.Failed;
          this.stateSubject.next(this._state);
        }
        return null;
      });
  }

  /**
   * 执行摘要化（异步）
   */
  private async executeSummarization(
    messages: any[],
    turnManager: TurnManager,
    sessionId: string,
    llmConfig?: any,
    selectModel?: string
  ): Promise<BackgroundSummaryResult> {
    const plan = this.buildSummaryPlan(messages, turnManager);
    if (!plan) {
      throw new Error('没有可摘要的历史');
    }

    // 构建摘要请求文本（截断避免摘要请求本身过大）
    const conversationText = this.buildConversationText(plan.toSummarizeMessages);
    const userPrompt = SUMMARIZATION_USER_PROMPT_TEMPLATE.replace('{conversation}', conversationText);

    const summaryMessages = [
      { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ];

    // 调用 LLM 生成摘要
    let summary = await this.callLLMForSummary(sessionId, summaryMessages, llmConfig, selectModel);

    if (!summary) {
      throw new Error('LLM 摘要返回空结果');
    }

    // 统一验证/截断摘要长度
    summary = this.validateAndTruncateSummary(summary);
    console.log(`[后台摘要] 摘要生成完成，${estimateTokenCount(summary)} tokens（上限 ${BackgroundSummarizerService.MAX_SUMMARY_TOKENS}）`);

    return {
      summary,
      coveredTurnIds: plan.coveredTurnIds,
      anchorTurnId: plan.anchorTurnId,
      anchorRoundId: plan.anchorRoundId,
      summarizedMessageCount: plan.toSummarizeMessages.length,
      source: 'background',
      timestamp: Date.now(),
      historyRevision: plan.historyRevision,
    };
  }

  private buildSummaryPlan(messages: any[], turnManager: TurnManager): SummaryPlan | null {
    const visibleSpans = [...turnManager.turnSpans] as TurnSpan[];
    const turns = turnManager.turnsSnapshot;
    if (visibleSpans.length <= 1) {
      return null;
    }

    const preserveStartSpanIndex = this.findPreserveStartSpanIndex(visibleSpans);
    if (preserveStartSpanIndex <= 0) {
      return null;
    }

    const anchorSpan = visibleSpans[preserveStartSpanIndex - 1];
    if (!anchorSpan) {
      return null;
    }

    const coveredTurnIds = turns
      .slice(0, anchorSpan.turnIndex + 1)
      .map(turn => turn.id);

    const toSummarizeMessages = messages.slice(0, anchorSpan.endIdx);
    if (!coveredTurnIds.length || !toSummarizeMessages.length) {
      return null;
    }

    return {
      coveredTurnIds,
      anchorTurnId: anchorSpan.turnId,
      anchorRoundId: turns[anchorSpan.turnIndex]?.response?.toolCallRounds.at(-1)?.id,
      toSummarizeMessages,
      historyRevision: turnManager.revision,
    };
  }

  private findPreserveStartSpanIndex(spans: TurnSpan[]): number {
    const minPreserveMessages = 6;
    let preservedMessages = 0;
    let preserveStart = spans.length;

    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i];
      preservedMessages += span.endIdx - span.startIdx;
      preserveStart = i;

      if (preservedMessages >= minPreserveMessages) {
        break;
      }

      if (preservedMessages > Math.ceil(spans.length / 2)) {
        break;
      }
    }

    return preserveStart;
  }

  /**
   * 构建摘要请求的对话文本
   */
  private buildConversationText(messages: any[]): string {
    return messages.map(msg => {
      let text = `[${msg.role}]`;
      if (msg.name) text += ` (${msg.name})`;
      text += `: `;
      if (msg.content) {
        const maxLen = msg.role === 'tool' ? 2000 : 5000;
        const content = msg.content.length > maxLen
          ? msg.content.substring(0, Math.floor(maxLen * 0.4))
            + '\n...[内容已截断]...\n'
            + msg.content.substring(msg.content.length - Math.floor(maxLen * 0.6))
          : msg.content;
        text += content;
      }
      if (msg.tool_calls) {
        text += `\n  [工具调用]: ${msg.tool_calls.map((tc: any) => {
          const args = tc.function?.arguments || '';
          const truncArgs = args.length > 200
            ? args.substring(0, 80) + '...' + args.substring(args.length - 80)
            : args;
          return `${tc.function?.name}(${truncArgs})`;
        }).join(', ')}`;
      }
      return text;
    }).join('\n\n');
  }

  /**
   * 验证并截断摘要的 token 数，防止摘要本身过长
   * 参考 Copilot 的 maxSummaryTokens 限制
   */
  private validateAndTruncateSummary(summary: string): string {
    const summaryTokens = estimateTokenCount(summary);
    if (summaryTokens > BackgroundSummarizerService.MAX_SUMMARY_TOKENS * 1.5) {
      console.warn(`[摘要] 摘要过长 (${summaryTokens} tokens > ${BackgroundSummarizerService.MAX_SUMMARY_TOKENS * 1.5})，截断`);
      const maxChars = BackgroundSummarizerService.MAX_SUMMARY_TOKENS * 4;
      if (summary.length > maxChars) {
        const marker = '\n\n[... 摘要过长，部分内容已省略 ...]\n\n';
        const available = maxChars - marker.length;
        summary = summary.substring(0, Math.floor(available * 0.5))
          + marker
          + summary.substring(summary.length - Math.floor(available * 0.5));
      }
    }
    return summary;
  }

  /**
   * 前台 LLM 调用（独立于后台 _activeSubscription，30s 超时）
   */
  private callLLMForeground(
    sessionId: string,
    messages: any[],
    llmConfig?: any,
    selectModel?: string
  ): Promise<string> {
    return new Promise(async (resolve, reject) => {
      let summaryText = '';
      let resolved = false;

      const fgSessionId = sessionId + '_fg_summary';
      try {
        await this.chatService.startSession('ask', null, undefined, llmConfig, selectModel, fgSessionId).toPromise();
      } catch (e) {
        // 忽略重复创建错误，继续请求
      }

      const subscription = this.chatService.chatRequest(
        fgSessionId,
        messages,
        null,
        'ask',
        llmConfig,
        selectModel,
        undefined
      ).subscribe({
        next: (data: any) => {
          if (data.type === 'ModelClientStreamingChunkEvent' && data.content) {
            summaryText += data.content;
          }
        },
        complete: () => {
          if (!resolved) {
            resolved = true;
            this._foregroundSubscription = null;
            resolve(summaryText.trim());
          }
          subscription.unsubscribe();
        },
        error: (err) => {
          if (!resolved) {
            resolved = true;
            this._foregroundSubscription = null;
            reject(err);
          }
          subscription.unsubscribe();
        }
      });

      // 跟踪前台订阅，以便 cancel() 时取消
      this._foregroundSubscription = subscription;

      // 前台 30s 超时（比后台更短）
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          subscription.unsubscribe();
          if (summaryText.trim()) {
            resolve(summaryText.trim());
          } else {
            reject(new Error('前台 LLM 摘要请求超时'));
          }
        }
      }, 30000);
    });
  }

  /**
   * 后台 LLM 调用（使用 _activeSubscription 跟踪，可取消）
   */
  private callLLMForSummary(
    sessionId: string,
    messages: any[],
    llmConfig?: any,
    selectModel?: string
  ): Promise<string> {
    return new Promise(async (resolve, reject) => {
      let summaryText = '';
      let resolved = false;

      const bgSessionId = sessionId + '_bg_summary';
      try {
        await this.chatService.startSession('ask', null, undefined, llmConfig, selectModel, bgSessionId).toPromise();
      } catch (e) {
        // 忽略重复创建错误，继续请求
      }

      this._activeSubscription = this.chatService.chatRequest(
        bgSessionId, // 独立 session ID，不干扰主对话
        messages,
        null,     // 不需要工具
        'ask',    // ask 模式（不执行工具）
        llmConfig,
        selectModel,
        undefined
      ).subscribe({
        next: (data: any) => {
          if (data.type === 'ModelClientStreamingChunkEvent' && data.content) {
            summaryText += data.content;
          }
        },
        complete: () => {
          if (!resolved) {
            resolved = true;
            resolve(summaryText.trim());
          }
        },
        error: (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        }
      });

      // 超时保护
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this._activeSubscription?.unsubscribe();
          this._activeSubscription = null;
          if (summaryText.trim()) {
            resolve(summaryText.trim());
          } else {
            reject(new Error('后台摘要请求超时'));
          }
        }
      }, BackgroundSummarizerService.SUMMARY_TIMEOUT_MS);
    });
  }

  /**
   * 找到保留最近消息的起始点
   * 至少保留最后一个完整的 user → assistant → tool 交互周期
   */
  /**
   * 取消所有正在进行的摘要（前台 + 后台）
   * 供外部在 stop() 时调用，避免用户取消后摘要仍消耗资源
   */
  cancelActive(): void {
    if (this._activeSubscription) {
      this._activeSubscription.unsubscribe();
      this._activeSubscription = null;
    }
    if (this._foregroundSubscription) {
      this._foregroundSubscription.unsubscribe();
      this._foregroundSubscription = null;
    }
    this._pendingPromise = null;
  }

  /**
   * 重置状态为 Idle
   */
  private resetToIdle(): void {
    this._state = BackgroundSummarizationState.Idle;
    this._result = null;
    this._pendingPromise = null;
    this.stateSubject.next(this._state);
  }
}
