/**
 * 声明式优先级裁剪引擎（轻量版 Copilot PrioritizedList）
 *
 * 参考 Copilot prompt-tsx 的 PrioritizedList 组件：
 *   - 每个内容项声明 priority（0-1000）和 token 数
 *   - 超出预算时从低优先级开始淘汰
 *   - 支持 "组" 概念（整组一起淘汰，对应 Turn 不可拆分）
 *   - 保证输出顺序与输入顺序一致
 *
 * 解决的核心问题：
 *   将 "什么优先级" 的声明与 "怎么裁剪" 的执行解耦。
 *   调用方只需标注每条消息/Turn 的优先级，引擎自动做预算裁剪。
 *
 * 与 Copilot 的差异：
 *   - Copilot 用 TSX 声明优先级，渲染器内部做裁剪
 *   - 我们用数据结构声明优先级，引擎做裁剪
 *   - 本质相同：Budget-first，声明式，自动淘汰
 */

import { fastEstimateMessageTokens, fastEstimateMessagesTokens } from './prompt-providers';

// ==================== 类型定义 ====================

/**
 * 优先级项 — 参与裁剪的最小单元
 *
 * 对应 Copilot 的 PromptElement：
 *   priority → 淘汰排名（越大越不容易被淘汰）
 *   tokens  → 占用的 token 数
 *   messages → 对应的消息数组（Turn 内的所有消息，或单条消息）
 */
export interface PrioritizedItem {
  /** 唯一标识（通常为 turnId 或 messageIndex） */
  id: string;
  /** 优先级（0-1000，仿照 Copilot prompt-tsx 的 z-index 风格） */
  priority: number;
  /** 该项占用的 token 数（预计算） */
  tokens: number;
  /** 对应的消息数组（整组一起保留或淘汰） */
  messages: any[];
  /** 原始排序索引（用于保证输出顺序） */
  originalIndex: number;
  /**
   * 弹性增长系数（参考 Copilot prompt-tsx 的 flexGrow）
   *
   * 当预算有剩余时，按 flexGrow 比例从剩余预算中分配额外空间。
   * 默认 0 = 不参与弹性分配。
   * 值越大，分得的剩余预算越多。
   *
   * 用途：信息类工具结果（read_file/fetch）设置 flexGrow=1，
   * 获得更多空间保留完整内容，操作类工具保持 0。
   */
  flexGrow?: number;
  /**
   * 弹性预留 token 数（参考 Copilot flexReserve）
   *
   * 保证该项至少获得 flexReserve 个 token 的预算，
   * 在 flexGrow 分配之前优先满足。
   */
  flexReserve?: number;
  /**
   * 最大可扩展 token 数（配合 flexGrow 使用）
   * 限制弹性增长的上限，防止单个消息独占剩余预算。
   */
  flexMax?: number;
}

/**
 * 裁剪结果
 */
export interface PrioritizedTrimResult {
  /** 保留的消息数组（按原始顺序） */
  messages: any[];
  /** 保留的总 token 数 */
  totalTokens: number;
  /** 被淘汰的项数 */
  evictedCount: number;
  /** 被淘汰的 token 数 */
  evictedTokens: number;
  /** flexGrow 分配的额外 token 预算（id → 额外 token 数） */
  flexBudgets?: Map<string, number>;
}

// ==================== 优先级常量（参考 Copilot prompt-tsx） ====================

/**
 * 消息优先级常量
 *
 * 参考 Copilot 的 priority 设计：
 *   SystemMessage:       1000（最高，永远保留）
 *   UserMessage(latest):  900（当前轮次用户消息）
 *   ChatToolCalls:        899（当前轮次工具调用）
 *   HistoryMessages:      700（历史对话）
 *   FileContext:           70（附件上下文）
 *   SummaryMessage:       800（摘要替换旧历史）
 */
export const MessagePriority = {
  /** 系统消息 — 永远保留 */
  SYSTEM: 1000,
  /** 当前 Turn 的用户消息 — 最高对话优先级 */
  CURRENT_USER: 900,
  /** 当前 Turn 的工具调用 & 结果 — 紧随用户消息 */
  CURRENT_TURN: 899,
  /** 摘要消息 — 替换旧历史，必须保留 */
  SUMMARY: 800,
  /** 历史中包含信息类工具的 Turn（read_file/fetch/grep） */
  HISTORY_INFO: 750,
  /** 普通历史 Turn */
  HISTORY_BASE: 700,
  /** 最旧的历史（渐进衰减基准） */
  HISTORY_OLDEST: 100,
} as const;

// ==================== 核心引擎 ====================

