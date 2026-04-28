import { Injectable } from '@angular/core';

/**
 * 工具调用历史记录
 */
interface ToolCallRecord {
  toolCallId: string;
  name: string;
  argsHash: string;
  retryFamilyHash: string;
  timestamp: number;
  resultCategory?: ToolResultCategory;
  resultSignature?: string;
  resultStructuredSignature?: string;
  resultStructuredItems?: string[];
  isError?: boolean;
  isWarning?: boolean;
}

type ToolResultCategory =
  | 'success_payload'
  | 'success_empty'
  | 'error_rate_limit'
  | 'error_auth'
  | 'error_timeout'
  | 'error_not_found'
  | 'error_permission'
  | 'error_parse'
  | 'error_invalid_args'
  | 'error_unknown';

/**
 * 重复检测结果
 */
export interface RepetitionCheckResult {
  isRepetitive: boolean;
  pattern?: string;
  suggestion?: string;
  /** think 状态转换信息（供调用方同步 UI 状态） */
  thinkTransition?: 'entered' | 'exited';
  /** 非阻塞式大小警告（不中断流，由调用方在流中注入提示） */
  sizeWarning?: string;
}

/**
 * 重复检测配置（KMP）
 */
interface RepetitionConfig {
  maxTokenSequenceLength: number;
  lastTokensToConsider: number;
}

interface StreamChunkProcessResult {
  sawThinkContent: boolean;
  sawNonThinkContent: boolean;
  thinkClosedInChunk: boolean;
}

interface NarrativeDetectionProfile {
  phraseMinTextLength: number;
  sentenceMinTextLength: number;
  sentenceRepeatThreshold: number;
  paragraphMinTextLength: number;
  paragraphMinSentenceCount: number;
  paragraphRepeatThreshold: number;
  lineShortThreshold: number;
  lineMediumThreshold: number;
  lineLongThreshold: number;
  blockRepeatThreshold: number;
  blockSimilarityThreshold: number;
}

interface CodeBlockDetectionProfile {
  completedBlockMinLength: number;
  completedBlockRepeatThreshold: number;
  completedBlockSimilarityThreshold: number;
  activeLineMinLength: number;
  activeLineRepeatThreshold: number;
  activeChunkMaxSize: number;
  activeChunkRepeatThreshold: number;
  activeChunkMinCombinedLength: number;
}

/**
 * 流式文本重复检测配置
 * 基于 KMP 算法检测各种长度的重复模式
 */
const STREAM_REPETITION_CONFIGS: RepetitionConfig[] = [
  { maxTokenSequenceLength: 1, lastTokensToConsider: 10 },
  { maxTokenSequenceLength: 10, lastTokensToConsider: 30 },
  { maxTokenSequenceLength: 20, lastTokensToConsider: 45 },
  { maxTokenSequenceLength: 30, lastTokensToConsider: 60 },
  { maxTokenSequenceLength: 60, lastTokensToConsider: 120 },
];

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';

/**
 * 重复检测服务
 *
 * 设计原则：
 * 1. 只检测「连续重复」和「循环模式」，不检测「某内容在全文出现了几次」
 * 2. 不使用白名单 —— 严格的连续性判断本身就是最好的过滤器
 * 3. 文本检测基于「语义单元」（句子/段落）而非固定长度滑窗
 *
 * 检测层级：
 * - Layer 1: Token 级连续重复（"哈哈哈哈"、token 卡顿）
 * - Layer 2: 句子级连续重复（相同句子连续出现 ≥3 次）
 * - Layer 3: 内容块跨边界重复（<think>/tool_call 前后输出相同内容块 ≥3 次）
 * - Layer 4: KMP token 循环模式（ABABAB 级 token 循环）
 * - Layer 5: 连续行重复（相同行连续出现多次）
 */
@Injectable({
  providedIn: 'root'
})
export class RepetitionDetectionService {

  // ==================== 工具调用检测 ====================

  /** 工具调用历史记录 */
  private toolCallHistory: ToolCallRecord[] = [];

  /** 工具调用历史保留时间（毫秒） */
  private readonly TOOL_HISTORY_TTL = 120000; // 2 分钟

  /** 完全相同调用（同名+同参数）的阈值 */
  private readonly SAME_TOOL_THRESHOLD = 3;

  /** 同工具近似参数重试的阈值 */
  private readonly SAME_TOOL_FAMILY_THRESHOLD = 4;

  /** 循环模式检测的历史长度 */
  private readonly CYCLE_PATTERN_LENGTH = 8;

  /** 宽松循环检测允许的每轮额外噪声步骤数 */
  private readonly CYCLE_PATTERN_NOISE_TOLERANCE = 1;

  /** 结果加权检测的最低风险分 */
  private readonly TOOL_RESULT_RISK_THRESHOLD = 4;

  /** 结果驱动检测的最近窗口大小 */
  private readonly TOOL_RESULT_WINDOW_SIZE = 10;

  /** 跨工具同质结果的连续阈值 */
  private readonly CROSS_TOOL_RESULT_REPEAT_THRESHOLD = 3;

  /** 跨工具原始文本签名的最小长度，避免短成功消息误报 */
  private readonly CROSS_TOOL_RESULT_MIN_SIGNATURE_LENGTH = 60;

  // ==================== 流式文本检测 ====================

  /** 累积的流式 token */
  private streamTokens: string[] = [];

  /** 最大保留的 token 数量 */
  private readonly MAX_STREAM_TOKENS = 500;

  /** 检测间隔（每 N 个 token 检测一次） */
  private readonly CHECK_INTERVAL = 5;

  /** 最小检测 token 数量 */
  private readonly MIN_TOKENS_FOR_DETECTION = 15;

  /** 正文文本的重复检测阈值 */
  private readonly PROSE_DETECTION_PROFILE: NarrativeDetectionProfile = {
    phraseMinTextLength: 30,
    sentenceMinTextLength: 50,
    sentenceRepeatThreshold: 3,
    paragraphMinTextLength: 150,
    paragraphMinSentenceCount: 6,
    paragraphRepeatThreshold: 3,
    lineShortThreshold: 6,
    lineMediumThreshold: 4,
    lineLongThreshold: 3,
    blockRepeatThreshold: 3,
    blockSimilarityThreshold: 0.85,
  };

  /** think 文本单独用更保守的阈值，减少自我规划式重复误报 */
  private readonly THINK_DETECTION_PROFILE: NarrativeDetectionProfile = {
    phraseMinTextLength: 36,
    sentenceMinTextLength: 60,
    sentenceRepeatThreshold: 3,
    paragraphMinTextLength: 180,
    paragraphMinSentenceCount: 6,
    paragraphRepeatThreshold: 3,
    lineShortThreshold: 7,
    lineMediumThreshold: 5,
    lineLongThreshold: 4,
    blockRepeatThreshold: 4,
    blockSimilarityThreshold: 0.9,
  };

  /** 代码块重复单独调优，允许比正文更快识别刷屏 */
  private readonly CODE_BLOCK_DETECTION_PROFILE: CodeBlockDetectionProfile = {
    completedBlockMinLength: 20,
    completedBlockRepeatThreshold: 3,
    completedBlockSimilarityThreshold: 0.92,
    activeLineMinLength: 6,
    activeLineRepeatThreshold: 5,
    activeChunkMaxSize: 4,
    activeChunkRepeatThreshold: 3,
    activeChunkMinCombinedLength: 20,
  };

  // ==================== 跨边界块级检测 ====================

  /**
   * 已完成的内容块列表
   * 每次 markBoundary() 时，上次边界到当前边界之间的增量文本会被存入此列表
   */
  private contentBlocks: string[] = [];

  /** 上次边界时 streamTokens 的长度，用于提取增量内容 */
  private lastBoundaryTokenIndex = 0;

  /** 块的最小长度（太短的块不参与检测，中文场景下一个句子可能只有 8-15 字符） */
  private readonly MIN_BLOCK_LENGTH = 10;

  // ==================== Think 状态跟踪 ====================

  /** 当前是否在 <think> 标签内部 */
  private insideThink = false;

  /** Think 内部独立的 token 缓冲区（不污染主缓冲区） */
  private thinkTokens: string[] = [];

  /** ★ 性能优化：缓存 thinkTokens.join('') */
  private _cachedThinkText: string | null = null;

  /** 获取 thinkTokens 的 join 结果（使用缓存） */
  private getThinkText(): string {
    if (this._cachedThinkText === null) {
      this._cachedThinkText = this.thinkTokens.join('');
    }
    return this._cachedThinkText;
  }

  /** ★ 性能优化：缓存 streamTokens.join('') */
  private _cachedStreamText: string | null = null;

  /** 获取 streamTokens 的 join 结果（使用缓存） */
  private getStreamText(): string {
    if (this._cachedStreamText === null) {
      this._cachedStreamText = this.streamTokens.join('');
    }
    return this._cachedStreamText;
  }

  /** Think 缓冲区最大长度 */
  private readonly MAX_THINK_TOKENS = 1500;

  /** Think 内检测间隔（每 N 个 token 检测一次） */
  private readonly THINK_CHECK_INTERVAL = 8;

  // ==================== Think 标签检测状态机 ====================

  /** 标签检测缓冲区（处理跨 token 的 <think>/<\/think> 标签拆分） */
  private tagBuffer = '';

  // ==================== 兜底：单次 SSE 输出总大小限制 ====================

  /** 单次 SSE 响应累积的总字节数 */
  private totalStreamBytes = 0;

  /** 大小软警告间隔（每 3MB 发出一次非阻塞警告） */
  private readonly SIZE_WARNING_INTERVAL_BYTES = 3 * 1024 * 1024;

  /** 单次 SSE 响应绝对上限（5MB），超过即强制中断 */
  private readonly MAX_SINGLE_RESPONSE_BYTES = 5 * 1024 * 1024;

  /** 下一次触发大小警告的字节阈值（每次警告后递增一个 interval） */
  private nextSizeWarningBytes = this.SIZE_WARNING_INTERVAL_BYTES;

  /** 非 Think 内容的 token 缓冲区（Layer 1/4/5 只在此缓冲区上检测，避免 think 内容污染） */
  private nonThinkStreamTokens: string[] = [];

  /**
   * ★ 性能优化：缓存 nonThinkStreamTokens.join('') 的结果。
   * 每次 checkStreamRepetition 最多需要 join 6+ 次，缓存后仅按需增量更新。
   * 在 token 追加时增量拼接，在 trim/reset 时置 null 重建。
   */
  private _cachedNonThinkText: string | null = null;

  /** ★ 性能优化：增量跟踪 ``` 出现次数，避免每次全文 regex 扫描 */
  private _fenceCount = 0;

  /** 获取 nonThinkStreamTokens 的 join 结果（使用缓存） */
  private getNonThinkText(): string {
    if (this._cachedNonThinkText === null) {
      this._cachedNonThinkText = this.nonThinkStreamTokens.join('');
    }
    return this._cachedNonThinkText;
  }

  /** 本次 checkStreamRepetition 调用中发生的 think 转换 */
  private lastThinkTransition: 'entered' | 'exited' | null = null;

