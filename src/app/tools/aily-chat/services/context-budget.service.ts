import { Injectable } from '@angular/core';
import { AilyChatConfigService } from './aily-chat-config.service';
import { ContextBudgetViewService } from './context-budget-view.service';
import { TiktokenService } from './tiktoken.service';
import { AilyHost } from '../core/host';
import {
  setContextBudgetTiktokenService,
} from './context-budget-estimation';
import {
  createContextBudgetSnapshot,
  createEmptyContextBudgetSnapshot,
} from './context-budget-snapshot';
import type { ContextBudgetSnapshot } from './context-budget-snapshot';
import { ContextBudgetLocalEstimator } from './context-budget-local-estimator';
import { createLexContextBudgetSnapshot, LexContextBudgetSnapshotExtra } from './context-budget-lex-event';

// ==================== 主服务 ====================

/**
 * 上下文预算展示/辅助服务
 *
 * 当前职责：
 * 1. 维护模型上下文窗口与阈值配置
 * 2. 通过 helper 生成本地展示估算与 lex 预算事件快照
 * 3. 为 UI/元数据提供预算快照，不再执行 blockly 侧压缩/摘要策略
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
   * 服务端系统提示词的预估 token 数
   *
   * 服务端系统提示词在客户端不可见，
   * 通过人工预估给出合理值。后续可由服务端 API 返回精确值。
   * 当前 系统提示词约 10000+ 中文字符 → ~4500 tokens
   */
  private static readonly ESTIMATED_SYSTEM_PROMPT_TOKENS = 3000;

  // ==================== 状态 ====================

  /** 当前模型上下文窗口大小 */
  private _maxContextTokens: number = ContextBudgetService.DEFAULT_CONTEXT_SIZE;

  /** 自定义上下文窗口大小覆盖（用户在设置中指定时使用） */
  private _customMaxContextTokens: number | null = null;
  private readonly localEstimator = new ContextBudgetLocalEstimator(
    ContextBudgetService.ESTIMATED_SYSTEM_PROMPT_TOKENS,
  );

  constructor(
    private ailyChatConfigService: AilyChatConfigService,
    private tiktokenService: TiktokenService,
    private contextBudgetViewService: ContextBudgetViewService,
  ) {
    // 注入 TiktokenService 供模块级函数使用
    setContextBudgetTiktokenService(this.tiktokenService);
    this.localEstimator.reset();
    this.contextBudgetViewService.reset(this.buildEmptySnapshot());
  }

  // ==================== 公共接口 ====================

  /**
   * 获取当前上下文预算快照
   */
  getSnapshot(): ContextBudgetSnapshot {
    return this.contextBudgetViewService.getSnapshot();
  }

  get budget$() {
    return this.contextBudgetViewService.budget$;
  }

  /**
   * 获取当前 LLM 上下文窗口总 token 数
   * 优先级：用户配置 > 代码设置 > 模型自动检测值
   */
  get maxContextTokens(): number {
    const configSize = this.ailyChatConfigService?.contextWindowSize;
    if (configSize && configSize > 0) return configSize;

    if (this._customMaxContextTokens && this._customMaxContextTokens > 0) {
      return this._customMaxContextTokens;
    }

    const activeModelContextTokens = this.resolveActiveModelContextWindowTokens();
    if (activeModelContextTokens && activeModelContextTokens > 0) {
      return activeModelContextTokens;
    }

    return this._maxContextTokens;
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
  updateModelContextSize(model: string | { model?: string | null; contextWindowTokens?: number; presetId?: string | null } | null): void {
    const resolvedContextTokens = typeof model === 'object' && model
      ? this.ailyChatConfigService.resolveModelContextWindowTokens(model)
      : undefined;
    const modelName = typeof model === 'string' ? model : model?.model ?? null;

    if (resolvedContextTokens && resolvedContextTokens > 0) {
      this._maxContextTokens = resolvedContextTokens;
      if (modelName) {
        this.tiktokenService.switchEncoderForModel(modelName);
      }
      this.syncSnapshotLimits();
      return;
    }

    if (!modelName || modelName === 'auto') {
      this._maxContextTokens = ContextBudgetService.DEFAULT_CONTEXT_SIZE;
      this.syncSnapshotLimits();
      return;
    }

    // P11: 同步切换编码器（根据模型选择 cl100k_base/o200k_base）
    this.tiktokenService.switchEncoderForModel(modelName);

    // 尝试精确匹配
    const lowerName = modelName.toLowerCase();
    for (const [key, size] of Object.entries(ContextBudgetService.MODEL_CONTEXT_SIZES)) {
      if (lowerName.includes(key.toLowerCase())) {
        this._maxContextTokens = size;
        this.syncSnapshotLimits();
        return;
      }
    }

    // 无匹配时使用默认值
    this._maxContextTokens = ContextBudgetService.DEFAULT_CONTEXT_SIZE;
    this.syncSnapshotLimits();
  }

  /**
  * 刷新本地预算快照估算（仅用于展示/持久化元数据）
   *
   * 参考 Copilot 的 Context Window 面板，当前展示语义对齐为：
   * System = System Instructions + Tool Definitions
    * User Context = Files + Messages + Tool Results
  * 这不是运行时压缩入口；真实预算决策由 lex ContextManager 负责。
   *
   * @param messages 当前完整对话历史
   * @param tools 可选，当前工具数组（传入时会更新工具 token 缓存）
   */
  refreshLocalEstimate(messages: any[], tools?: any[]): void {
    if (!Array.isArray(messages) || messages.length === 0) {
      this.localEstimator.reset();
      this.contextBudgetViewService.reset(this.buildEmptySnapshot());
      return;
    }

    this.contextBudgetViewService.applySnapshot(this.localEstimator.createSnapshot({
      messages,
      tools,
      maxContextTokens: this.maxContextTokens,
      compressionThreshold: this.compressionThreshold,
      summarizationThreshold: this.summarizationThreshold,
    }));
  }

  /**
   * 应用 lex context_budget 事件生成的预算快照
   *
   * lex 的 ContextManager 已完成 token 计算和压缩，
   * 此方法直接映射 lex 事件到 blockly ContextBudgetSnapshot 供 UI 消费。
   */
  applyLexBudgetEvent(
    maxTokens: number,
    usedTokens: number,
    extra?: LexContextBudgetSnapshotExtra,
  ): void {
    if (typeof maxTokens === 'number' && maxTokens > 0) {
      this._maxContextTokens = maxTokens;
    }

    this.contextBudgetViewService.applySnapshot(createLexContextBudgetSnapshot({
      maxTokens,
      usedTokens,
      fallbackCompressionThreshold: this.compressionThreshold,
      fallbackSummarizationThreshold: this.summarizationThreshold,
      extra,
    }));
  }

  private buildEmptySnapshot(): ContextBudgetSnapshot {
    return createEmptyContextBudgetSnapshot({
      maxContextTokens: this.maxContextTokens,
      compressionThreshold: this.compressionThreshold,
      summarizationThreshold: this.summarizationThreshold,
    });
  }

  /**
   * 重置状态（新会话时调用）
   */
  reset(): void {
    this.localEstimator.reset();
    this.contextBudgetViewService.reset(this.buildEmptySnapshot());
  }

  private resolveActiveModelContextWindowTokens(): number | undefined {
    const savedModel = AilyHost.get().config.data?.aiChatModel;
    const resolvedModel = this.ailyChatConfigService.resolveSavedModel(savedModel);
    return this.ailyChatConfigService.resolveModelContextWindowTokens(resolvedModel ?? savedModel);
  }

  private syncSnapshotLimits(): void {
    const snapshot = this.contextBudgetViewService.getSnapshot();
    this.contextBudgetViewService.applySnapshot(createContextBudgetSnapshot({
      maxContextTokens: this.maxContextTokens,
      compressionThreshold: this.compressionThreshold,
      summarizationThreshold: this.summarizationThreshold,
      messageCount: snapshot.messageCount,
      systemTokens: snapshot.systemTokens,
      baseSystemTokens: snapshot.baseSystemTokens,
      instructionTokens: snapshot.instructionTokens,
      skillTokens: snapshot.skillTokens,
      toolsTokens: snapshot.toolsTokens,
      toolSourceTokens: snapshot.toolSourceTokens,
      contextTokens: snapshot.contextTokens,
      messagesTokens: snapshot.messagesTokens,
      toolResultsTokens: snapshot.toolResultsTokens,
      currentTokens: snapshot.currentTokens,
    }));
  }
}