/**
 * 声明式优先级裁剪引擎
 *
 * 使用方式：
 * ```typescript
 * const engine = new PrioritizedListEngine(tokenBudget);
 * const items = annotateMessages(messages, turnSpans); // 声明优先级
 * const result = engine.trim(items);                    // 自动裁剪
 * ```
 */
export class PrioritizedListEngine {

  constructor(
    /** 可用的 token 预算（已扣除 system/tools/context/output reserve） */
    private readonly tokenBudget: number
  ) {}

  /**
   * 执行优先级裁剪
   *
   * 算法（参考 Copilot PrioritizedList）：
   *   1. 按 priority 升序排列（低优先级在前）
   *   2. 从最低优先级开始淘汰，直到总 token ≤ budget
   *   3. 按 originalIndex 恢复输出顺序
   *
   * @param items 已标注优先级的项列表
   * @returns 裁剪结果
   */
  trim(items: PrioritizedItem[]): PrioritizedTrimResult {
    if (items.length === 0) {
      return { messages: [], totalTokens: 0, evictedCount: 0, evictedTokens: 0 };
    }

    // 计算当前总 token
    let totalTokens = items.reduce((sum, item) => sum + item.tokens, 0);

    // 不超预算，全量保留（仍计算 flexBudgets 供调用方了解剩余空间分配）
    if (totalTokens <= this.tokenBudget) {
      const messages = items
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .flatMap(item => item.messages);
      const flexBudgets = this.allocateFlexBudgets(items, this.tokenBudget - totalTokens);
      return { messages, totalTokens, evictedCount: 0, evictedTokens: 0, flexBudgets };
    }

    // 按 priority 升序排列（低优先级先淘汰）
    // 同优先级内按 originalIndex 升序（更旧的先淘汰）
    const sorted = [...items].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.originalIndex - b.originalIndex;
    });

    // 从低优先级开始淘汰
    const evictedIds = new Set<string>();
    let evictedTokens = 0;

    for (const item of sorted) {
      if (totalTokens <= this.tokenBudget) break;
      evictedIds.add(item.id);
      totalTokens -= item.tokens;
      evictedTokens += item.tokens;
    }

    // 按 originalIndex 恢复顺序，过滤掉被淘汰的
    const kept = items
      .filter(item => !evictedIds.has(item.id))
      .sort((a, b) => a.originalIndex - b.originalIndex);

    const messages = kept.flatMap(item => item.messages);

    // P9: flexGrow 弹性分配 — 将剩余预算按比例分配给有 flexGrow 的保留项
    const remainingBudget = Math.max(0, this.tokenBudget - totalTokens);
    const flexBudgets = this.allocateFlexBudgets(kept, remainingBudget);

    return {
      messages,
      totalTokens,
      evictedCount: evictedIds.size,
      evictedTokens,
      flexBudgets,
    };
  }

  /**
   * 按 flexGrow 比例分配剩余预算
   *
   * 参考 Copilot prompt-tsx 的 flexGrow 机制：
   *   - 所有有 flexGrow > 0 的项参与分配
   *   - 按 flexGrow 值的比例分配剩余 token 预算
   *   - 单项分配不超过 flexMax（防止独占）
   *
   * @param items 保留的项
   * @param remainingBudget 剩余可分配的 token 数
   * @returns id → 额外分配的 token 数
   */
  private allocateFlexBudgets(items: PrioritizedItem[], remainingBudget: number): Map<string, number> {
    const budgets = new Map<string, number>();
    if (remainingBudget <= 0) return budgets;

    let available = remainingBudget;

    // C2: 先保证 flexReserve 最低预留（参考 Copilot flexReserve 语义）
    const reserveItems = items.filter(item => (item.flexReserve ?? 0) > 0);
    for (const item of reserveItems) {
      const reserve = Math.min(item.flexReserve!, available);
      if (reserve > 0) {
        budgets.set(item.id, reserve);
        available -= reserve;
      }
    }
    if (available <= 0) return budgets;

    // 再按 flexGrow 比例分配剩余
    const flexItems = items.filter(item => (item.flexGrow ?? 0) > 0);
    if (flexItems.length === 0) return budgets;

    const totalFlexGrow = flexItems.reduce((sum, item) => sum + (item.flexGrow ?? 0), 0);

    for (const item of flexItems) {
      const share = Math.floor(available * (item.flexGrow! / totalFlexGrow));
      const capped = item.flexMax !== undefined ? Math.min(share, item.flexMax) : share;
      if (capped > 0) {
        const existing = budgets.get(item.id) ?? 0;
        budgets.set(item.id, existing + capped);
      }
    }

    return budgets;
  }
}

// ==================== 消息标注工具 ====================