  constructor() {}

  // ==================== Think 标签状态机 ====================

  /**
   * 处理单个流式 chunk，保留 think 标签前后的可见文本
   * 支持标签与正文出现在同一个 SSE chunk，以及标签被拆分到多个 chunk
   */
  private processStreamChunk(chunk: string): StreamChunkProcessResult {
    const result: StreamChunkProcessResult = {
      sawThinkContent: false,
      sawNonThinkContent: false,
      thinkClosedInChunk: false,
    };

    this.lastThinkTransition = null;

    const input = this.tagBuffer + chunk;
    this.tagBuffer = '';

    let cursor = 0;

    while (cursor < input.length) {
      const nextTag = this.insideThink ? THINK_CLOSE_TAG : THINK_OPEN_TAG;
      const tagIndex = input.indexOf(nextTag, cursor);

      if (tagIndex < 0) {
        break;
      }

      const textBeforeTag = input.slice(cursor, tagIndex);
      if (textBeforeTag) {
        this.appendVisibleSegment(textBeforeTag, this.insideThink);
        if (this.insideThink) {
          result.sawThinkContent = true;
        } else {
          result.sawNonThinkContent = true;
        }
      }

      if (this.insideThink) {
        this.insideThink = false;
        this.markBoundary('think_end');
        this.lastThinkTransition = 'exited';
        result.thinkClosedInChunk = true;
      } else {
        this.markBoundary('think_start');
        this.insideThink = true;
        this.thinkTokens = [];
        this._cachedThinkText = null;
        this.lastThinkTransition = 'entered';
      }

      cursor = tagIndex + nextTag.length;
    }

    const remaining = input.slice(cursor);
    const pendingTagLength = this.getPendingTagSuffixLength(remaining);
    const visibleTail = remaining.slice(0, remaining.length - pendingTagLength);

    if (visibleTail) {
      this.appendVisibleSegment(visibleTail, this.insideThink);
      if (this.insideThink) {
        result.sawThinkContent = true;
      } else {
        result.sawNonThinkContent = true;
      }
    }

    this.tagBuffer = remaining.slice(remaining.length - pendingTagLength);

    return result;
  }

  private appendVisibleSegment(text: string, insideThink: boolean): void {
    if (!text) {
      return;
    }

    this.pushStreamToken(text);

    if (insideThink) {
      this.thinkTokens.push(text);
      if (this._cachedThinkText !== null) {
        this._cachedThinkText += text;
      }
      if (this.thinkTokens.length > this.MAX_THINK_TOKENS) {
        this.thinkTokens = this.thinkTokens.slice(-this.MAX_THINK_TOKENS);
        this._cachedThinkText = null; // trim 后缓存失效
      }
      return;
    }

    this.nonThinkStreamTokens.push(text);
    // 增量更新缓存（追加而非重建）
    if (this._cachedNonThinkText !== null) {
      this._cachedNonThinkText += text;
    }
    // 增量更新 fence 计数
    { let idx = -1; while ((idx = text.indexOf('```', idx + 1)) !== -1) this._fenceCount++; }
    if (this.nonThinkStreamTokens.length > this.MAX_STREAM_TOKENS) {
      this.nonThinkStreamTokens = this.nonThinkStreamTokens.slice(
        this.nonThinkStreamTokens.length - this.MAX_STREAM_TOKENS
      );
      this._cachedNonThinkText = null; // trim 后缓存失效，需要重建
      this._fenceCount = -1; // 标记需要重建
    }
  }

  private pushStreamToken(token: string): void {
    this.totalStreamBytes += token.length;
    this.streamTokens.push(token);
    if (this._cachedStreamText !== null) {
      this._cachedStreamText += token;
    }

    if (this.streamTokens.length <= this.MAX_STREAM_TOKENS) {
      return;
    }

    const trimCount = this.streamTokens.length - this.MAX_STREAM_TOKENS;
    if (this.lastBoundaryTokenIndex < trimCount) {
      const lostDelta = this.streamTokens.slice(this.lastBoundaryTokenIndex, trimCount).join('').trim();
      if (lostDelta.length >= this.MIN_BLOCK_LENGTH) {
        this.contentBlocks.push(lostDelta);
        if (this.contentBlocks.length > 10) {
          this.contentBlocks = this.contentBlocks.slice(-10);
        }
      }
    }

    this.streamTokens = this.streamTokens.slice(trimCount);
    this._cachedStreamText = null; // trim 后缓存失效
    this.lastBoundaryTokenIndex = Math.max(0, this.lastBoundaryTokenIndex - trimCount);
  }

  private getPendingTagSuffixLength(text: string): number {
    const maxTagLength = Math.min(text.length, THINK_CLOSE_TAG.length);

    for (let len = maxTagLength; len > 0; len--) {
      const suffix = text.slice(-len);
      if (THINK_OPEN_TAG.startsWith(suffix) || THINK_CLOSE_TAG.startsWith(suffix)) {
        return len;
      }
    }

    return 0;
  }

  private checkThinkRepetition(): RepetitionCheckResult {
    if (this.thinkTokens.length % this.THINK_CHECK_INTERVAL !== 0) {
      return { isRepetitive: false };
    }
    if (this.thinkTokens.length < this.MIN_TOKENS_FOR_DETECTION) {
      return { isRepetitive: false };
    }

    // ★ 性能优化：预计算一次 join text，传给所有子检查（原来每个子检查各自 join 一次）
    const thinkText = this.getThinkText();

    const thinkJunkResult = this.checkJunkTokenRepetition(this.thinkTokens, thinkText);
    if (thinkJunkResult.isRepetitive) {
      return thinkJunkResult;
    }

    const thinkPhraseResult = this.checkPhraseRepetitionOn(this.thinkTokens, this.THINK_DETECTION_PROFILE, thinkText);
    if (thinkPhraseResult.isRepetitive) {
      return thinkPhraseResult;
    }

    const thinkSentenceResult = this.checkConsecutiveSentenceRepetitionOn(this.thinkTokens, this.THINK_DETECTION_PROFILE, thinkText);
    if (thinkSentenceResult.isRepetitive) {
      return thinkSentenceResult;
    }

    const thinkParagraphResult = this.checkParagraphCycleRepetitionOn(this.thinkTokens, this.THINK_DETECTION_PROFILE, thinkText);
    if (thinkParagraphResult.isRepetitive) {
      return thinkParagraphResult;
    }

    return this.checkSentenceFrequencyRepetition(this.thinkTokens, this.THINK_DETECTION_PROFILE, thinkText);
  }

  // ==================== 工具调用重复检测 ====================

  /**
   * 检测是否为重复工具调用
   * @param toolName 工具名称
   * @param toolArgs 工具参数
   * @returns 检测结果
   */
  checkToolCallRepetition(toolName: string, toolArgs: any, toolCallId?: string): RepetitionCheckResult {
    const argsHash = this.hashArgs(toolArgs);
    const retryFamilyHash = this.hashRetryFamily(toolName, toolArgs);
    const now = Date.now();

    // 清理过期记录
    this.toolCallHistory = this.toolCallHistory.filter(
      h => now - h.timestamp < this.TOOL_HISTORY_TTL
    );

    // 检测 1: 完全相同的调用（同名+同参数）连续出现多次
    const exactMatchResult = this.checkExactMatch(toolName, argsHash);
    if (exactMatchResult.isRepetitive) {
      return exactMatchResult;
    }

    const retryFamilyResult = this.checkRetryFamilyMatch(toolName, retryFamilyHash);
    if (retryFamilyResult.isRepetitive) {
      return retryFamilyResult;
    }

    // 检测 2: A→B→A→B 或 A→B→C→A→B→C 循环模式（必须参数也相同才触发）
    const cycleResult = this.checkCyclePattern(toolName, argsHash);
    if (cycleResult.isRepetitive) {
      return cycleResult;
    }

    const retryFamilyCycleResult = this.checkRetryFamilyCyclePattern();
    if (retryFamilyCycleResult.isRepetitive) {
      return retryFamilyCycleResult;
    }

    const looseCycleResult = this.checkLooseCyclePattern();
    if (looseCycleResult.isRepetitive) {
      return looseCycleResult;
    }

    const resultPattern = this.checkResultDrivenRetryPattern(toolName, retryFamilyHash);
    if (resultPattern.isRepetitive) {
      return resultPattern;
    }

    const crossToolResultPattern = this.checkCrossToolResultStagnation();
    if (crossToolResultPattern.isRepetitive) {
      return crossToolResultPattern;
    }

    // 记录本次调用
    this.toolCallHistory.push({
      toolCallId: toolCallId || `${toolName}:${now}:${this.toolCallHistory.length}`,
      name: toolName,
      argsHash,
      retryFamilyHash,
      timestamp: now
    });

    return { isRepetitive: false };
  }

  recordToolCallOutcome(
    toolCallId: string,
    toolName: string,
    toolArgs: any,
    outcome: { content?: string; resultText?: string; isError?: boolean; isWarning?: boolean }
  ): void {
    const argsHash = this.hashArgs(toolArgs);
    const record = [...this.toolCallHistory].reverse().find(item =>
      (item.toolCallId === toolCallId) ||
      (!item.resultCategory && item.name === toolName && item.argsHash === argsHash)
    );

    if (!record) {
      return;
    }

    const classified = this.classifyToolOutcome(
      outcome.content || outcome.resultText || '',
      outcome.isError === true,
      outcome.isWarning === true
    );

    record.isError = outcome.isError === true;
    record.isWarning = outcome.isWarning === true;
    record.resultCategory = classified.category;
    record.resultSignature = classified.signature;
    record.resultStructuredSignature = classified.structuredSignature;
    record.resultStructuredItems = classified.structuredItems;
  }

  /**
   * 检测完全相同的工具调用（同名+同参数）
   */
  private checkExactMatch(toolName: string, argsHash: string): RepetitionCheckResult {
    // 只检查末尾连续的相同调用
    let consecutiveCount = 0;
    for (let i = this.toolCallHistory.length - 1; i >= 0; i--) {
      const h = this.toolCallHistory[i];
      if (h.name === toolName && h.argsHash === argsHash) {
        consecutiveCount++;
      } else {
        break; // 不连续了
      }
    }

    if (consecutiveCount >= this.SAME_TOOL_THRESHOLD - 1) {
      return {
        isRepetitive: true,
        pattern: `${toolName} 使用相同参数连续调用 ${consecutiveCount + 1} 次`,
        suggestion: '请检查是否陷入了无效循环，考虑尝试不同的方法或参数。'
      };
    }

    return { isRepetitive: false };
  }

  private checkRetryFamilyMatch(toolName: string, retryFamilyHash: string): RepetitionCheckResult {
    const trailingFamilyCalls = this.getTrailingRetryFamilyCalls(toolName, retryFamilyHash);
    const distinctArgs = new Set(trailingFamilyCalls.map(item => item.argsHash));

    if (
      trailingFamilyCalls.length >= this.SAME_TOOL_FAMILY_THRESHOLD - 1 &&
      distinctArgs.size >= 2
    ) {
      return {
        isRepetitive: true,
        pattern: `${toolName} 使用近似参数连续重试 ${trailingFamilyCalls.length + 1} 次`,
        suggestion: '检测到同一工具在相近参数上反复试探，请切换工具或缩小问题范围。'
      };
    }

    return { isRepetitive: false };
  }

