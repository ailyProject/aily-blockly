import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ChatService } from './chat.service';
import { AilyChatConfigService } from './aily-chat-config.service';
import { TiktokenService } from './tiktoken.service';

// ==================== Token 计数工具 ====================

/**
 * 模块级 TiktokenService 引用
 * 由 ContextBudgetService 构造时注入，供独立导出的函数使用
 */
let _tiktokenService: TiktokenService | null = null;

/** @internal 设置 TiktokenService 实例（由 ContextBudgetService 调用） */
export function _setTiktokenService(service: TiktokenService): void {
  _tiktokenService = service;
}

/**
 * 精确 Token 计数器
 *
 * 优先使用 tiktoken (o200k_base) 精确计数，
 * tiktoken 未就绪时回退到启发式估算（误差约 ±15%）。
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  if (_tiktokenService) {
    return _tiktokenService.countTokens(text);
  }
  // fallback：启发式估算
  return _estimateTokensFallback(text);
}

/**
 * 异步 Token 计数器 — 长文本卸载到 Worker
 *
 * 参考 Copilot TokenizerProvider 的 Worker 架构：
 * 短文本同步计数（返回 resolved Promise），
 * 长文本通过 Worker 异步计数避免阻塞 UI。
 */
export async function estimateTokenCountAsync(text: string): Promise<number> {
  if (!text) return 0;
  if (_tiktokenService) {
    return _tiktokenService.countTokensAsync(text);
  }
  return _estimateTokensFallback(text);
}

/** 启发式 fallback（tiktoken 未就绪时使用） */
function _estimateTokensFallback(text: string): number {
  let tokenCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x4E00 && code < 0x9FFF) {
      tokenCount += 0.67;
    } else if (code > 0x7F) {
      tokenCount += 0.5;
    } else {
      tokenCount += 0.25;
    }
  }
  return Math.ceil(tokenCount);
}

/**
 * 估算单条消息的 token 数
 * 参考 OpenAI 的 "every message follows <im_start>{role/name}\n{content}<im_end>\n" 格式
 * 每条消息额外开销约 4 tokens
 */
export function estimateMessageTokens(message: any): number {
  const overhead = 4; // 消息框架开销

  let tokens = overhead;
  if (message.role) tokens += estimateTokenCount(message.role);
  if (message.content) tokens += estimateTokenCount(message.content);
  if (message.name) tokens += estimateTokenCount(message.name);

  // tool_calls 字段
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      tokens += 4; // tool_call 框架
      if (tc.id) tokens += estimateTokenCount(tc.id);
      if (tc.function?.name) tokens += estimateTokenCount(tc.function.name);
      if (tc.function?.arguments) {
        const args = typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments);
        tokens += estimateTokenCount(args);
      }
    }
  }

  return tokens;
}

/**
 * 估算消息数组的总 token 数
 */
export function estimateMessagesTokens(messages: any[]): number {
  if (!messages || messages.length === 0) return 0;
  // 额外 2 tokens 用于 prompt 首尾
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0) + 2;
}

/**
 * 异步估算单条消息的 token 数
 * content 和 tool_call arguments（大字段）走 Worker 异步计数，
 * role/name/id 等短字段保持同步。
 */
export async function estimateMessageTokensAsync(message: any): Promise<number> {
  const overhead = 4;
  let tokens = overhead;
  if (message.role) tokens += estimateTokenCount(message.role);
  if (message.content) tokens += await estimateTokenCountAsync(message.content);
  if (message.name) tokens += estimateTokenCount(message.name);

  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      tokens += 4;
      if (tc.id) tokens += estimateTokenCount(tc.id);
      if (tc.function?.name) tokens += estimateTokenCount(tc.function.name);
      if (tc.function?.arguments) {
        const args = typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments);
        tokens += await estimateTokenCountAsync(args);
      }
    }
  }

  return tokens;
}

/**
 * 异步估算消息数组的总 token 数
 * 所有消息并行计算，长文本卸载到 Worker。
 */
export async function estimateMessagesTokensAsync(messages: any[]): Promise<number> {
  if (!messages || messages.length === 0) return 0;
  const results = await Promise.all(messages.map(msg => estimateMessageTokensAsync(msg)));
  return results.reduce((a, b) => a + b, 0) + 2;
}

/**
 * 估算工具定义数组的 token 数
 * 每个工具定义会被序列化为 JSON schema 格式发送给 LLM
 */
export function estimateToolsTokens(tools: any[]): number {
  if (!tools || tools.length === 0) return 0;

  // 参考 Copilot: baseToolTokens=16（tools 数组整体框架） + baseTokensPerTool=8（每个工具）
  let tokens = 16; // 工具定义数组框架开销（一次性）
  for (const tool of tools) {
    tokens += 8; // 每个工具的定义框架开销
    if (tool.name) tokens += estimateTokenCount(tool.name);
    if (tool.description) tokens += estimateTokenCount(tool.description);
    if (tool.input_schema) {
      tokens += estimateTokenCount(JSON.stringify(tool.input_schema));
    } else if (tool.parameters) {
      tokens += estimateTokenCount(JSON.stringify(tool.parameters));
    }
  }

  return tokens;
}

// ==================== 上下文预算状态 ====================