/**
 * 标注消息优先级（Turn-aware）
 *
 * 将消息数组 + TurnSpan 边界转换为 PrioritizedItem[]，
 * 每个 Turn 作为一个不可分割的优先级项。
 *
 * 优先级分配策略（参考 Copilot）：
 *   - 最新 Turn（末尾）→ CURRENT_TURN (899)
 *   - 包含摘要的 Turn → SUMMARY (800)
 *   - 历史 Turn 按时间渐进衰减：
 *     HISTORY_INFO (750) / HISTORY_BASE (700) → HISTORY_OLDEST (100)
 *     越旧 priority 越低，使用线性插值
 *   - 含信息类工具的 Turn 额外加分
 *
 * @param messages 完整消息数组（来自 buildMessages()）
 * @param turnSpans Turn 边界跨度数组
 * @param infoToolNames 信息类工具名称集合
 * @returns 已标注优先级的项列表
 */
export function annotateWithPriority(
  messages: any[],
  turnSpans: readonly import('./turn-types').TurnSpan[],
  infoToolNames: Set<string>
): PrioritizedItem[] {
  const items: PrioritizedItem[] = [];
  const totalTurns = turnSpans.length;

  for (let i = 0; i < totalTurns; i++) {
    const span = turnSpans[i];
    const turnMessages = messages.slice(span.startIdx, span.endIdx);
    const tokens = fastEstimateMessagesTokens(turnMessages);
    const isLatest = (i === totalTurns - 1);

    // 检测是否为摘要消息
    const isSummary = turnMessages.some(m =>
      m.role === 'user' && m.content?.includes('<conversation-summary>')
    );

    let priority: number;

    if (isLatest) {
      // 最新 Turn：最高对话优先级
      priority = MessagePriority.CURRENT_TURN;
    } else if (isSummary) {
      // 摘要消息：高优先级保留
      priority = MessagePriority.SUMMARY;
    } else {
      // 历史 Turn：按时间衰减 + 信息类工具加分
      // 线性插值：最旧 → HISTORY_OLDEST(100)，最近历史 → HISTORY_BASE(700)
      const historyCount = totalTurns - 1; // 排除最新 Turn
      const age = historyCount > 1
        ? (historyCount - 1 - i) / (historyCount - 1) // 0(最新历史) ~ 1(最旧)
        : 0;

      const basePriority = span.hasInfoTools
        ? MessagePriority.HISTORY_INFO   // 750
        : MessagePriority.HISTORY_BASE;  // 700

      // 从 basePriority 线性衰减到 HISTORY_OLDEST
      priority = Math.round(
        MessagePriority.HISTORY_OLDEST + (basePriority - MessagePriority.HISTORY_OLDEST) * (1 - age)
      );
    }

    items.push({
      id: span.turnId,
      priority,
      tokens,
      messages: turnMessages,
      originalIndex: i,
      // H2: flexGrow 梯度 — 越新的 Turn 获得越多剩余预算
      // 信息类工具 Turn 额外 +1，使 read_file/fetch 等结果获得更多空间
      // 参考 Copilot: 新 Turn 的工具结果更有可能被引用，应优先保留完整内容
      flexGrow: (i + 1) + (span.hasInfoTools ? 1 : 0),
    });
  }

  return items;
}

/**
 * 标注消息优先级（Legacy 消息级，无 TurnSpan 时使用）
 *
 * 每条消息作为独立的优先级项。
 * 用于兼容旧代码路径（无 Turn 边界信息）。
 */
export function annotateMessagesLegacy(
  messages: any[],
  recentPreserveCount: number,
  infoToolNames: Set<string>
): PrioritizedItem[] {
  const items: PrioritizedItem[] = [];
  const preserveStart = Math.max(0, messages.length - recentPreserveCount);

  // 找到最后一条用户消息
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const tokens = fastEstimateMessageTokens(msg);
    let priority: number;

    if (msg.role === 'system') {
      priority = MessagePriority.SYSTEM;
    } else if (i === lastUserIdx) {
      priority = MessagePriority.CURRENT_USER;
    } else if (i >= preserveStart) {
      priority = MessagePriority.CURRENT_TURN;
    } else if (msg.role === 'user') {
      priority = MessagePriority.HISTORY_BASE;
    } else if (msg.role === 'tool' && infoToolNames.has(msg.name || '')) {
      priority = MessagePriority.HISTORY_INFO;
    } else {
      // 历史中的普通消息：按位置衰减
      const age = preserveStart > 0 ? (preserveStart - i) / preserveStart : 0;
      priority = Math.round(
        MessagePriority.HISTORY_OLDEST + (MessagePriority.HISTORY_BASE - MessagePriority.HISTORY_OLDEST) * (1 - age)
      );
    }

    items.push({
      id: `msg_${i}`,
      priority,
      tokens,
      messages: [msg],
      originalIndex: i,
    });
  }

  return items;
}