  /**
   * 检测循环调用模式 (A→B→A→B 或 A→B→C→A→B→C)
   * 必须同时满足：工具名循环 + 参数也相同
   */
  private checkCyclePattern(toolName: string, argsHash: string): RepetitionCheckResult {
    // 构造包含当前调用（尚未 push）的虚拟历史
    const virtualHistory = [
      ...this.toolCallHistory.slice(-this.CYCLE_PATTERN_LENGTH),
      { name: toolName, argsHash, timestamp: Date.now() }
    ];

    // 检测 2 元素循环: A→B→A→B（工具名+参数都相同）
    if (virtualHistory.length >= 4) {
      const last4 = virtualHistory.slice(-4);
      if (
        last4[0].name === last4[2].name &&
        last4[1].name === last4[3].name &&
        last4[0].name !== last4[1].name &&
        last4[0].argsHash === last4[2].argsHash &&
        last4[1].argsHash === last4[3].argsHash
      ) {
        return {
          isRepetitive: true,
          pattern: `${last4[0].name} ↔ ${last4[1].name} 循环调用（参数相同）`,
          suggestion: '检测到工具间的循环依赖，请重新思考解决方案。'
        };
      }
    }

    // 检测 3 元素循环: A→B→C→A→B→C（工具名+参数都相同）
    if (virtualHistory.length >= 6) {
      const last6 = virtualHistory.slice(-6);
      const uniqueTools = new Set([last6[0].name, last6[1].name, last6[2].name]);
      if (
        uniqueTools.size >= 2 &&
        last6[0].name === last6[3].name &&
        last6[1].name === last6[4].name &&
        last6[2].name === last6[5].name &&
        last6[0].argsHash === last6[3].argsHash &&
        last6[1].argsHash === last6[4].argsHash &&
        last6[2].argsHash === last6[5].argsHash
      ) {
        return {
          isRepetitive: true,
          pattern: `${last6[0].name} → ${last6[1].name} → ${last6[2].name} 循环调用`,
          suggestion: '检测到三工具循环模式，请尝试不同的解决策略。'
        };
      }
    }

    // 检测 4 元素循环: A→B→C→D→A→B→C→D（工具名+参数都相同）
    if (virtualHistory.length >= 8) {
      const last8 = virtualHistory.slice(-8);
      const uniqueTools4 = new Set([last8[0].name, last8[1].name, last8[2].name, last8[3].name]);
      if (
        uniqueTools4.size >= 2 &&
        last8[0].name === last8[4].name &&
        last8[1].name === last8[5].name &&
        last8[2].name === last8[6].name &&
        last8[3].name === last8[7].name &&
        last8[0].argsHash === last8[4].argsHash &&
        last8[1].argsHash === last8[5].argsHash &&
        last8[2].argsHash === last8[6].argsHash &&
        last8[3].argsHash === last8[7].argsHash
      ) {
        return {
          isRepetitive: true,
          pattern: `${last8[0].name} → ${last8[1].name} → ${last8[2].name} → ${last8[3].name} 循环调用`,
          suggestion: '检测到四工具循环模式，请尝试不同的解决策略。'
        };
      }
    }

    return { isRepetitive: false };
  }

  private checkRetryFamilyCyclePattern(): RepetitionCheckResult {
    const completedHistory = this.getCompletedToolHistory(this.CYCLE_PATTERN_LENGTH);

    if (completedHistory.length >= 4) {
      const last4 = completedHistory.slice(-4);
      if (
        last4[0].name === last4[2].name &&
        last4[1].name === last4[3].name &&
        last4[0].name !== last4[1].name &&
        last4[0].retryFamilyHash === last4[2].retryFamilyHash &&
        last4[1].retryFamilyHash === last4[3].retryFamilyHash &&
        this.hasCycleResultStagnation(last4, true)
      ) {
        return {
          isRepetitive: true,
          pattern: `${last4[0].name} ↔ ${last4[1].name} 循环调用（近似参数）`,
          suggestion: '检测到工具在近似参数上循环往返，请重新规划执行路径。'
        };
      }
    }

    if (completedHistory.length >= 6) {
      const last6 = completedHistory.slice(-6);
      if (
        last6[0].name === last6[3].name &&
        last6[1].name === last6[4].name &&
        last6[2].name === last6[5].name &&
        last6[0].retryFamilyHash === last6[3].retryFamilyHash &&
        last6[1].retryFamilyHash === last6[4].retryFamilyHash &&
        last6[2].retryFamilyHash === last6[5].retryFamilyHash &&
        new Set([last6[0].name, last6[1].name, last6[2].name]).size >= 2 &&
        this.hasCycleResultStagnation(last6, true)
      ) {
        return {
          isRepetitive: true,
          pattern: `${last6[0].name} → ${last6[1].name} → ${last6[2].name} 循环调用（近似参数）`,
          suggestion: '检测到近似参数的三工具循环，请切换策略。'
        };
      }
    }

    return { isRepetitive: false };
  }

  /**
   * 检测允许少量噪声步骤的循环调用模式
   * 示例：A→X→B→A→Y→B，或 A→B→X→C→A→B→Y→C
   */
  private checkLooseCyclePattern(): RepetitionCheckResult {
    const completedHistory = this.getCompletedToolHistory(
      this.CYCLE_PATTERN_LENGTH + this.CYCLE_PATTERN_NOISE_TOLERANCE * 2
    );

    for (let patternLength = 2; patternLength <= 3; patternLength++) {
      const exactRounds = this.findLooseCycleRounds(completedHistory, patternLength, false);
      if (exactRounds) {
        return {
          isRepetitive: true,
          pattern: `${exactRounds.pattern.map(record => record.name).join(' → ')} 宽松循环调用（允许少量间隔）`,
          suggestion: '检测到工具轨迹反复回到相同模式，请停止重试并切换策略。'
        };
      }

      const retryFamilyRounds = this.findLooseCycleRounds(completedHistory, patternLength, true);
      if (retryFamilyRounds) {
        return {
          isRepetitive: true,
          pattern: `${retryFamilyRounds.pattern.map(record => record.name).join(' → ')} 宽松循环调用（近似参数）`,
          suggestion: '检测到工具在近似参数上反复回到相同轨迹，请停止重试并切换策略。'
        };
      }
    }

    return { isRepetitive: false };
  }

  private checkResultDrivenRetryPattern(toolName: string, retryFamilyHash: string): RepetitionCheckResult {
    const trailingCalls = this.getTrailingRetryFamilyCalls(toolName, retryFamilyHash)
      .filter(record => !!record.resultCategory);

    const recentCalls = this.getRecentRetryFamilyCalls(toolName, retryFamilyHash)
      .filter(record => !!record.resultCategory);

    const trailingRisk = this.evaluateResultRetryRisk(trailingCalls);
    const recentRisk = this.evaluateResultRetryRisk(recentCalls);
    const bestRisk = trailingRisk.score >= recentRisk.score ? trailingRisk : recentRisk;

    if (!bestRisk.category || bestRisk.score < bestRisk.threshold) {
      return { isRepetitive: false };
    }

    const resultDescription = bestRisk.isStalePayload
      ? '重复有效载荷'
      : bestRisk.isLowNoveltyPayload
        ? '新增信息极少的有效载荷'
      : this.describeToolResultCategory(bestRisk.category);

    return {
      isRepetitive: true,
      pattern: `${toolName} 在近似参数上反复得到${resultDescription}（风险分 ${bestRisk.score}/${bestRisk.threshold}）`,
      suggestion: '检测到不同参数重试并未带来新结果，请改用不同工具或重新理解问题。'
    };
  }

  private checkCrossToolResultStagnation(): RepetitionCheckResult {
    const completedRecords = this.toolCallHistory.filter(record => !!record.resultCategory);
    if (completedRecords.length < this.CROSS_TOOL_RESULT_REPEAT_THRESHOLD) {
      return { isRepetitive: false };
    }

    const lastRecord = completedRecords[completedRecords.length - 1];
    const trailingEquivalentRecords: ToolCallRecord[] = [lastRecord];

    for (let index = completedRecords.length - 2; index >= 0; index--) {
      const candidate = completedRecords[index];
      if (!this.isEquivalentToolOutcome(lastRecord, candidate)) {
        break;
      }
      trailingEquivalentRecords.unshift(candidate);
    }

    if (trailingEquivalentRecords.length < this.CROSS_TOOL_RESULT_REPEAT_THRESHOLD) {
      return { isRepetitive: false };
    }

    const distinctTools = Array.from(new Set(trailingEquivalentRecords.map(record => record.name)));
    if (distinctTools.length < 2) {
      return { isRepetitive: false };
    }

    return {
      isRepetitive: true,
      pattern: `多个工具连续返回同质结果 ${trailingEquivalentRecords.length} 次: ${distinctTools.join(' → ')}`,
      suggestion: '不同工具连续返回相同信息，当前轨迹可能已卡住，请停止扩散调用并改换策略。'
    };
  }

  private isEquivalentToolOutcome(base: ToolCallRecord, candidate: ToolCallRecord): boolean {
    if (base.resultCategory !== candidate.resultCategory) {
      return false;
    }

    if (base.resultStructuredSignature && candidate.resultStructuredSignature) {
      return base.resultStructuredSignature === candidate.resultStructuredSignature;
    }

    if (!base.resultSignature || !candidate.resultSignature) {
      return false;
    }

    if (
      base.resultCategory === 'success_payload' &&
      (base.resultSignature.length < this.CROSS_TOOL_RESULT_MIN_SIGNATURE_LENGTH ||
        candidate.resultSignature.length < this.CROSS_TOOL_RESULT_MIN_SIGNATURE_LENGTH)
    ) {
      return false;
    }

    return base.resultSignature === candidate.resultSignature;
  }

  private findLooseCycleRounds(
    history: readonly ToolCallRecord[],
    patternLength: number,
    useRetryFamily: boolean
  ): { pattern: ToolCallRecord[] } | null {
    if (history.length < patternLength * 2) {
      return null;
    }

    const lastRoundCandidates = this.getRoundCandidates(history.length, patternLength)
      .filter(candidate => candidate[candidate.length - 1] === history.length - 1);

    for (const lastRound of lastRoundCandidates) {
      const pattern = lastRound.map(index => history[index]);
      if (new Set(pattern.map(record => record.name)).size < 2) {
        continue;
      }

      const previousRoundCandidates = this.getRoundCandidates(lastRound[0], patternLength);
      for (const previousRound of previousRoundCandidates) {
        const matches = previousRound.every((historyIndex, idx) => {
          const previous = history[historyIndex];
          const current = pattern[idx];
          return this.isEquivalentToolCall(previous, current, useRetryFamily);
        });

        if (matches) {
          const previousPattern = previousRound.map(index => history[index]);
          if (!this.hasCycleResultStagnation([...previousPattern, ...pattern], useRetryFamily)) {
            continue;
          }
          return { pattern };
        }
      }
    }

    return null;
  }