/**
 * 上下文预算快照（供 UI 消费）
 *
 * 参考 Copilot 的 Context Window 面板，分 System / Tools / Messages 三部分展示占用
 */
export interface ContextBudgetSnapshot {
  /** 总占用 token 数（system + tools + context + messages） */
  currentTokens: number;
  /** 模型上下文窗口总 token 数 */
  maxContextTokens: number;
  /** 触发工具结果压缩的阈值（token 数） */
  compressionThreshold: number;
  /** 触发 LLM 摘要的阈值（token 数） */
  summarizationThreshold: number;
  /** 使用率百分比 (0-100) */
  usagePercent: number;
  /** 消息总数 */
  messageCount: number;
  /** 最后一次更新时间 */
  updatedAt: number;

  // ===== 分项明细（参考 Copilot Context Window 面板） =====
  /** 系统提示词占用 token 数 */
  systemTokens: number;
  /** 工具定义占用 token 数 */
  toolsTokens: number;
  /** 瞬态上下文注入占用 token 数（<aily-context>: skills + memory + deferred tools listing） */
  contextTokens: number;
  /** 对话消息占用 token 数 */
  messagesTokens: number;
  /** 系统提示词占比 (0-100) */
  systemPercent: number;
  /** 工具定义占比 (0-100) */
  toolsPercent: number;
  /** 瞬态上下文注入占比 (0-100) */
  contextPercent: number;
  /** 对话消息占比 (0-100) */
  messagesPercent: number;
}

/**
 * 上下文压缩事件
 */
export interface ContextCompressionEvent {
  type: 'tool_compression' | 'llm_summarization';
  /** 压缩前 token 数 */
  beforeTokens: number;
  /** 压缩后 token 数 */
  afterTokens: number;
  /** 压缩的消息数量 */
  compressedMessages: number;
  timestamp: number;
}

// ==================== 后台摘要服务 ====================
import {
  BackgroundSummarizerService,
  BackgroundSummarizationState
} from './background-summarizer.service';
import type { TurnSpan } from '../core/turn-types';
import { TurnManager } from '../core/turn-manager';
import {
  PrioritizedListEngine,
  annotateWithPriority,
  annotateMessagesLegacy,
} from '../core/prioritized-list';

// ==================== 主服务 ====================

/**
 * 上下文预算管理服务
 *
 * 分层策略：
 * 1. 全量保留：当 token 数低于 compressionThreshold 时保留完整历史
 * 2. 工具结果压缩：超过 compressionThreshold 时截断旧的工具结果
 * 3. LLM 摘要：超过 summarizationThreshold 时调用 LLM 生成摘要替换旧历史
 *
 * 同时暴露 Observable 供 UI 展示上下文使用量。
 */
@Injectable({
  providedIn: 'root'
})
export class ContextBudgetService {

  // ==================== 模型上下文窗口配置 ====================

  /** 已知模型的上下文窗口大小（tokens） */
  private static readonly MODEL_CONTEXT_SIZES: Record<string, number> = {
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4': 8192,
    'gpt-3.5-turbo': 16385,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 128000,
    'claude-3-haiku': 128000,
    'claude-3.5-sonnet': 128000,
    'claude-4-sonnet': 128000,
    'claude-4.5-sonnet': 128000,
    'claude-4.6-sonnet': 128000,
    'claude-4.5-opus': 128000,
    'claude-4.6-opus': 128000,
    'deepseek-chat': 64000,
    'deepseek-coder': 64000,
    'qwen-turbo': 131072,
    'qwen-plus': 131072,
    'qwen-max': 32768,
    'GLM-5': 200000,
    'GLM-4.7': 128000,
  };

  /** 默认上下文窗口大小 */
  private static readonly DEFAULT_CONTEXT_SIZE = 200000;

  /** 工具结果压缩阈值比例（占 maxContextTokens 的百分比） */
  private static readonly COMPRESSION_THRESHOLD_RATIO = 0.50;

  /** LLM 摘要阈值比例（占 maxContextTokens 的百分比） */
  private static readonly SUMMARIZATION_THRESHOLD_RATIO = 0.75;

  /**
   * 工具结果截断比例（占 maxContextTokens 的百分比）
   * 参考 Copilot: MAX_TOOL_RESPONSE_PCT = 0.5，即单个工具结果最多占上下文窗口 50%
   * 实际截断上限 = floor(maxContextTokens × MAX_TOOL_RESPONSE_PCT)
   */
  private static readonly MAX_TOOL_RESPONSE_PCT = 0.50;

  /**
   * 信息类工具结果截断比例（占 MAX_TOOL_RESPONSE_PCT 的百分比）
   * 信息类工具 (read_file/fetch/grep) 是 LLM 推理的事实依据，
   * 给予完整的 MAX_TOOL_RESPONSE_PCT 预算。
   * 操作类工具信息密度低，给 25% 预算。
   */
  private static readonly INFO_TOOL_BUDGET_RATIO = 1.0;
  private static readonly ACTION_TOOL_BUDGET_RATIO = 0.25;

