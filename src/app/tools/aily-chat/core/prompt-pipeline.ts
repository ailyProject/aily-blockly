/**
 * PromptPipeline — 声明式 Prompt 渲染管线
 *
 * 参考 Copilot @vscode/prompt-tsx 的 PromptRenderer：
 *   1. 收集所有 PromptElement（通过 PromptElementProvider）
 *   2. 展平嵌套 Element 树
 *   3. 按预算自动裁剪（从低优先级开始淘汰）
 *   4. 弹性分配剩余预算（flexGrow）
 *   5. 按注入顺序拼接最终消息数组
 *
 * 核心原则：Budget-first
 *   调用方只声明"我有什么内容、优先级是多少"，
 *   管线自动决定"放不放、放多少"。
 */

import {
  PromptElement,
  PromptElementProvider,
  PromptBuildContext,
  PromptRenderResult,
  ChatMessage,
} from './prompt-elements';

// ==================== 内部类型 ====================

/** 展平后的渲染单元（对应一个不可分割的淘汰单位） */
interface FlattenedUnit {
  /** 所属 Element ID */
  elementId: string;
  /** 优先级（继承自 Element） */
  priority: number;
  /** 该单元的 token 数 */
  tokens: number;
  /** 消息数组 */
  messages: ChatMessage[];
  /** 原始注册顺序（用于最终排序） */
  order: number;
  /** 是否可被淘汰 */
  evictable: boolean;
  /** 弹性增长系数 */
  flexGrow: number;
  /** 弹性预留 */
  flexReserve: number;
  /** 最大 token 上限 */
  maxTokens: number;
}

// ==================== 管线实现 ====================

export class PromptPipeline {

  /** 注册的 Provider（按注册顺序决定最终消息排序） */
  private providers: PromptElementProvider[] = [];

  /** 注册顺序计数器 */
  private orderCounter = 0;

  constructor() {}

  /**
   * 注册 PromptElementProvider
   *
   * 注册顺序决定最终消息在 API payload 中的排列顺序。
   * 参考 Copilot prompt-tsx：TSX 组件的 DOM 顺序即消息顺序。
   *
   * @param provider Element 提供者
   */
  register(provider: PromptElementProvider): this {
    this.providers.push(provider);
    return this;
  }

  /**
   * 批量注册
   */
  registerAll(providers: PromptElementProvider[]): this {
    for (const p of providers) this.register(p);
    return this;
  }

  /**
   * 渲染 Prompt — 核心入口
   *
   * 参考 Copilot PromptRenderer.render():
   *   1. 调用每个 Provider.build() 收集 Element
   *   2. 展平 Element 树为 FlattenedUnit[]
   *   3. 计算总 token → 超预算时按优先级淘汰
   *   4. flexGrow 弹性分配剩余预算
   *   5. 按注册顺序拼接消息
   *
   * @param context 构建上下文
   * @param tokenBudget 可用 token 预算（已扣除 output reserve）
   * @returns 渲染结果
   */
  render(context: PromptBuildContext, tokenBudget: number): PromptRenderResult {
    // Step 1: 收集 Element
    const elements: PromptElement[] = [];
    for (const provider of this.providers) {
      const element = provider.build(context);
      if (element) elements.push(element);
    }

    // Step 2: 展平为渲染单元
    const units = this.flatten(elements);

    // Step 3: 计算总 token 并决定是否需要裁剪
    let totalTokens = units.reduce((sum, u) => sum + u.tokens, 0);

    const evictedIds = new Set<string>();

    if (totalTokens > tokenBudget) {
      // 按 priority 升序排列（低优先级先淘汰）
      // 同优先级按 order 升序（更早注册的先淘汰 — 通常是更旧的历史）
      const sortedForEviction = [...units]
        .filter(u => u.evictable)
        .sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return a.order - b.order;
        });