  private isEquivalentToolCall(a: ToolCallRecord, b: ToolCallRecord, useRetryFamily: boolean): boolean {
    return a.name === b.name && (
      useRetryFamily ? a.retryFamilyHash === b.retryFamilyHash : a.argsHash === b.argsHash
    );
  }

  private getCompletedToolHistory(limit: number): ToolCallRecord[] {
    return this.toolCallHistory
      .filter(record => !!record.resultCategory)
      .slice(-limit);
  }

  private hasCycleResultStagnation(records: readonly ToolCallRecord[], useRetryFamily: boolean): boolean {
    if (records.length < 4) {
      return false;
    }

    const groups = new Map<string, ToolCallRecord[]>();
    for (const record of records) {
      const key = `${record.name}::${useRetryFamily ? record.retryFamilyHash : record.argsHash}`;
      const existing = groups.get(key) || [];
      existing.push(record);
      groups.set(key, existing);
    }

    const groupedRecords = Array.from(groups.values());
    if (groupedRecords.some(group => group.length < 2)) {
      return false;
    }

    let stagnationGroupCount = 0;
    for (const group of groupedRecords) {
      const risk = this.evaluateResultRetryRisk(group);
      if (risk.isStalePayload || risk.isLowNoveltyPayload) {
        stagnationGroupCount++;
        continue;
      }

      const categories = group
        .map(record => record.resultCategory)
        .filter((category): category is ToolResultCategory => !!category);
      const signatures = group
        .map(record => record.resultStructuredSignature || record.resultSignature)
        .filter((signature): signature is string => !!signature);

      const allProblematic = categories.length >= 2 && categories.every(category => this.isProblematicToolOutcome(category));
      const repeatedSameOutcome = signatures.length >= 2 && this.getTopOccurrenceCount(signatures) >= 2;

      if (allProblematic || repeatedSameOutcome) {
        stagnationGroupCount++;
      }
    }

    return stagnationGroupCount >= 1;
  }

  private getTrailingRetryFamilyCalls(toolName: string, retryFamilyHash: string): ToolCallRecord[] {
    const records: ToolCallRecord[] = [];
    for (let i = this.toolCallHistory.length - 1; i >= 0; i--) {
      const record = this.toolCallHistory[i];
      if (record.name === toolName && record.retryFamilyHash === retryFamilyHash) {
        records.unshift(record);
      } else {
        break;
      }
    }
    return records;
  }

  private getRecentRetryFamilyCalls(toolName: string, retryFamilyHash: string): ToolCallRecord[] {
    return this.toolCallHistory
      .slice(-this.TOOL_RESULT_WINDOW_SIZE)
      .filter(record => record.name === toolName && record.retryFamilyHash === retryFamilyHash);
  }

  private evaluateResultRetryRisk(records: readonly ToolCallRecord[]): {
    score: number;
    threshold: number;
    category?: ToolResultCategory;
    isStalePayload?: boolean;
    isLowNoveltyPayload?: boolean;
  } {
    if (records.length < 2) {
      return { score: 0, threshold: this.TOOL_RESULT_RISK_THRESHOLD };
    }

    const categorizedRecords = records.filter(record => !!record.resultCategory);
    if (categorizedRecords.length < 2) {
      return { score: 0, threshold: this.TOOL_RESULT_RISK_THRESHOLD };
    }

    const categoryCounts = new Map<ToolResultCategory, number>();
    const signatureCounts = new Map<string, number>();
    let strongestCategory: ToolResultCategory | undefined;
    let strongestCategoryCount = 0;

    for (const record of categorizedRecords) {
      const category = record.resultCategory!;
      const categoryCount = (categoryCounts.get(category) || 0) + 1;
      categoryCounts.set(category, categoryCount);
      if (categoryCount > strongestCategoryCount) {
        strongestCategoryCount = categoryCount;
        strongestCategory = category;
      }

      if (record.resultSignature) {
        signatureCounts.set(record.resultSignature, (signatureCounts.get(record.resultSignature) || 0) + 1);
      }
    }

    if (!strongestCategory) {
      return { score: 0, threshold: this.TOOL_RESULT_RISK_THRESHOLD };
    }

    const signatureCount = Math.max(...Array.from(signatureCounts.values()), 0);
    const distinctArgs = new Set(categorizedRecords.map(record => record.argsHash)).size;
    const problematicRecords = categorizedRecords.filter(record => this.isProblematicToolOutcome(record.resultCategory!));
    const successPayloadRecords = categorizedRecords.filter(record => record.resultCategory === 'success_payload');
    const similarPayloadClusterSize = this.getLargestSimilarSignatureCluster(
      successPayloadRecords
        .map(record => record.resultSignature)
        .filter((signature): signature is string => !!signature)
    );
    const structuredPayloadClusterSize = this.getTopOccurrenceCount(
      successPayloadRecords
        .map(record => record.resultStructuredSignature)
        .filter((signature): signature is string => !!signature)
    );
    const structuredNoGrowthRun = this.getLongestStructuredNoGrowthRun(successPayloadRecords);
    const structuredNoveltyStats = this.getStructuredNoveltyStats(successPayloadRecords);
    const isStalePayload = strongestCategory === 'success_payload' && (
      similarPayloadClusterSize >= 3 ||
      structuredPayloadClusterSize >= 3 ||
      structuredNoGrowthRun >= 3
    );
    const isLowNoveltyPayload = strongestCategory === 'success_payload' && !isStalePayload && (
      structuredNoveltyStats.longestLowNoveltyRun >= 4 ||
      structuredNoveltyStats.averageNoveltyRatio <= 0.15
    );

    let riskScore = 0;
    if (distinctArgs >= 2) {
      riskScore += 1;
    }
    if (categorizedRecords.length >= 3) {
      riskScore += 1;
    }
    if (strongestCategoryCount >= 3 && this.isProblematicToolOutcome(strongestCategory)) {
      riskScore += 2;
    }
    if (signatureCount >= 2) {
      riskScore += 1;
    }
    if (problematicRecords.length === categorizedRecords.length) {
      riskScore += 1;
    }

    if (isStalePayload) {
      riskScore += 3;
    } else if (isLowNoveltyPayload) {
      riskScore += 2;
    } else if (
      strongestCategory === 'success_payload' &&
      (similarPayloadClusterSize >= 2 || structuredPayloadClusterSize >= 2 || structuredNoGrowthRun >= 2)
    ) {
      riskScore += 1;
    }

    if (strongestCategory === 'success_payload' && structuredPayloadClusterSize >= 3) {
      riskScore += 1;
    }

    if (strongestCategory === 'success_payload' && structuredNoveltyStats.longestLowNoveltyRun >= 3) {
      riskScore += 1;
    }

    return {
      score: riskScore,
      threshold: this.getToolResultRiskThreshold(strongestCategory, {
        strongestCategoryCount,
        signatureCount,
        similarPayloadClusterSize,
        structuredPayloadClusterSize,
        structuredNoGrowthRun,
        longestLowNoveltyRun: structuredNoveltyStats.longestLowNoveltyRun,
        averageNoveltyRatio: structuredNoveltyStats.averageNoveltyRatio,
      }),
      category: strongestCategory,
      isStalePayload,
      isLowNoveltyPayload,
    };
  }

  private getToolResultRiskThreshold(
    category: ToolResultCategory,
    stats: {
      strongestCategoryCount: number;
      signatureCount: number;
      similarPayloadClusterSize: number;
      structuredPayloadClusterSize: number;
      structuredNoGrowthRun: number;
      longestLowNoveltyRun: number;
      averageNoveltyRatio: number;
    }
  ): number {
    if (category === 'success_payload') {
      if (stats.structuredPayloadClusterSize >= 3 || stats.structuredNoGrowthRun >= 3) {
        return 4;
      }
      if (stats.longestLowNoveltyRun >= 4 || stats.averageNoveltyRatio <= 0.15) {
        return 5;
      }
      return stats.similarPayloadClusterSize >= 3 ? 5 : 6;
    }

    if (category === 'success_empty' || category === 'error_not_found') {
      return stats.strongestCategoryCount >= 3 ? 3 : 4;
    }

    if (category === 'error_rate_limit' || category === 'error_auth' || category === 'error_timeout') {
      return stats.strongestCategoryCount >= 3 ? 3 : 4;
    }

    if (category === 'error_parse' || category === 'error_invalid_args' || category === 'error_permission') {
      return 4;
    }

    return this.TOOL_RESULT_RISK_THRESHOLD;
  }

  private getLargestSimilarSignatureCluster(signatures: readonly string[]): number {
    let bestCluster = 0;

    for (let i = 0; i < signatures.length; i++) {
      let clusterSize = 1;
      for (let j = i + 1; j < signatures.length; j++) {
        if (this.computeSimilarity(signatures[i], signatures[j]) >= 0.82) {
          clusterSize++;
        }
      }
      bestCluster = Math.max(bestCluster, clusterSize);
    }

    return bestCluster;
  }

  private getLongestStructuredNoGrowthRun(records: readonly ToolCallRecord[]): number {
    let bestRun = 0;

    for (let i = 0; i < records.length; i++) {
      const baseItems = records[i].resultStructuredItems;
      if (!baseItems || baseItems.length === 0) {
        continue;
      }

      const knownItems = new Set(baseItems);
      let runLength = 1;

      for (let j = i + 1; j < records.length; j++) {
        const currentItems = records[j].resultStructuredItems;
        if (!currentItems || currentItems.length === 0) {
          break;
        }

        const newItems = currentItems.filter(item => !knownItems.has(item));
        if (newItems.length > 0) {
          break;
        }

        runLength++;
        currentItems.forEach(item => knownItems.add(item));
      }

      bestRun = Math.max(bestRun, runLength);
    }

    return bestRun;
  }

  private getStructuredNoveltyStats(records: readonly ToolCallRecord[]): {
    longestLowNoveltyRun: number;
    averageNoveltyRatio: number;
  } {
    const noveltyRatios: number[] = [];
    let longestLowNoveltyRun = 0;
    let currentLowNoveltyRun = 0;
    const seenItems = new Set<string>();

    for (const record of records) {
      const currentItems = record.resultStructuredItems;
      if (!currentItems || currentItems.length === 0) {
        currentLowNoveltyRun = 0;
        continue;
      }

      const uniqueItems = Array.from(new Set(currentItems));
      const newItems = uniqueItems.filter(item => !seenItems.has(item));
      const noveltyRatio = uniqueItems.length > 0 ? newItems.length / uniqueItems.length : 0;

      if (seenItems.size > 0) {
        noveltyRatios.push(noveltyRatio);
        if (noveltyRatio <= 0.2) {
          currentLowNoveltyRun++;
          longestLowNoveltyRun = Math.max(longestLowNoveltyRun, currentLowNoveltyRun);
        } else {
          currentLowNoveltyRun = 0;
        }
      }

      uniqueItems.forEach(item => seenItems.add(item));
    }

    const averageNoveltyRatio = noveltyRatios.length > 0
      ? noveltyRatios.reduce((sum, ratio) => sum + ratio, 0) / noveltyRatios.length
      : 1;

    return {
      longestLowNoveltyRun,
      averageNoveltyRatio,
    };
  }