  /**
   * Turn 年龄衰减截断系数（参考 Copilot 的 isHistorical 分层策略）
   * 越旧的 Turn 工具结果信息密度越低，更激进地截断以释放预算。
   *   - 当前 Turn（最新）：100% — 完整保留，LLM 正在使用
   *   - 上一 Turn：75% — 近期上下文，仍有参考价值
   *   - 更旧 Turn：50% — 仅保留关键信息
   */
  private static readonly TURN_AGE_TRUNCATION_TIERS = [
    { maxAge: 0, ratio: 1.0 },   // 当前 Turn
    { maxAge: 1, ratio: 0.75 },  // 上一 Turn
    { maxAge: Infinity, ratio: 0.50 },  // 更旧
  ];

  /**
   * 信息类工具名称集合（结果为 LLM 推理事实依据的工具）
   * 这些工具的返回内容通常是代码、文档、网页等高信息密度文本，
   * 截断后会导致 LLM 丢失关键上下文。
   */
  private static readonly INFO_TOOLS = new Set([
    'read_file', 'fetch', 'web_search', 'grep', 'grep_tool', 'glob_tool',
    'get_directory_tree', 'list_directory', 'search_boards_libraries',
    // 'get_abs_syntax', 
    'get_workspace_overview_tool',
  ]);

  /** 保留最近 N 条消息不压缩（确保最近上下文完整） */
  private static readonly RECENT_MESSAGES_PRESERVE = 8;

  /**
   * 留给模型输出的 token 比例（不能把上下文窗口全填满）
   * 参考 Copilot: 预留 15% 给模型生成
   */
  private static readonly OUTPUT_RESERVE_RATIO = 0.15;

  /**
   * 服务端系统提示词的预估 token 数
   *
   * 服务端系统提示词在客户端不可见，
   * 通过人工预估给出合理值。后续可由服务端 API 返回精确值。
   * 当前 系统提示词约 10000+ 中文字符 → ~4500 tokens
   */
  private static readonly ESTIMATED_SYSTEM_PROMPT_TOKENS = 5000;

  // ==================== 状态 ====================

  /** 当前模型上下文窗口大小 */
  private _maxContextTokens: number = ContextBudgetService.DEFAULT_CONTEXT_SIZE;

  /** 自定义上下文窗口大小覆盖（用户在设置中指定时使用） */
  private _customMaxContextTokens: number | null = null;

  /** 上下文预算状态 Observable */
  private budgetSubject = new BehaviorSubject<ContextBudgetSnapshot>(this.createEmptySnapshot());

  /** 压缩事件 Observable */
  private compressionEventSubject = new BehaviorSubject<ContextCompressionEvent | null>(null);

  /** 上下文预算状态 Observable（供 UI 消费） */
  public budget$: Observable<ContextBudgetSnapshot> = this.budgetSubject.asObservable();

  /** 压缩事件 Observable（供 UI 消费） */
  public compressionEvent$: Observable<ContextCompressionEvent | null> = this.compressionEventSubject.asObservable();

  /** 后台摘要化服务（Copilot 风格 75%/95% 双阈值后台压缩） */
  public backgroundSummarizer: BackgroundSummarizerService;

  constructor(
    private chatService: ChatService,
    private ailyChatConfigService: AilyChatConfigService,
    private tiktokenService: TiktokenService
  ) {
    // 注入 TiktokenService 供模块级函数使用
    _setTiktokenService(this.tiktokenService);
    // 初始化系统提示词 token 估算
    this._cachedSystemTokens = ContextBudgetService.ESTIMATED_SYSTEM_PROMPT_TOKENS;
    // 初始化后台摘要化服务
    this.backgroundSummarizer = new BackgroundSummarizerService(chatService, ailyChatConfigService);
  }

  // ==================== 公共接口 ====================

  /**
   * 获取当前上下文预算快照
   */
  getSnapshot(): ContextBudgetSnapshot {
    return this.budgetSubject.getValue();
  }

  /**
   * 获取当前 LLM 上下文窗口总 token 数
   * 优先级：用户配置 > 代码设置 > 模型自动检测值
   */
  get maxContextTokens(): number {
    const configSize = this.ailyChatConfigService?.contextWindowSize;
    if (configSize && configSize > 0) return configSize;
    return this._customMaxContextTokens ?? this._maxContextTokens;
  }

  /**
   * 设置自定义上下文窗口大小（用户覆盖）
   */
  set maxContextTokens(value: number) {
    this._customMaxContextTokens = value > 0 ? value : null;
  }

  /**
   * 获取工具结果压缩阈值（token 数）
   * 优先使用用户配置的比例，否则使用默认值
   */
  get compressionThreshold(): number {
    const ratio = this.ailyChatConfigService?.compressionThresholdRatio
      ?? ContextBudgetService.COMPRESSION_THRESHOLD_RATIO;
    return Math.floor(this.maxContextTokens * ratio);
  }

  /**
   * 获取 LLM 摘要阈值（token 数）
   * 优先使用用户配置的比例，否则使用默认值
   */
  get summarizationThreshold(): number {
    const ratio = this.ailyChatConfigService?.summarizationThresholdRatio
      ?? ContextBudgetService.SUMMARIZATION_THRESHOLD_RATIO;
    return Math.floor(this.maxContextTokens * ratio);
  }