      for (const unit of sortedForEviction) {
        if (totalTokens <= tokenBudget) break;
        evictedIds.add(unit.elementId);
        totalTokens -= unit.tokens;
      }
    }

    // Step 4: 保留的单元
    const kept = units.filter(u => !evictedIds.has(u.elementId));

    // Step 5: flexGrow 弹性分配
    const remainingBudget = Math.max(0, tokenBudget - totalTokens);
    const flexBudgets = this.allocateFlex(kept, remainingBudget);

    // Step 6: 按 order 排序，拼接消息
    kept.sort((a, b) => a.order - b.order);
    const messages: ChatMessage[] = kept.flatMap(u => u.messages);

    // Step 7: 构建明细
    const elementBreakdown = elements.map(el => ({
      id: el.id,
      priority: el.priority,
      tokens: el.tokens,
      messageCount: el.messages.length,
      evicted: evictedIds.has(el.id),
    }));

    return {
      messages,
      elementBreakdown,
      totalTokens,
      budget: tokenBudget,
      evictedCount: evictedIds.size,
    };
  }

  // ==================== 内部方法 ====================

  /**
   * 展平 Element 树为 FlattenedUnit[]
   *
   * 参考 Copilot: nested TSX components 被 PromptRenderer 展平后统一排序。
   * 子 Element 独立参与优先级排序，但淘汰时随父级一起淘汰。
   *
   * 当前实现：将 children 展平为独立单元，保持各自 priority。
   * 如果 Element 有 children，父级 messages 和 children messages 分别作为独立单元。
   */
  private flatten(elements: PromptElement[]): FlattenedUnit[] {
    const units: FlattenedUnit[] = [];

    for (const el of elements) {
      const order = this.orderCounter++;

      // 如果有子 Element，递归展平
      if (el.children && el.children.length > 0) {
        // 父级有自己的 messages 时也作为一个 unit
        if (el.messages.length > 0) {
          units.push({
            elementId: el.id,
            priority: el.priority,
            tokens: el.tokens,
            messages: el.messages,
            order,
            evictable: el.evictable !== false,
            flexGrow: el.flexGrow ?? 0,
            flexReserve: el.flexReserve ?? 0,
            maxTokens: el.maxTokens ?? Infinity,
          });
        }

        // 递归展平子 Element
        const childUnits = this.flatten(el.children);
        units.push(...childUnits);
      } else {
        // 叶子节点：直接作为一个单元
        units.push({
          elementId: el.id,
          priority: el.priority,
          tokens: el.tokens,
          messages: el.messages,
          order,
          evictable: el.evictable !== false,
          flexGrow: el.flexGrow ?? 0,
          flexReserve: el.flexReserve ?? 0,
          maxTokens: el.maxTokens ?? Infinity,
        });
      }
    }

    return units;
  }

  /**
   * flexGrow 弹性分配
   *
   * 参考 Copilot prompt-tsx 的 flexGrow 语义：
   * 剩余预算按 flexGrow 比例分配给参与弹性增长的单元。
   */
  private allocateFlex(
    units: FlattenedUnit[],
    remainingBudget: number
  ): Map<string, number> {
    const budgets = new Map<string, number>();
    if (remainingBudget <= 0) return budgets;

    let available = remainingBudget;

    // C2: 先保证 flexReserve 最低预留
    const reserveUnits = units.filter(u => u.flexReserve > 0);
    for (const unit of reserveUnits) {
      const reserve = Math.min(unit.flexReserve, available);
      if (reserve > 0) {
        budgets.set(unit.elementId, reserve);
        available -= reserve;
      }
    }
    if (available <= 0) return budgets;

    // 再按 flexGrow 比例分配剩余
    const flexUnits = units.filter(u => u.flexGrow > 0);
    if (flexUnits.length === 0) return budgets;

    const totalFlexGrow = flexUnits.reduce((sum, u) => sum + u.flexGrow, 0);

    for (const unit of flexUnits) {
      const share = Math.floor(available * (unit.flexGrow / totalFlexGrow));
      const maxExtra = unit.maxTokens === Infinity ? share : Math.max(0, unit.maxTokens - unit.tokens);
      const capped = Math.min(share, maxExtra);
      if (capped > 0) {
        const existing = budgets.get(unit.elementId) ?? 0;
        budgets.set(unit.elementId, existing + capped);
      }
    }

    return budgets;
  }

  /**
   * 重置 Provider 列表（用于测试或重新配置）
   */
  reset(): void {
    this.providers = [];
    this.orderCounter = 0;
  }
}