  private getTopOccurrenceCount(values: readonly string[]): number {
    const counter = new Map<string, number>();
    let maxCount = 0;

    for (const value of values) {
      const count = (counter.get(value) || 0) + 1;
      counter.set(value, count);
      maxCount = Math.max(maxCount, count);
    }

    return maxCount;
  }

  private getRoundCandidates(endExclusive: number, patternLength: number): number[][] {
    const candidates: number[][] = [];
    const maxSpan = patternLength + this.CYCLE_PATTERN_NOISE_TOLERANCE;

    const walk = (startIndex: number, current: number[]): void => {
      if (current.length === patternLength) {
        const span = current[current.length - 1] - current[0] + 1;
        if (span <= maxSpan) {
          candidates.push([...current]);
        }
        return;
      }

      const remaining = patternLength - current.length;
      for (let index = startIndex; index <= endExclusive - remaining; index++) {
        current.push(index);
        walk(index + 1, current);
        current.pop();
      }
    };

    walk(0, []);
    return candidates;
  }

  /**
   * 生成参数哈希（用于比较参数是否相同）
   * 使用深层排序确保 key 顺序不同的等价对象产生相同 hash
   */
  private hashArgs(args: any): string {
    try {
      return JSON.stringify(this.sortKeysDeep(this.normalizeArgs(args)));
    } catch (e) {
      return String(args);
    }
  }

  private hashRetryFamily(toolName: string, args: any): string {
    try {
      return JSON.stringify({
        toolName,
        args: this.sortKeysDeep(this.normalizeArgsForRetryFamily(args))
      });
    } catch {
      return `${toolName}:${String(args)}`;
    }
  }