  /**
   * 根据模型名称更新上下文窗口大小
   * @param modelName 模型名称（如 'gpt-4o', 'claude-3-sonnet' 等）
   */
  updateModelContextSize(modelName: string | null): void {
    if (!modelName || modelName === 'auto') {
      this._maxContextTokens = ContextBudgetService.DEFAULT_CONTEXT_SIZE;
      return;
    }

    // P11: 同步切换编码器（根据模型选择 cl100k_base/o200k_base）
    this.tiktokenService.switchEncoderForModel(modelName);

    // 尝试精确匹配
    const lowerName = modelName.toLowerCase();
    for (const [key, size] of Object.entries(ContextBudgetService.MODEL_CONTEXT_SIZES)) {
      if (lowerName.includes(key)) {
        this._maxContextTokens = size;
        return;
      }
    }

    // 无匹配时使用默认值
    this._maxContextTokens = ContextBudgetService.DEFAULT_CONTEXT_SIZE;
  }

  /** 缓存的系统提示词 token 估算值 */
  private _cachedSystemTokens: number = 0;
  /** 缓存的工具定义 token 估算值 */
  private _cachedToolsTokens: number = 0;
  /** 缓存的瞬态上下文注入 token 估算值（<aily-context>: skills + memory + deferred tools listing） */
  private _cachedContextTokens: number = 0;
  /** 上一次工具数组长度（用于判断是否需要重新估算） */
  private _lastToolsCount: number = 0;

  /**
   * 更新系统提示词 token 估算（服务端提示词，客户端无法获取原文，需估算）
   *
   * 参考 Copilot Context Window 面板的 "System Instructions" 一栏。
   * 由于系统提示词在服务端，客户端通过配置估算。
   *
   * @param tokenCount 估算的系统提示词 token 数（可通过 estimateTokenCount(promptText) 计算）
   */
  updateSystemPromptTokens(tokenCount: number): void {
    this._cachedSystemTokens = tokenCount;
  }

  /**
   * 更新工具定义 token（前端 tiktoken 精确计算）
   * @param tools 当前工具数组
   */
  updateToolsTokens(tools: any[]): void {
    if (!tools || tools.length === 0) {
      this._cachedToolsTokens = 0;
      this._lastToolsCount = 0;
      return;
    }
    // 仅在工具数量变化时重新估算（避免每次都序列化大量 JSON）
    if (tools.length !== this._lastToolsCount) {
      this._cachedToolsTokens = estimateToolsTokens(tools);
      this._lastToolsCount = tools.length;
    }
  }

  /**
   * 更新瞬态上下文注入（<aily-context>）的 token 估算值
   *
   * 由 StreamProcessorHelper.buildContextMessage() 构建后调用，
   * 确保 budget 计量中包含 skills/memory/deferred tools listing 的占用。
   *
   * @param contextMessage buildContextMessage() 返回的消息对象（可为 null）
   */
  updateContextTokens(contextMessage: any | null): void {
    this._cachedContextTokens = contextMessage
      ? estimateMessageTokens(contextMessage)
      : 0;
  }

  /**
   * 更新上下文预算状态（每次 conversationMessages 变化时调用）
   *
   * 参考 Copilot 的 Context Window 面板，完整上下文 = System + Tools + Context + Messages
   *
   * @param messages 当前完整对话历史
   * @param tools 可选，当前工具数组（传入时会更新工具 token 缓存）
   */
  updateBudget(messages: any[], tools?: any[]): void {
    // 如果传入了 tools，更新缓存
    if (tools) {
      this.updateToolsTokens(tools);
    }

    const messagesTokens = estimateMessagesTokens(messages);
    this._emitSnapshot(messagesTokens, messages.length, tools);
  }

  /**
   * 异步更新上下文预算（Method C 优化）
   * 长文本 token 计数卸载到 Worker，避免阻塞 UI 主线程。
   * 用于工具调用循环等热路径。
   */
  async updateBudgetAsync(messages: any[], tools?: any[]): Promise<void> {
    if (tools) {
      this.updateToolsTokens(tools);
    }

    const messagesTokens = await estimateMessagesTokensAsync(messages);
    this._emitSnapshot(messagesTokens, messages.length, tools);
  }

  /** 内部：根据已计算的 messagesTokens 发布 snapshot */
  private _emitSnapshot(messagesTokens: number, messageCount: number, _tools?: any[]): void {
    const systemTokens = this._cachedSystemTokens;
    const toolsTokens = this._cachedToolsTokens;
    const contextTokens = this._cachedContextTokens;
    const currentTokens = systemTokens + toolsTokens + contextTokens + messagesTokens;
    const max = this.maxContextTokens;

    const snapshot: ContextBudgetSnapshot = {
      currentTokens,
      maxContextTokens: max,
      compressionThreshold: this.compressionThreshold,
      summarizationThreshold: this.summarizationThreshold,
      usagePercent: Math.min(100, Math.round((currentTokens / max) * 100)),
      messageCount,
      updatedAt: Date.now(),
      systemTokens,
      toolsTokens,
      contextTokens,
      messagesTokens,
      systemPercent: max > 0 ? Math.round((systemTokens / max) * 1000) / 10 : 0,
      toolsPercent: max > 0 ? Math.round((toolsTokens / max) * 1000) / 10 : 0,
      contextPercent: max > 0 ? Math.round((contextTokens / max) * 1000) / 10 : 0,
      messagesPercent: max > 0 ? Math.round((messagesTokens / max) * 1000) / 10 : 0,
    };
    this.budgetSubject.next(snapshot);
  }

  /**
   * 在发送请求前检查并执行必要的压缩
   *
   * 策略分层（参考 Copilot fallback 链）：
   * 0. 先检查后台摘要：如已完成 → 直接应用；如 ≥95% 且正在进行 → 阻塞等待
   * 1. currentTokens < compressionThreshold → 不压缩，保留全量
   * 2. compressionThreshold ≤ currentTokens < summarizationThreshold → 压缩旧的工具结果
   * 3. currentTokens ≥ summarizationThreshold → 调用 LLM 生成摘要替换旧历史
   *
   * @param messages 当前完整对话历史（会被原地修改）
   * @param sessionId 会话ID（LLM 摘要需要）
   * @returns 处理后的消息数组（可能是新数组）
   */
  async compressIfNeeded(
    messages: any[],
    sessionId: string,
    turnManager: TurnManager,
    llmConfig?: any,
    selectModel?: string,
    turnSpans?: readonly TurnSpan[],
    /** 预计算的 messages token 数（来自 updateBudgetAsync），避免重复同步计算 */
    precomputedTokens?: number
  ): Promise<any[]> {
    const currentTokens = precomputedTokens ?? estimateMessagesTokens(messages);
    const maxTokens = this.maxContextTokens;

    // ==================== 层级 0: 后台摘要化结果应用 ====================
    // 参考 Copilot: 75%/95% 双阈值后台摘要
    const bg = this.backgroundSummarizer;

    // 如果后台摘要已完成，直接应用
    if (bg.state === BackgroundSummarizationState.Completed) {
      const result = bg.consumeResult();
      if (result) {
        const { messages: applied, success } = bg.applySummary(turnManager, result);
        const afterTokens = estimateMessagesTokens(applied);
        console.log(`[上下文压缩] 应用后台摘要: ${currentTokens} → ${afterTokens} tokens${success ? '' : '（写回失败，摘要未生效）'}`);

        if (success) {
          this.compressionEventSubject.next({
            type: 'llm_summarization',
            beforeTokens: currentTokens,
            afterTokens,
            compressedMessages: messages.length - applied.length,
            timestamp: Date.now()
          });

          this._emitSnapshot(afterTokens, applied.length);
          return applied;
        }
        // 写回失败时继续走后续压缩层级
      }
    }

    // 如果 ≥ 95% 且后台摘要正在进行，阻塞等待
    if (bg.shouldBlockAndWait(currentTokens, maxTokens)) {
      console.log(`[上下文压缩] token ${(currentTokens / maxTokens * 100).toFixed(1)}% ≥ 95%，阻塞等待后台摘要...`);
      const result = await bg.waitForCompletion();
      if (result) {
        bg.consumeResult(); // 消费掉状态
        const { messages: applied, success } = bg.applySummary(turnManager, result);
        const afterTokens = estimateMessagesTokens(applied);
        console.log(`[上下文压缩] 后台摘要等待完成: ${currentTokens} → ${afterTokens} tokens${success ? '' : '（写回失败，摘要未生效）'}`);

        if (success) {
          this.compressionEventSubject.next({
            type: 'llm_summarization',
            beforeTokens: currentTokens,
            afterTokens,
            compressedMessages: messages.length - applied.length,
            timestamp: Date.now()
          });

          this._emitSnapshot(afterTokens, applied.length);
          return applied;
        }
        // 写回失败时继续走后续压缩层级
      }
    }

    // ==================== 层级 1: 无需压缩 ====================
    if (currentTokens < this.compressionThreshold) {
      return messages;
    }

    // ==================== 层级 2: 优先级裁剪（Copilot PrioritizedList 策略） ====================
    // 参考 Copilot prompt-tsx: 所有裁剪在前端完成，服务端只做安全兜底
    // Turn-aware: 以 Turn 为最小移除单元，保证 tool_call ↔ tool_result 配对完整性
    const trimmed = this.prioritizedTrim(messages, turnSpans);
    const trimmedTokens = estimateMessagesTokens(trimmed);

    if (trimmedTokens < this.summarizationThreshold) {
      console.log(`[上下文压缩] 优先级裁剪: ${currentTokens} → ${trimmedTokens} tokens (节省 ${currentTokens - trimmedTokens})`);
      this.compressionEventSubject.next({
        type: 'tool_compression',
        beforeTokens: currentTokens,
        afterTokens: trimmedTokens,
        compressedMessages: messages.length - trimmed.length,
        timestamp: Date.now()
      });
      this._emitSnapshot(trimmedTokens, trimmed.length);
      return trimmed;
    }

    // ==================== 层级 3: 前台 LLM 摘要 ====================
    // 若后台摘要正在进行，不发起重复的前台调用（防止并行竞态），
    // 回退到优先级裁剪先缓解，下次请求时后台摘要应已完成
    if (bg.state === BackgroundSummarizationState.InProgress) {
      console.log(`[上下文压缩] 后台摘要正在进行，跳过前台 LLM 调用，使用优先级裁剪`);
      this._emitSnapshot(trimmedTokens, trimmed.length);
      return trimmed;
    }

    console.log(`[上下文压缩] Token 数 (${trimmedTokens}) 超过摘要阈值 (${this.summarizationThreshold})，触发前台 LLM 摘要`);

    try {
      const summarized = await this.backgroundSummarizer.foregroundSummarize(
        messages,
        turnManager,
        sessionId,
        llmConfig,
        selectModel
      );
      const afterTokens = estimateMessagesTokens(summarized);
      console.log(`[上下文压缩] LLM 摘要: ${trimmedTokens} → ${afterTokens} tokens (节省 ${trimmedTokens - afterTokens})`);

      this.compressionEventSubject.next({
        type: 'llm_summarization',
        beforeTokens: currentTokens,
        afterTokens,
        compressedMessages: messages.length - summarized.length,
        timestamp: Date.now()
      });

      this._emitSnapshot(afterTokens, summarized.length);
      return summarized;
    } catch (error) {
      // 层级 4: 最终兜底 — foregroundSummarize 内部已实现 Full→Simple 降级链,
      // 到达此处说明连 Simple mode 也失败了（极端情况），回退到优先级裁剪
      console.warn('[上下文压缩] 摘要服务完全失败（含 Simple mode），回退到优先级裁剪:', error);
      this._emitSnapshot(trimmedTokens, trimmed.length);
      return trimmed;
    }
  }