  /**
   * 归一化工具参数，减少微小差异导致的检测绕过
   */
  private normalizeArgs(value: any): any {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      let normalized = value.trim().replace(/\s+/g, ' ');
      // 路径值：统一分隔符为 /、转小写
      if (/[/\\]/.test(normalized)) {
        normalized = normalized.replace(/\\/g, '/').toLowerCase();
      }
      return normalized;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map(item => this.normalizeArgs(item));
    }
    const result: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      result[key] = this.normalizeArgs(value[key]);
    }
    return result;
  }

  private normalizeArgsForRetryFamily(value: any, keyName = ''): any {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      let normalized = this.normalizeArgs(value);
      if (typeof normalized === 'string') {
        normalized = normalized
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '<id>')
          .replace(/\b\d{4,}\b/g, '<num>');
      }
      return normalized;
    }

    if (typeof value === 'number') {
      if (this.isVolatileArgKey(keyName)) {
        return '<num>';
      }
      return value;
    }

    if (typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      return value.map(item => this.normalizeArgsForRetryFamily(item, keyName));
    }

    const result: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      if (this.isVolatileArgKey(key)) {
        continue;
      }
      result[key] = this.normalizeArgsForRetryFamily(value[key], key);
    }
    return result;
  }

  private isVolatileArgKey(keyName: string): boolean {
    return /^(line|column|offset|cursor|page|pageSize|limit|maxResults|retry|retryCount|attempt|timestamp|requestId|traceId|callId|toolId)$/i.test(keyName);
  }

  private classifyToolOutcome(
    text: string,
    isError: boolean,
    isWarning: boolean
  ): {
    category: ToolResultCategory;
    signature: string;
    structuredSignature?: string;
    structuredItems?: string[];
  } {
    const normalized = this.normalizeToolOutcomeText(text);
    const structured = this.extractStructuredPayloadSummary(text);

    if (!normalized || /无返回内容|执行完成|done/.test(normalized)) {
      return { category: 'success_empty', signature: '<empty>' };
    }

    const errorLike = isError || isWarning;
    if (/(rate limit|too many requests|429|请求过于频繁|限流)/.test(normalized)) {
      return { category: 'error_rate_limit', signature: normalized };
    }
    if (/(unauthorized|authentication|auth failed|token expired|apikey|api key|未认证|鉴权失败)/.test(normalized)) {
      return { category: 'error_auth', signature: normalized };
    }
    if (/(timeout|timed out|超时)/.test(normalized)) {
      return { category: 'error_timeout', signature: normalized };
    }
    if (/(not found|未找到|不存在|no matches|empty result|无匹配|0 matches|没有结果|空结果)/.test(normalized)) {
      return { category: errorLike ? 'error_not_found' : 'success_empty', signature: normalized };
    }
    if (/(permission|forbidden|denied|无权限|禁止访问)/.test(normalized)) {
      return { category: 'error_permission', signature: normalized };
    }
    if (/(parse|json解析失败|syntax error|解析失败)/.test(normalized)) {
      return { category: 'error_parse', signature: normalized };
    }
    if (/(invalid|missing required|参数错误|参数解析失败|缺少必填)/.test(normalized)) {
      return { category: 'error_invalid_args', signature: normalized };
    }

    if (errorLike) {
      return { category: 'error_unknown', signature: normalized };
    }

    return {
      category: 'success_payload',
      signature: normalized,
      structuredSignature: structured.signature,
      structuredItems: structured.items,
    };
  }

  private extractStructuredPayloadSummary(text: string): { signature?: string; items?: string[] } {
    const sanitizedText = this.stripCodeFences(text).trim();
    if (!sanitizedText) {
      return {};
    }

    const jsonItems = this.extractJsonStructuredItems(sanitizedText);
    if (jsonItems.length >= 2) {
      return this.buildStructuredPayloadSummary(jsonItems);
    }

    const lines = sanitizedText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const bulletItems = lines
      .map(line => line.match(/^(?:[-*•]|\d+[.)]|\[[ xX]\])\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => !!match)
      .map(match => match[1]);
    if (bulletItems.length >= 2) {
      return this.buildStructuredPayloadSummary(bulletItems);
    }

    const kvItems = lines
      .map(line => line.match(/^([^:：]{1,40})\s*[:：]\s*(.+)$/))
      .filter((match): match is RegExpMatchArray => !!match)
      .map(match => `${match[1]}=${match[2]}`);
    if (kvItems.length >= 2) {
      return this.buildStructuredPayloadSummary(kvItems);
    }

    return {};
  }

  private buildStructuredPayloadSummary(items: readonly string[]): { signature?: string; items?: string[] } {
    const normalizedItems = Array.from(new Set(
      items
        .map(item => this.normalizeStructuredPayloadItem(item))
        .filter(item => item.length >= 2)
    )).sort();

    if (normalizedItems.length < 2) {
      return {};
    }

    return {
      signature: normalizedItems.join(' | '),
      items: normalizedItems,
    };
  }

  private normalizeStructuredPayloadItem(item: string): string {
    return item
      .toLowerCase()
      .replace(/["'`]+/g, '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '<id>')
      .replace(/[a-z]:[\\/][^\s<>"']+/gi, '<path>')
      .replace(/\b\d{4,}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/gi, '<time>')
      .replace(/\b\d+\b/g, '<num>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private stripCodeFences(text: string): string {
    return text.replace(/```[^\n]*\n?/g, '').replace(/```/g, '');
  }

  private extractJsonStructuredItems(text: string): string[] {
    const trimmed = text.trim();
    if (!/^[\[{]/.test(trimmed)) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);
      const items: string[] = [];
      this.flattenStructuredValue(parsed, '', items);
      return items;
    } catch {
      return [];
    }
  }

  private flattenStructuredValue(value: unknown, path: string, output: string[]): void {
    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const normalizedValue = this.normalizeStructuredPayloadItem(String(value));
      if (!normalizedValue) {
        return;
      }
      output.push(path ? `${path}=${normalizedValue}` : normalizedValue);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(item => {
        const nextPath = path ? `${path}[]` : '';
        this.flattenStructuredValue(item, nextPath, output);
      });
      return;
    }

    if (typeof value === 'object') {
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .forEach(([key, child]) => {
          const nextPath = path ? `${path}.${key}` : key;
          this.flattenStructuredValue(child, nextPath, output);
        });
    }
  }

  private normalizeToolOutcomeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '<id>')
      .replace(/[a-z]:\/[^\s<>"']+/gi, '<path>')
      .replace(/\b\d{4,}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/gi, '<time>')
      .replace(/\b\d+\b/g, '<num>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  private isProblematicToolOutcome(category: ToolResultCategory): boolean {
    return category !== 'success_payload';
  }

  private describeToolResultCategory(category: ToolResultCategory): string {
    switch (category) {
      case 'success_empty': return '空结果';
      case 'error_rate_limit': return '限流结果';
      case 'error_auth': return '鉴权错误';
      case 'error_timeout': return '超时结果';
      case 'error_not_found': return '未命中结果';
      case 'error_permission': return '权限错误';
      case 'error_parse': return '解析错误';
      case 'error_invalid_args': return '参数错误';
      case 'error_unknown': return '同质失败';
      default: return '重复结果';
    }
  }

  /**
   * 递归对对象的 key 进行排序，确保序列化结果稳定
   */
  private sortKeysDeep(value: any): any {
    if (value === null || value === undefined || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(item => this.sortKeysDeep(item));
    }
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = this.sortKeysDeep(value[key]);
    }
    return sorted;
  }

  // ==================== 流式文本重复检测 ====================

  /**
   * 添加流式 token 并检测重复
   * @param token 新的 token
   * @returns 检测结果
   */
  checkStreamRepetition(token: string): RepetitionCheckResult {
    const chunkResult = this.processStreamChunk(token);

    // Layer -1（兜底）: 绝对上限强制中断
    if (this.totalStreamBytes > this.MAX_SINGLE_RESPONSE_BYTES) {
      return {
        isRepetitive: true,
        pattern: `单次输出已超过 ${Math.round(this.MAX_SINGLE_RESPONSE_BYTES / 1024 / 1024)}MB (${(this.totalStreamBytes / 1024 / 1024).toFixed(1)}MB)`,
        suggestion: '输出内容异常庞大，可能存在无限循环。',
        thinkTransition: this.lastThinkTransition ?? undefined,
      };
    }

    // 软警告：每 3MB 发出一次，不中断流
    let sizeWarning: string | undefined;
    if (this.totalStreamBytes >= this.nextSizeWarningBytes) {
      const currentMB = (this.totalStreamBytes / 1024 / 1024).toFixed(1);
      sizeWarning = `当前单次输出已达 ${currentMB}MB，内容可能存在循环，如需停止请点击取消按钮`;
      this.nextSizeWarningBytes += this.SIZE_WARNING_INTERVAL_BYTES;
    }

    if (chunkResult.sawThinkContent || chunkResult.thinkClosedInChunk) {
      const thinkResult = this.checkThinkRepetition();
      if (chunkResult.thinkClosedInChunk) {
        this.thinkTokens = [];
        this._cachedThinkText = null;
      }
      if (thinkResult.isRepetitive) {
        return {
          ...thinkResult,
          thinkTransition: this.lastThinkTransition ?? undefined,
        };
      }
    }

    if (this.insideThink) {
      return { isRepetitive: false, thinkTransition: this.lastThinkTransition ?? undefined, sizeWarning };
    }

    if (!chunkResult.sawNonThinkContent) {
      return { isRepetitive: false, thinkTransition: this.lastThinkTransition ?? undefined, sizeWarning };
    }

    // 每 N 个 token 检测一次
    if (this.streamTokens.length % this.CHECK_INTERVAL !== 0) {
      return { isRepetitive: false, thinkTransition: this.lastThinkTransition ?? undefined, sizeWarning };
    }

    // 至少需要一定数量的 token 才开始检测
    if (this.streamTokens.length < this.MIN_TOKENS_FOR_DETECTION) {
      return { isRepetitive: false, thinkTransition: this.lastThinkTransition ?? undefined, sizeWarning };
    }

    // ★ 性能优化：只 join 一次 nonThinkStreamTokens，复用缓存
    const nonThinkText = this.getNonThinkText();

    // Layer 0: 垃圾 token 重复（\t\t\t...、\t}\t}...、}\r}\r... 等卡顿信号）
    const junkResult = this.checkJunkTokenRepetition(this.nonThinkStreamTokens, nonThinkText);
    if (junkResult.isRepetitive) {
      return junkResult;
    }
    const insideMarkdownFence = this.isInsideMarkdownCodeFence(nonThinkText);

    // Layer 1: Token 级连续短语重复（"哈哈哈哈哈" 或 token 卡顿）
    if (!insideMarkdownFence) {
      const phraseResult = this.checkPhraseRepetition();
      if (phraseResult.isRepetitive) {
        return phraseResult;
      }
    }

    // Layer 2: 句子级连续重复（相同句子在末尾连续出现 ≥3 次）
    const sentenceResult = this.checkConsecutiveSentenceRepetition(this.PROSE_DETECTION_PROFILE);
    if (sentenceResult.isRepetitive) {
      return sentenceResult;
    }

    // Layer 2.5: 段落块循环重复（ABCDABCD... 多句段落整体重复）
    const paragraphResult = this.checkParagraphCycleRepetition(this.PROSE_DETECTION_PROFILE);
    if (paragraphResult.isRepetitive) {
      return paragraphResult;
    }

    // Layer 3: 内容块跨边界重复（<think>/tool_call 前后相同内容块）
    const blockResult = this.checkBlockRepetition(this.PROSE_DETECTION_PROFILE);
    if (blockResult.isRepetitive) {
      return blockResult;
    }
    
    // Layer 3.5: fenced code block 重复（整段代码块/代码行循环刷屏）
    const codeBlockResult = this.checkCodeBlockRepetition(nonThinkText, this.CODE_BLOCK_DETECTION_PROFILE);
    if (codeBlockResult.isRepetitive) {
      return codeBlockResult;
    }

    // Layer 4: KMP token 循环模式（ABABAB 级 token 循环）
    if (!insideMarkdownFence && this.isRepetitivePattern(this.nonThinkStreamTokens)) {
      return {
        isRepetitive: true,
        pattern: '检测到重复输出模式',
        suggestion: '模型可能陷入了重复输出循环。'
      };
    }

    // Layer 5: 连续行重复（相同行连续出现多次）
    const lineResult = this.checkConsecutiveLineRepetition(this.PROSE_DETECTION_PROFILE);
    if (lineResult.isRepetitive) {
      return lineResult;
    }

    return { isRepetitive: false, thinkTransition: this.lastThinkTransition ?? undefined, sizeWarning };
  }

  // -------------------- Layer 1: 短语连续重复 --------------------

  /**
   * 检测文本末尾的连续重复模式
   * 用于检测 "ABCABCABC" 这种纯粹的连续重复
   */
  private checkPhraseRepetition(): RepetitionCheckResult {
    return this.checkPhraseRepetitionOn(this.nonThinkStreamTokens, this.PROSE_DETECTION_PROFILE, this.getNonThinkText());
  }

  /**
   * 在指定 token 数组上检测短语连续重复
   * 供主缓冲区和 think 缓冲区复用
   */
  private checkPhraseRepetitionOn(tokens: string[], profile: NarrativeDetectionProfile, precomputedText?: string): RepetitionCheckResult {
    const text = precomputedText ?? tokens.join('');
    const analyzableText = this.extractNarrativeText(text);

    if (analyzableText.length < profile.phraseMinTextLength) {
      return { isRepetitive: false };
    }

    const checkLength = Math.min(analyzableText.length, 200);
    const checkText = analyzableText.slice(-checkLength);

    // 检测不同长度的连续重复模式
    for (let patternLen = 3; patternLen <= Math.min(50, Math.floor(checkText.length / 3)); patternLen++) {
      const result = this.findConsecutiveRepetition(checkText, patternLen, profile);
      if (result) {
        return result;
      }
    }

    return { isRepetitive: false };
  }

  /**
   * 查找末尾连续重复的模式
   */
  private findConsecutiveRepetition(
    text: string,
    patternLen: number,
    profile: NarrativeDetectionProfile
  ): RepetitionCheckResult | null {
    if (text.length < patternLen * 3) {
      return null;
    }

    const pattern = text.slice(-patternLen);

    // 跳过纯空白
    if (pattern.trim().length < 2) {
      return null;
    }

    // 跳过纯数字序号
    if (/^\d+\.\s*$/.test(pattern.trim())) {
      return null;
    }

    // 跳过由格式化分隔字符组成的模式（如 "===", "---", "***", "###"）
    if (/^[=\-*#_~.:]+$/.test(pattern)) {
      return null;
    }

    // 跳过代码/格式化模式，避免 fenced code、JSON 片段等正常输出误报
    if (this.isLikelyCodeLikeText(pattern) || this.isLikelyStructuralMarkdown(pattern)) {
      return null;
    }

    // 从末尾往前计数连续重复
    let consecutiveCount = 0;
    let pos = text.length;

    while (pos >= patternLen) {
      const segment = text.slice(pos - patternLen, pos);
      if (segment === pattern) {
        consecutiveCount++;
        pos -= patternLen;
      } else {
        break;
      }
    }

    // 根据模式长度调整阈值
    let threshold: number;
    if (patternLen <= 5) {
      threshold = profile.lineShortThreshold;
    } else if (patternLen <= 10) {
      threshold = profile.lineMediumThreshold;
    } else if (patternLen <= 20) {
      threshold = profile.lineLongThreshold;
    } else {
      threshold = profile.lineLongThreshold;
    }

    if (consecutiveCount >= threshold) {
      const displayPattern = pattern.length > 20
        ? pattern.substring(0, 20) + '...'
        : pattern;
      return {
        isRepetitive: true,
        pattern: `"${displayPattern}" 连续重复 ${consecutiveCount} 次`,
        suggestion: '检测到相同内容的连续重复输出。'
      };
    }

    return null;
  }

  /**
   * 检测垃圾 token 重复（全局）
   * 包括纯空白字符重复（\t\t\t...）、控制字符+符号的短模式重复（\t}\t}...、}\r}\r...）
   * 即使在正常输出中，高频重复的空白/控制字符也是模型卡顿信号
   */
  private checkJunkTokenRepetition(tokens: string[], precomputedText?: string): RepetitionCheckResult {
    const text = precomputedText ?? tokens.join('');

    if (text.length < 15) {
      return { isRepetitive: false };
    }

    const checkLength = Math.min(text.length, 200);
    const checkText = text.slice(-checkLength);

    // 检测 1-5 字符的短模式重复（仅限包含空白/控制字符的模式）
    for (let patternLen = 1; patternLen <= Math.min(5, Math.floor(checkText.length / 5)); patternLen++) {
      const pattern = checkText.slice(-patternLen);

      // Layer 0 只处理包含空白/控制字符的模式（\t、\r、\n、空格等）
      // 纯可打印字符（如 ===、---）交给 Layer 1 处理
      if (!/[\x00-\x20]/.test(pattern)) {
        continue;
      }

      let consecutiveCount = 0;
      let pos = checkText.length;

      while (pos >= patternLen) {
        if (checkText.slice(pos - patternLen, pos) === pattern) {
          consecutiveCount++;
          pos -= patternLen;
        } else {
          break;
        }
      }

      // 阈值根据模式长度调整
      let threshold: number;
      if (patternLen === 1) {
        threshold = 50; // 50 个相同字符（如 \t\t\t...）
      } else if (patternLen === 2) {
        threshold = 25;  // 25 次 2 字符模式（如 \t}\t}...）
      } else {
        threshold = 10;  // 10 次 3-5 字符模式
      }

      if (consecutiveCount >= threshold) {
        // 将控制字符转义为可读形式
        const displayPattern = JSON.stringify(pattern).slice(1, -1);
        return {
          isRepetitive: true,
          pattern: `垃圾 token 重复: "${displayPattern}" × ${consecutiveCount}`,
          suggestion: '模型可能陷入了无意义的输出循环。'
        };
      }
    }

    return { isRepetitive: false };
  }

  // -------------------- Layer 2: 句子级连续重复 --------------------

  /**
   * 将文本按句子边界拆分
   * 句子边界：中文句号、问号、感叹号、英文句号+空格、换行
   * 不拆分：英文小数点、URL中的点、缩写中的点
   */
  private splitIntoSentences(text: string): string[] {
    // 先去除 <think>...</think> 标签内容（思考过程不参与比较）
    const cleanText = this.extractNarrativeText(text.replace(/<think>[\s\S]*?<\/think>/g, '\n'));

    return cleanText
      .split(/(?:[。？！\n]|(?:\.\s))+/)
      .map(s => s.trim())
      .filter(s => s.length >= 8)
      .filter(s => !this.isLikelyCodeLikeText(s)); // 只保留叙述性句子
  }

  /**
   * 归一化句子用于比较
   * 去除多余空白、统一标点，使微小排版差异不影响比较
   */
  private normalizeSentence(sentence: string): string {
    return sentence
      .replace(/\s+/g, ' ')  // 多空白 → 单空格
      .replace(/[，,]/g, ',')  // 统一逗号
      .replace(/[：:]/g, ':')  // 统一冒号
      .trim()
      .toLowerCase();
  }

  /**
   * 检测末尾是否有连续相同的句子
   * 例如："请问有什么帮助？请问有什么帮助？请问有什么帮助？" → 3 次连续
   */
  private checkConsecutiveSentenceRepetition(profile: NarrativeDetectionProfile): RepetitionCheckResult {
    return this.checkConsecutiveSentenceRepetitionOn(this.streamTokens, profile, this.getStreamText());
  }

  /**
   * 在指定 token 数组上检测句子级连续重复
   * 供主缓冲区和 think 缓冲区复用
   */
  private checkConsecutiveSentenceRepetitionOn(
    tokens: string[],
    profile: NarrativeDetectionProfile = this.PROSE_DETECTION_PROFILE,
    precomputedText?: string
  ): RepetitionCheckResult {
    const text = precomputedText ?? tokens.join('');

    if (text.length < profile.sentenceMinTextLength) {
      return { isRepetitive: false };
    }

    const sentences = this.splitIntoSentences(text);

    if (sentences.length < 3) {
      return { isRepetitive: false };
    }

    // 从末尾往前检测连续相同的句子
    const lastNormalized = this.normalizeSentence(sentences[sentences.length - 1]);

    let consecutiveCount = 1;
    for (let i = sentences.length - 2; i >= 0; i--) {
      if (this.normalizeSentence(sentences[i]) === lastNormalized) {
        consecutiveCount++;
      } else {
        break;
      }
    }

    if (consecutiveCount >= profile.sentenceRepeatThreshold) {
      const displaySentence = sentences[sentences.length - 1].length > 30
        ? sentences[sentences.length - 1].substring(0, 30) + '...'
        : sentences[sentences.length - 1];
      return {
        isRepetitive: true,
        pattern: `相同句子连续出现 ${consecutiveCount} 次: "${displaySentence}"`,
        suggestion: '检测到相同内容的连续重复输出。'
      };
    }

    return { isRepetitive: false };
  }

  // -------------------- Layer 2.5: 段落块循环重复 --------------------

  /**
   * 检测段落块循环重复
   * 主缓冲区入口，委托给参数化版本
   */
  private checkParagraphCycleRepetition(profile: NarrativeDetectionProfile): RepetitionCheckResult {
    return this.checkParagraphCycleRepetitionOn(this.streamTokens, profile, this.getStreamText());
  }

  /**
   * 在指定 token 数组上检测段落块循环重复
   * 场景：模型反复输出相同的 N 句话组成的段落（ABCDABCDABCD...）
   * 与 Layer 2 不同点：Layer 2 检测单句重复（AAAA），本层检测多句组成的块整体重复
   */
  private checkParagraphCycleRepetitionOn(
    tokens: string[],
    profile: NarrativeDetectionProfile = this.PROSE_DETECTION_PROFILE,
    precomputedText?: string
  ): RepetitionCheckResult {
    const text = this.extractNarrativeText(precomputedText ?? tokens.join(''));

    // 段落块至少需要足够长的文本（3 次重复 × 至少 2 句 × 平均 30 字 ≈ 180 字符）
    if (text.length < profile.paragraphMinTextLength) {
      return { isRepetitive: false };
    }

    const sentences = this.splitIntoSentences(text);

    // 至少需要 6 个句子（最小 blockSize=2 × 3 次重复）
    if (sentences.length < profile.paragraphMinSentenceCount) {
      return { isRepetitive: false };
    }

    const normalized = sentences.map(s => this.normalizeSentence(s));

    // 尝试不同的块大小（2~20 句为一个块）
    const maxBlockSize = Math.min(20, Math.floor(normalized.length / 3));

    for (let blockSize = 2; blockSize <= maxBlockSize; blockSize++) {
      // 取末尾 blockSize 个句子作为模式块
      const patternBlock = normalized.slice(-blockSize);

      // 从末尾往前匹配完整的块
      let matchCount = 1; // 模式块本身算 1 次
      let pos = normalized.length - blockSize;

      while (pos >= blockSize) {
        const candidate = normalized.slice(pos - blockSize, pos);
        let isMatch = true;
        for (let i = 0; i < blockSize; i++) {
          if (candidate[i] !== patternBlock[i]) {
            isMatch = false;
            break;
          }
        }
        if (isMatch) {
          matchCount++;
          pos -= blockSize;
        } else {
          break;
        }
      }

      // 块重复 3 次以上即触发
      if (matchCount >= profile.paragraphRepeatThreshold) {
        const displaySentence = sentences[sentences.length - blockSize].length > 30
          ? sentences[sentences.length - blockSize].substring(0, 30) + '...'
          : sentences[sentences.length - blockSize];
        return {
          isRepetitive: true,
          pattern: `${blockSize} 句段落块连续循环 ${matchCount} 次: "${displaySentence}"...`,
          suggestion: '检测到相同段落的循环重复输出。'
        };
      }
    }

    return { isRepetitive: false };
  }

  // -------------------- Layer 2.75: 句子频率重复 --------------------

  /**
   * 检测同一句子在缓冲区中出现过多次数（非连续）
   * 场景：模型在 think 中反复输出包含相同句子的段落，但每次周围上下文略有不同
   * 与 Layer 2 不同点：Layer 2 检测连续相同句子（AAA），本层检测散布在不同位置的相同句子
   */
  private checkSentenceFrequencyRepetition(
    tokens: string[],
    profile: NarrativeDetectionProfile,
    precomputedText?: string
  ): RepetitionCheckResult {
    const text = this.extractNarrativeText(precomputedText ?? tokens.join(''));
    const sentences = this.splitIntoSentences(text);

    // 至少需要足够的句子才有统计意义
    const frequencyThreshold = profile.paragraphRepeatThreshold + 1; // think=4, prose=4
    if (sentences.length < frequencyThreshold * 2) {
      return { isRepetitive: false };
    }

    const frequency = new Map<string, number>();
    for (const s of sentences) {
      const norm = this.normalizeSentence(s);
      // 跳过过短的句子（避免常见短语误报如"好的"、"让我继续"）
      if (norm.length < 15) {
        continue;
      }
      frequency.set(norm, (frequency.get(norm) || 0) + 1);
    }

    for (const [sentence, count] of frequency) {
      if (count >= frequencyThreshold) {
        const display = sentence.length > 30 ? sentence.substring(0, 30) + '...' : sentence;
        return {
          isRepetitive: true,
          pattern: `相同句子出现 ${count} 次: "${display}"`,
          suggestion: '检测到同一内容在不同位置反复出现。'
        };
      }
    }

    return { isRepetitive: false };
  }

  // -------------------- Layer 3: 跨边界块级重复 --------------------

  /**
   * 标记内容边界
   * 当遇到 tool_call、<think> 开始或 </think> 结束时调用
   *
   * - 'tool_call': 工具调用边界，保存之前的输出内容为一个块
   * - 'think_start': <think> 开始，保存之前的输出内容为一个块
   * - 'think_end': </think> 结束，不保存内容（think 内容丢弃），只更新索引
   */
  markBoundary(type: 'tool_call' | 'think_start' | 'think_end' = 'tool_call'): void {
    if (type === 'think_end') {
      // think 内容不保存为内容块，只更新边界位置
      this.lastBoundaryTokenIndex = this.streamTokens.length;
      return;
    }

    if (type === 'think_start') {
      // think 开始：保存之前的输出内容为一个块，然后更新边界
    }

    // 提取上次边界到现在的增量 token
    const deltaTokens = this.streamTokens.slice(this.lastBoundaryTokenIndex);
    const deltaText = deltaTokens.join('').trim();

    // 去除可能残留的 think 标签内容
    const cleanText = deltaText
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*/g, '')  // 去除未关闭的 think 标签
      .replace(/[\s\S]*<\/think>/g, '') // 去除只有关闭标签的情况
      .trim();

    if (cleanText.length >= this.MIN_BLOCK_LENGTH) {
      this.contentBlocks.push(cleanText);

      if (this.contentBlocks.length > 10) {
        this.contentBlocks = this.contentBlocks.slice(-10);
      }
    }

    // 更新边界位置
    this.lastBoundaryTokenIndex = this.streamTokens.length;
  }

  /**
   * 计算两个文本的相似度（基于最长公共子序列 LCS）
   * 返回 0-1 之间的值，1 = 完全相同
   */
  private computeSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    // 归一化后先做快速比较
    const na = this.normalizeSentence(a);
    const nb = this.normalizeSentence(b);
    if (na === nb) return 1;

    const ngramSize = Math.max(3, Math.min(6, Math.floor(Math.min(na.length, nb.length) / 8) || 3));
    const gramsA = this.buildCharacterNgrams(na, ngramSize);
    const gramsB = this.buildCharacterNgrams(nb, ngramSize);
    if (gramsA.size === 0 || gramsB.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const gram of gramsA) {
      if (gramsB.has(gram)) {
        intersection++;
      }
    }

    const dice = (2 * intersection) / (gramsA.size + gramsB.size);
    const lengthRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    return dice * (0.6 + 0.4 * lengthRatio);
  }

  private buildCharacterNgrams(text: string, ngramSize: number): Set<string> {
    if (text.length <= ngramSize) {
      return new Set([text]);
    }

    const grams = new Set<string>();
    for (let i = 0; i <= text.length - ngramSize; i++) {
      grams.add(text.slice(i, i + ngramSize));
    }
    return grams;
  }

  /**
   * 检测跨边界的内容块重复
   * 当大模型在 think/tool_call 前后输出相同内容时触发
   */
  private checkBlockRepetition(profile: NarrativeDetectionProfile): RepetitionCheckResult {
    if (this.contentBlocks.length < 2) {
      return { isRepetitive: false };
    }

    // 获取当前正在输出的增量文本（上次边界以来的新内容）
    const deltaTokens = this.streamTokens.slice(this.lastBoundaryTokenIndex);
    const currentDelta = deltaTokens.join('')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();

    if (currentDelta.length < this.MIN_BLOCK_LENGTH) {
      return { isRepetitive: false };
    }

    // 从最近的块往前比较，计算连续相似块数
    let consecutiveSimilar = 0;
    for (let i = this.contentBlocks.length - 1; i >= 0; i--) {
      // 动态阈值：短块需要更高相似度才触发，减少短文本误报
      const blockLen = Math.min(currentDelta.length, this.contentBlocks[i].length);
      const dynamicThreshold = Math.min(0.95, profile.blockSimilarityThreshold + 0.1 * (this.MIN_BLOCK_LENGTH / blockLen));
      const similarity = this.computeSimilarity(currentDelta, this.contentBlocks[i]);
      if (similarity >= dynamicThreshold) {
        consecutiveSimilar++;
      } else {
        break; // 不连续了
      }
    }

    // 加上当前块自身 → 连续相似块总数
    const totalSimilar = consecutiveSimilar + 1;

    if (totalSimilar >= profile.blockRepeatThreshold) {
      const displayText = currentDelta.length > 50
        ? currentDelta.substring(0, 50) + '...'
        : currentDelta;
      return {
        isRepetitive: true,
        pattern: `相同内容块跨边界连续出现 ${totalSimilar} 次: "${displayText}"`,
        suggestion: '检测到跨工具调用/思考过程的重复输出。'
      };
    }

    return { isRepetitive: false };
  }
  
  private checkCodeBlockRepetition(
    text: string,
    profile: CodeBlockDetectionProfile = this.CODE_BLOCK_DETECTION_PROFILE
  ): RepetitionCheckResult {
    const codeFenceState = this.extractCodeFenceState(text);

    const completedBlocksResult = this.checkCompletedCodeBlockRepetition(codeFenceState.completedBlocks, profile);
    if (completedBlocksResult.isRepetitive) {
      return completedBlocksResult;
    }

    if (codeFenceState.activeBlock) {
      return this.checkActiveCodeBlockRepetition(codeFenceState.activeBlock, profile);
    }

    return { isRepetitive: false };
  }

  private extractCodeFenceState(text: string): { completedBlocks: string[]; activeBlock: string | null } {
    const completedBlocks: string[] = [];
    const fenceRegex = /```[^\n]*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = fenceRegex.exec(text)) !== null) {
      const body = match[1].trim();
      if (body) {
        completedBlocks.push(body);
      }
    }

    const fenceCount = (text.match(/```/g) || []).length;
    if (fenceCount % 2 === 0) {
      return { completedBlocks, activeBlock: null };
    }

    const lastFenceIndex = text.lastIndexOf('```');
    const afterFence = text.slice(lastFenceIndex + 3);
    const firstNewlineIndex = afterFence.indexOf('\n');
    const activeBlock = (firstNewlineIndex >= 0 ? afterFence.slice(firstNewlineIndex + 1) : '').trim();

    return {
      completedBlocks,
      activeBlock: activeBlock || null,
    };
  }

  private checkCompletedCodeBlockRepetition(
    blocks: readonly string[],
    profile: CodeBlockDetectionProfile
  ): RepetitionCheckResult {
    if (blocks.length < profile.completedBlockRepeatThreshold) {
      return { isRepetitive: false };
    }

    const lastBlock = this.normalizeCodeBlock(blocks[blocks.length - 1]);
    if (lastBlock.length < profile.completedBlockMinLength) {
      return { isRepetitive: false };
    }

    let repeatedCount = 1;
    for (let i = blocks.length - 2; i >= 0; i--) {
      const candidate = this.normalizeCodeBlock(blocks[i]);
      if (this.computeSimilarity(lastBlock, candidate) >= profile.completedBlockSimilarityThreshold) {
        repeatedCount++;
      } else {
        break;
      }
    }

    if (repeatedCount >= profile.completedBlockRepeatThreshold) {
      const display = lastBlock.length > 40 ? `${lastBlock.slice(0, 40)}...` : lastBlock;
      return {
        isRepetitive: true,
        pattern: `相同代码块连续出现 ${repeatedCount} 次: "${display}"`,
        suggestion: '检测到代码块被反复输出，模型可能陷入代码生成循环。'
      };
    }

    return { isRepetitive: false };
  }

  private checkActiveCodeBlockRepetition(
    activeBlock: string,
    profile: CodeBlockDetectionProfile
  ): RepetitionCheckResult {
    const lines = activeBlock
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.trim().length > 0);

    if (lines.length < 4) {
      return { isRepetitive: false };
    }

    const lastLine = lines[lines.length - 1].trim();
    if (lastLine.length < profile.activeLineMinLength) {
      return { isRepetitive: false };
    }

    let repeatedLineCount = 1;
    for (let i = lines.length - 2; i >= 0; i--) {
      if (lines[i].trim() === lastLine) {
        repeatedLineCount++;
      } else {
        break;
      }
    }

    if (repeatedLineCount >= profile.activeLineRepeatThreshold) {
      const display = lastLine.length > 40 ? `${lastLine.slice(0, 40)}...` : lastLine;
      return {
        isRepetitive: true,
        pattern: `代码行 "${display}" 连续重复 ${repeatedLineCount} 次`,
        suggestion: '检测到代码块内相同行连续刷屏，模型可能卡在局部生成循环。'
      };
    }

    if (lines.length >= 6) {
      const repeatedChunk = this.findRepeatedCodeChunk(lines, profile);
      if (repeatedChunk) {
        return repeatedChunk;
      }
    }

    return { isRepetitive: false };
  }

  private findRepeatedCodeChunk(
    lines: readonly string[],
    profile: CodeBlockDetectionProfile
  ): RepetitionCheckResult | null {
    const maxChunkSize = Math.min(profile.activeChunkMaxSize, Math.floor(lines.length / 3));

    for (let chunkSize = 2; chunkSize <= maxChunkSize; chunkSize++) {
      const patternChunk = lines.slice(lines.length - chunkSize).map(line => line.trim());
      if (patternChunk.join('').length < profile.activeChunkMinCombinedLength) {
        continue;
      }

      let repeatCount = 1;
      let pos = lines.length - chunkSize;
      while (pos >= chunkSize) {
        const candidate = lines.slice(pos - chunkSize, pos).map(line => line.trim());
        if (candidate.every((line, index) => line === patternChunk[index])) {
          repeatCount++;
          pos -= chunkSize;
        } else {
          break;
        }
      }

      if (repeatCount >= profile.activeChunkRepeatThreshold) {
        const display = patternChunk[0].length > 40 ? `${patternChunk[0].slice(0, 40)}...` : patternChunk[0];
        return {
          isRepetitive: true,
          pattern: `${chunkSize} 行代码块连续循环 ${repeatCount} 次: "${display}"`,
          suggestion: '检测到代码块内小段代码重复刷屏，模型可能陷入循环。'
        };
      }
    }

    return null;
  }

  private normalizeCodeBlock(block: string): string {
    return block
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.trim().length > 0)
      .join('\n');
  }

  // -------------------- Layer 4: KMP token 循环模式 --------------------

  /**
   * 使用 KMP 前缀函数检测 token 序列循环模式
   */
  private isRepetitivePattern(tokens: readonly string[]): boolean {
    const tokensBackwards = tokens.slice().reverse();

    return (
      this.checkKMPPattern(tokensBackwards) ||
      this.checkKMPPattern(tokensBackwards.filter(t => t.trim().length > 0))
    );
  }

  private checkKMPPattern<T>(s: ArrayLike<T>): boolean {
    const prefix = this.kmpPrefixFunction(s);

    for (const config of STREAM_REPETITION_CONFIGS) {
      if (s.length < config.lastTokensToConsider) {
        continue;
      }

      const patternLength = config.lastTokensToConsider - 1 - prefix[config.lastTokensToConsider - 1];
      if (patternLength <= config.maxTokenSequenceLength) {
        return true;
      }
    }

    return false;
  }

  private kmpPrefixFunction<T>(s: ArrayLike<T>): number[] {
    const pi = Array(s.length).fill(0);
    pi[0] = -1;
    let k = -1;

    for (let q = 1; q < s.length; q++) {
      while (k >= 0 && s[k + 1] !== s[q]) {
        k = pi[k];
      }
      if (s[k + 1] === s[q]) {
        k++;
      }
      pi[q] = k;
    }

    return pi;
  }

  // -------------------- Layer 5: 连续行重复 --------------------

  /**
   * 检测末尾连续相同的行
   */
  private checkConsecutiveLineRepetition(
    profile: NarrativeDetectionProfile = this.PROSE_DETECTION_PROFILE
  ): RepetitionCheckResult {
    const text = this.getNonThinkText();
    const lines = this.extractMeaningfulLines(text);

    if (lines.length < 4) {
      return { isRepetitive: false };
    }

    const lastLine = lines[lines.length - 1].trim();

    // 跳过太短的行
    if (lastLine.length < 10) {
      return { isRepetitive: false };
    }

    if (this.isLikelyCodeLikeText(lastLine) || this.isLikelyStructuralMarkdown(lastLine)) {
      return { isRepetitive: false };
    }

    // 计算末尾连续相同行数
    let consecutiveCount = 1;
    for (let i = lines.length - 2; i >= 0; i--) {
      if (lines[i].trim() === lastLine) {
        consecutiveCount++;
      } else {
        break;
      }
    }

    // 阈值根据行长度调整
    let threshold: number;
    if (lastLine.length < 20) {
      threshold = profile.lineShortThreshold;
    } else if (lastLine.length < 50) {
      threshold = profile.lineMediumThreshold;
    } else {
      threshold = profile.lineLongThreshold;
    }

    if (consecutiveCount >= threshold) {
      const displayLine = lastLine.length > 30
        ? lastLine.substring(0, 30) + '...'
        : lastLine;
      return {
        isRepetitive: true,
        pattern: `行 "${displayLine}" 连续重复 ${consecutiveCount} 次`,
        suggestion: '检测到相同行的连续重复输出。'
      };
    }

    return { isRepetitive: false };
  }

  private extractNarrativeText(text: string): string {
    const lines = text.split('\n');
    const keptLines: string[] = [];
    let insideFence = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('```')) {
        insideFence = !insideFence;
        continue;
      }

      if (insideFence) {
        continue;
      }

      if (this.isLikelyStructuralMarkdown(trimmed)) {
        continue;
      }

      keptLines.push(line);
    }

    return keptLines.join('\n');
  }

  private extractMeaningfulLines(text: string): string[] {
    const lines = text.split('\n');
    const keptLines: string[] = [];
    let insideFence = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith('```')) {
        insideFence = !insideFence;
        continue;
      }

      if (insideFence) {
        continue;
      }

      if (this.isLikelyStructuralMarkdown(trimmed)) {
        continue;
      }

      keptLines.push(line);
    }

    return keptLines;
  }

  private isInsideMarkdownCodeFence(_text: string): boolean {
    if (this._fenceCount === -1) {
      // trim 后重建
      const matches = this.getNonThinkText().match(/```/g);
      this._fenceCount = matches ? matches.length : 0;
    }
    return this._fenceCount % 2 === 1;
  }

  private isLikelyStructuralMarkdown(text: string): boolean {
    return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|.*\||```|aily-(state|button|error|task-action))/.test(text);
  }

  private isLikelyCodeLikeText(text: string): boolean {
    if (!text) {
      return false;
    }

    if (/^[{}()[\];,.:<>=+\-/*|&!\s`"']+$/.test(text)) {
      return true;
    }

    if (/(const |let |var |function |class |return |if\s*\(|for\s*\(|while\s*\(|=>|;\s*$|\{\s*$|\}\s*$)/.test(text)) {
      return true;
    }

    const punctuationMatches = text.match(/[{}()[\];<>/=]/g) || [];
    return punctuationMatches.length >= Math.max(4, Math.floor(text.length / 5));
  }

  // ==================== 状态管理 ====================

  /**
   * 重置工具调用历史
   */
  resetToolCallHistory(): void {
    this.toolCallHistory = [];
  }

  /**
   * 重置流式 token 缓存
   * 在新用户消息开始时调用
   */
  resetStreamTokens(): void {
    this.streamTokens = [];
    this._cachedStreamText = null;
    this.nonThinkStreamTokens = [];
    this._cachedNonThinkText = null;
    this._fenceCount = 0;
    this.thinkTokens = [];
    this._cachedThinkText = null;
    this.contentBlocks = [];
    this.toolCallHistory = [];
    this.tagBuffer = '';
    this.lastBoundaryTokenIndex = 0;
    this.insideThink = false;
    this.lastThinkTransition = null;
    this.totalStreamBytes = 0;
    this.nextSizeWarningBytes = this.SIZE_WARNING_INTERVAL_BYTES;
  }

  /**
   * 重置所有状态
   * 在新会话开始时调用
   */
  resetAll(): void {
    this.resetStreamTokens();
  }

  /**
   * 获取当前工具调用历史（用于调试）
   */
  getToolCallHistory(): ToolCallRecord[] {
    return [...this.toolCallHistory];
  }

  /**
   * 获取当前累积的 token 数量（用于调试）
   */
  getStreamTokenCount(): number {
    return this.streamTokens.length;
  }

  /**
   * 获取当前内容块数量（用于调试）
   */
  getContentBlockCount(): number {
    return this.contentBlocks.length;
  }
}