  // ==================== Copilot 风格 Turn-aware 优先级裁剪 ====================

  /**
   * Turn-aware 优先级裁剪 — 参考 Copilot 的 PrioritizedList 策略
   *
   * 核心原则（Copilot 对齐）：
   *   1. Turn 是最小移除单元，绝不拆散（保证 tool_call ↔ tool_result 配对完整）
   *   2. 从最旧 Turn 开始移除，越旧价值越低
   *   3. 最新 Turn（含用户最新消息）永远保留（Priority 900）
   *
   * 策略分两步：
   *   Step 1: 对所有 Turn 的消息做内容级压缩（截断工具结果/arguments、移除 UI 标签）
   *   Step 2: 如果仍超预算，从最旧 Turn 开始整体移除
   *
   * @param messages 完整对话历史（来自 TurnManager.buildMessages()）
   * @param turnSpans Turn 边界跨度（来自 TurnManager.turnSpans）。
   *                  若未提供，回退到消息级裁剪（兼容旧调用路径）
   * @returns 裁剪后的消息数组
   */
  prioritizedTrim(messages: any[], turnSpans?: readonly TurnSpan[]): any[] {
    // 无 Turn 边界信息时回退到消息级裁剪（兼容旧代码路径）
    if (!turnSpans || turnSpans.length === 0) {
      return this.prioritizedTrimLegacy(messages);
    }

    if (turnSpans.length <= 1) {
      // 只有一个 Turn，无法再移除，仅做内容压缩
      return this.compressToolResults(messages);
    }

    // Step 1: 内容级压缩（对所有消息，不移除任何消息）
    // 最新 Turn（turnSpans 末尾）的消息不做截断，保留完整内容供 LLM 推理
    const latestSpan = turnSpans[turnSpans.length - 1];
    const latestTurnMsgIndices = new Set<number>();
    for (let j = latestSpan.startIdx; j < latestSpan.endIdx; j++) {
      latestTurnMsgIndices.add(j);
    }

    // P7: 构建 msgIndex → turnAge 映射（Turn 年龄：0 = 最新 Turn, 1 = 上一 Turn, ...）
    const msgTurnAgeMap = new Map<number, number>();
    const maxTurnIdx = turnSpans.length - 1;
    for (const span of turnSpans) {
      const age = maxTurnIdx - turnSpans.indexOf(span);
      for (let j = span.startIdx; j < span.endIdx; j++) {
        msgTurnAgeMap.set(j, age);
      }
    }

    const compressed = this.compressToolResults(messages, -1, latestTurnMsgIndices, msgTurnAgeMap);

    // Step 2: 声明式优先级裁剪 — 使用 PrioritizedListEngine
    // 标注每个 Turn 的优先级（参考 Copilot prompt-tsx 的 priority 机制）
    const items = annotateWithPriority(compressed, turnSpans, ContextBudgetService.INFO_TOOLS);
    const engine = new PrioritizedListEngine(this.getAvailableMessageBudget());
    const result = engine.trim(items);

    if (result.evictedCount > 0) {
      console.log(
        `[声明式裁剪] 淘汰 ${result.evictedCount} 个 Turn (${result.evictedTokens} tokens), ` +
        `保留 ${items.length - result.evictedCount} 个 Turn = ${result.messages.length} 条消息`
      );
    }

    return result.messages;
  }

  /**
   * 消息级优先级裁剪（Legacy 兜底）
   *
   * 当无 Turn 边界信息时使用（如旧代码路径、从 conversationMessages 直接调用）。
   * 按消息类型分级，使用 PrioritizedListEngine 自动淘汰。
   */
  private prioritizedTrimLegacy(messages: any[]): any[] {
    if (messages.length <= ContextBudgetService.RECENT_MESSAGES_PRESERVE) {
      return messages;
    }

    // 内容级压缩
    const compressed = this.compressToolResults(messages);

    // 声明式优先级标注
    const items = annotateMessagesLegacy(
      compressed,
      ContextBudgetService.RECENT_MESSAGES_PRESERVE,
      ContextBudgetService.INFO_TOOLS
    );
    const engine = new PrioritizedListEngine(this.getAvailableMessageBudget());
    const result = engine.trim(items);

    if (result.evictedCount > 0) {
      console.log(
        `[声明式裁剪-Legacy] 淘汰 ${result.evictedCount} 条消息 (${result.evictedTokens} tokens), ` +
        `保留 ${result.messages.length} 条消息`
      );
    }

    return result.messages;
  }

  /**
   * 计算对话消息可用的 token 预算
   * = maxContextTokens - system - tools - context - outputReserve
   */
  getAvailableMessageBudget(): number {
    const maxTokens = this.maxContextTokens;
    const outputReserve = Math.floor(maxTokens * ContextBudgetService.OUTPUT_RESERVE_RATIO);
    return maxTokens - this._cachedSystemTokens - this._cachedToolsTokens - this._cachedContextTokens - outputReserve;
  }

  // ==================== 内容级压缩 ====================

  /**
   * 计算工具结果的动态截断上限（token 数）
   * 参考 Copilot: maxToolResultLength = floor(modelMaxPromptTokens × MAX_TOOL_RESPONSE_PCT)
   *
   * @param isInfoTool 是否为信息类工具（read_file/fetch/grep 等）
   * @param turnAge Turn 年龄（0 = 当前 Turn, 1 = 上一 Turn, 2+ = 更旧）。
   *                默认 0 表示不做年龄衰减（兼容旧调用路径）
   * @returns token 数上限
   */
  getToolResultTokenLimit(isInfoTool: boolean, turnAge: number = 0): number {
    const maxToolTokens = Math.floor(this.maxContextTokens * ContextBudgetService.MAX_TOOL_RESPONSE_PCT);
    const baseLimit = Math.floor(maxToolTokens * (isInfoTool
      ? ContextBudgetService.INFO_TOOL_BUDGET_RATIO
      : ContextBudgetService.ACTION_TOOL_BUDGET_RATIO));

    // P7: Turn 年龄衰减 — 越旧的 Turn 工具结果截断越激进
    const tier = ContextBudgetService.TURN_AGE_TRUNCATION_TIERS.find(t => turnAge <= t.maxAge)
      ?? ContextBudgetService.TURN_AGE_TRUNCATION_TIERS[ContextBudgetService.TURN_AGE_TRUNCATION_TIERS.length - 1];
    return Math.floor(baseLimit * tier.ratio);
  }

  /**
   * 压缩消息内容（不丢弃消息，只截断内容）
   *
   * 策略：
   * - 用户最新消息永远不压缩（protectedUserIdx 指定）
   * - 最新 Turn 的消息不做截断（protectedMsgIndices 指定），保留完整内容供 LLM 推理
   * - 对 tool 消息，清理冗余标签后按 token 级动态截断 content
   * - 对 assistant 消息，清理 UI 标签，截断大 arguments
   * - user / system 消息保持原样
   *
   * @param messages 要压缩的消息数组
   * @param protectedUserIdx 永远不压缩的用户消息索引（-1 表示全部可压缩）
   * @param protectedMsgIndices 最新 Turn 中不做截断的消息索引集合
   * @param msgTurnAgeMap 消息索引 → Turn 年龄 的映射（用于 P7 分层截断；缺省时所有消息 age=0）
   */
  compressToolResults(messages: any[], protectedUserIdx: number = -1, protectedMsgIndices?: Set<number>, msgTurnAgeMap?: Map<number, number>): any[] {
    const result: any[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // 用户最新消息（P900）永远不压缩
      if (i === protectedUserIdx) {
        result.push(msg);
        continue;
      }

      // 最新 Turn 的消息不做截断（保留完整内容供 LLM 推理当前轮次）
      if (protectedMsgIndices && protectedMsgIndices.has(i)) {
        result.push(msg);
        continue;
      }

      // user / system 消息：保持原样
      if (msg.role === 'user' || msg.role === 'system') {
        result.push(msg);
        continue;
      }

      // 压缩 tool 消息：先清理冗余标签，再按工具类型分级截断
      if (msg.role === 'tool') {
        let cleaned = (msg.content || '')
          .replace(/<rules>[\s\S]*?<\/rules>/g, '')
          .replace(/<info>[\s\S]*?<\/info>/g, '')
          .replace(/<toolResult>([\s\S]*?)<\/toolResult>/g, '$1')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        // 按 token 级动态计算截断上限（参考 Copilot: maxToolResultLength = modelMaxPromptTokens × 50%）
        // P7: 根据 Turn 年龄分层衰减截断上限
        const toolName = msg.name || '';
        const isInfoTool = ContextBudgetService.INFO_TOOLS.has(toolName);
        const turnAge = msgTurnAgeMap?.get(i) ?? 0;
        const tokenLimit = this.getToolResultTokenLimit(isInfoTool, turnAge);
        const truncatedContent = this.truncateByTokens(cleaned, tokenLimit);
        result.push({
          ...msg,
          content: truncatedContent
        });
        continue;
      }

      // 压缩 assistant 消息
      if (msg.role === 'assistant') {
        // 清理 UI-only 元素（think/aily-state 等仅用于前端展示）
        let cleanedContent = (msg.content || '')
          .replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/```aily-state[\s\S]*?```/g, '')
          // .replace(/```aily-button\n?([\s\S]*?)\n?```/g, (_match: string, json: string) => {
          //   // 保留选项上下文，转为纯文本（同 sanitizeAssistantContent 逻辑）
          //   try {
          //     const buttons = JSON.parse(json.trim());
          //     if (Array.isArray(buttons) && buttons.length > 0) {
          //       const labels = buttons.map((b: any) => b.text || b.label || '').filter(Boolean);
          //       if (labels.length > 0) return `\n[aily-button选项转换后: ${labels.join(' | ')}]\n`;
          //     }
          //   } catch { /* ignore */ }
          //   return '';
          // })
          .replace(/```aily-mermaid[\s\S]*?```/g, '')
          .replace(/\[thinking\.\.\.?\]/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        const compressedMsg: any = { ...msg, content: cleanedContent };

        if (msg.tool_calls) {
          // 收集本消息之后存在对应 tool result 的 tool_call_ids
          const existingToolResultIds = new Set<string>();
          for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
            if (messages[j].tool_call_id) existingToolResultIds.add(messages[j].tool_call_id);
          }

          // 过滤孤立 tool_calls（无对应 result），并截断 arguments
          // 参考 Copilot: isHistorical 时只保留有对应结果的 tool_calls
          // 工具参数截断：使用操作类工具的 token 限额（考虑 Turn 年龄衰减）
          const assistantTurnAge = msgTurnAgeMap?.get(i) ?? 0;
          const argsTokenLimit = this.getToolResultTokenLimit(false, assistantTurnAge);
          compressedMsg.tool_calls = msg.tool_calls
            .filter((tc: any) => tc.id && existingToolResultIds.has(tc.id))
            .map((tc: any) => {
              const args = tc.function?.arguments;
              if (args && estimateTokenCount(args) > argsTokenLimit) {
                return {
                  ...tc,
                  function: {
                    ...tc.function,
                    arguments: this.truncateByTokens(args, argsTokenLimit)
                  }
                };
              }
              return tc;
            });

          // 如果过滤后没有 tool_calls 了，移除该字段
          if (compressedMsg.tool_calls.length === 0) {
            delete compressedMsg.tool_calls;
          }
        }

        result.push(compressedMsg);
        continue;
      }

      // user / system / 其他消息保持原样
      result.push(msg);
    }

    return result;
  }

  // ==================== 工具方法 ====================

  /**
   * 按 token 数截断文本，采用 Copilot 风格的 40/60 头尾分割策略。
   *
   * 参考 Copilot 的 onText() 实现：
   *   1. 先用 tokenizer 计算实际 token 数
   *   2. 算出 approxCharsPerToken = text.length / tokens
   *   3. 按比例转换为字符级截断点
   *   4. 保留头部 40% 和尾部 60%（错误信息和关键结果通常在输出末尾）
   *
   * @param text 要截断的文本
   * @param maxTokens 最大 token 数
   * @returns 截断后的文本
   */
  private truncateByTokens(text: string, maxTokens: number): string {
    if (!text) return text;
    const currentTokens = estimateTokenCount(text);
    if (currentTokens <= maxTokens) return text;

    const marker = '\n[Tool response was too long and was truncated.]\n';
    const markerTokens = estimateTokenCount(marker);
    const availableTokens = maxTokens - markerTokens;
    if (availableTokens <= 0) return text.substring(0, 100);

    // 按 Copilot 方式：用 chars/token 比例换算字符级截断点
    const approxCharsPerToken = text.length / currentTokens;
    const targetChars = Math.round(approxCharsPerToken * availableTokens);

    const headSize = Math.round(targetChars * 0.4);
    const tailSize = targetChars - headSize;
    return text.substring(0, headSize) + marker + text.substring(text.length - tailSize);
  }

  /**
   * 按字符数截断文本（Legacy 兜底，用于非工具结果的通用截断）
   */
  private truncateText(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) return text;
    const marker = '\n...[内容已截断]...\n';
    const available = maxLength - marker.length;
    if (available <= 0) return text.substring(0, maxLength);
    const headSize = Math.floor(available * 0.4);
    const tailSize = available - headSize;
    return text.substring(0, headSize) + marker + text.substring(text.length - tailSize);
  }

  /**
   * 创建空的预算快照
   */
  private createEmptySnapshot(): ContextBudgetSnapshot {
    return {
      currentTokens: 0,
      maxContextTokens: this.maxContextTokens,
      compressionThreshold: this.compressionThreshold,
      summarizationThreshold: this.summarizationThreshold,
      usagePercent: 0,
      messageCount: 0,
      updatedAt: Date.now(),
      systemTokens: 0,
      toolsTokens: 0,
      contextTokens: 0,
      messagesTokens: 0,
      systemPercent: 0,
      toolsPercent: 0,
      contextPercent: 0,
      messagesPercent: 0,
    };
  }

  /**
   * 重置状态（新会话时调用）
   */
  reset(): void {
    // 切换模型/新会话时，系统提示词 token 数可能不同，需重置为默认估算
    this._cachedSystemTokens = ContextBudgetService.ESTIMATED_SYSTEM_PROMPT_TOKENS;
    this._cachedToolsTokens = 0;
    this._cachedContextTokens = 0;
    this._lastToolsCount = 0;
    this.budgetSubject.next(this.createEmptySnapshot());
    this.compressionEventSubject.next(null);
    // 重置后台摘要服务
    this.backgroundSummarizer.reset();
  }
}
