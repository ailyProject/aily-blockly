/**
 * AilyChatHookService — 中心化 Hook 注册与执行引擎
 *
 * 参考 Copilot IChatHookService 的核心语义：
 *   1. 注册：任何模块可注册指定 HookType 的处理函数
 *   2. 执行：生命周期触发时执行所有注册的 Handler
 *   3. 合并：多个 Handler 的结果按规则合并（最严格优先）
 *   4. 安全：Hook 异常不阻塞主流程（catch + log）
 *
 * 与 Copilot 的差异：
 *   Copilot → shell 子进程 + JSON stdin/stdout + 进程隔离
 *   我们   → TypeScript 函数 + 类型安全 + 同进程执行
 *
 * 用法：
 *   // 注册
 *   hookService.register({
 *     hookType: 'PreToolUse',
 *     handler: (input) => ({ permissionDecision: 'deny', permissionDecisionReason: '...' }),
 *     source: 'my-extension',
 *   });
 *
 *   // 执行
 *   const result = await hookService.executePreToolUse({ toolName, toolInput, toolCallId });
 */

import {
  AilyChatHookType,
  AilyHookHandler,
  HookRegistration,
  HookInputMap,
  HookResultMap,
  PreToolUseHookInput,
  PreToolUseHookResult,
  PostToolUseHookInput,
  PostToolUseHookResult,
  StopHookInput,
  StopHookResult,
  GenericHookResult,
} from '../core/chat-hooks';

export class AilyChatHookService {

  /** Hook 注册表：按 HookType 分组 */
  private registry = new Map<AilyChatHookType, HookRegistration[]>();

  // ==================== 注册 ====================

  /**
   * 注册 Hook 处理函数
   *
   * @returns 取消注册的函数（dispose 模式）
   */
  register<T extends AilyChatHookType>(registration: HookRegistration<T>): () => void {
    const { hookType } = registration;
    if (!this.registry.has(hookType)) {
      this.registry.set(hookType, []);
    }
    const list = this.registry.get(hookType)!;
    list.push(registration as HookRegistration);
    // 按 priority 降序排列（高优先级先执行）
    list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    // 返回 dispose 函数
    return () => {
      const idx = list.indexOf(registration as HookRegistration);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  /**
   * 检查指定 HookType 是否有注册的 Handler
   */
  hasHandlers(hookType: AilyChatHookType): boolean {
    const list = this.registry.get(hookType);
    return !!list && list.length > 0;
  }

  // ==================== 通用执行 ====================

  /**
   * 执行指定类型的所有 Hook，收集结果
   *
   * 参考 Copilot IChatHookService.executeHook():
   * 按 priority 顺序执行，每个 Handler 独立 try/catch，
   * 单个 Hook 失败不影响其他 Hook。
   */
  async executeAll<T extends AilyChatHookType>(
    hookType: T,
    input: HookInputMap[T]
  ): Promise<Array<HookResultMap[T] | null>> {
    const handlers = this.registry.get(hookType);
    if (!handlers || handlers.length === 0) return [];

    const results: Array<HookResultMap[T] | null> = [];

    for (const reg of handlers) {
      try {
        const handler = reg.handler as AilyHookHandler<T>;
        const result = await handler(input);
        results.push(result ?? null);
      } catch (error) {
        console.error(
          `[HookService] ${hookType} hook from "${reg.source}" threw:`,
          error
        );
        results.push(null);
      }
    }

    return results;
  }

  // ==================== PreToolUse — 合并逻辑 ====================

  /**
   * 执行 PreToolUse Hook 并合并结果
   *
   * 参考 Copilot IChatHookService.executePreToolUseHook():
   *   多个 Hook 的决策按最严格规则合并：deny > ask > allow
   *   updatedInput 使用最后一个 Hook 的值
   *   additionalContext 从所有 Hook 收集
   */
  async executePreToolUse(input: PreToolUseHookInput): Promise<PreToolUseHookResult | undefined> {
    const results = await this.executeAll('PreToolUse', input);
    const nonNull = results.filter((r): r is PreToolUseHookResult => r !== null);
    if (nonNull.length === 0) return undefined;

    // 合并决策：deny > ask > allow
    let mergedDecision: 'allow' | 'deny' | 'ask' | undefined;
    let mergedReason: string | undefined;
    let mergedInput: object | undefined;
    const allContext: string[] = [];

    for (const result of nonNull) {
      // 决策合并：取最严格
      if (result.permissionDecision) {
        if (!mergedDecision || DECISION_SEVERITY[result.permissionDecision] > DECISION_SEVERITY[mergedDecision]) {
          mergedDecision = result.permissionDecision;
          mergedReason = result.permissionDecisionReason;
        }
      }
      // updatedInput：最后一个有效值
      if (result.updatedInput) {
        mergedInput = result.updatedInput;
      }
      // additionalContext：全部收集
      if (result.additionalContext) {
        allContext.push(...result.additionalContext);
      }
    }

    return {
      permissionDecision: mergedDecision,
      permissionDecisionReason: mergedReason,
      updatedInput: mergedInput,
      additionalContext: allContext.length > 0 ? allContext : undefined,
    };
  }

  // ==================== PostToolUse — 合并逻辑 ====================

  /**
   * 执行 PostToolUse Hook 并合并结果
   *
   * 参考 Copilot IChatHookService.executePostToolUseHook():
   *   任何一个 Hook 返回 block 即阻止
   *   additionalContext 从所有 Hook 收集
   */
  async executePostToolUse(input: PostToolUseHookInput): Promise<PostToolUseHookResult | undefined> {
    const results = await this.executeAll('PostToolUse', input);
    const nonNull = results.filter((r): r is PostToolUseHookResult => r !== null);
    if (nonNull.length === 0) return undefined;

    let blocked = false;
    let blockReason: string | undefined;
    const allContext: string[] = [];

    for (const result of nonNull) {
      if (result.decision === 'block') {
        blocked = true;
        blockReason = result.reason;
      }
      if (result.additionalContext) {
        allContext.push(...result.additionalContext);
      }
    }

    return {
      decision: blocked ? 'block' : undefined,
      reason: blockReason,
      additionalContext: allContext.length > 0 ? allContext : undefined,
    };
  }

  // ==================== Stop — 合并逻辑 ====================

  /**
   * 执行 Stop Hook 并合并结果
   *
   * 参考 Copilot ToolCallingLoop.executeStopHook():
   *   任何一个 Hook 返回 shouldContinue=true 即阻止停止
   *   原因列表合并
   */
  async executeStop(input: StopHookInput): Promise<StopHookResult> {
    const results = await this.executeAll('Stop', input);
    const nonNull = results.filter((r): r is StopHookResult => r !== null);

    if (nonNull.length === 0) return { shouldContinue: false };

    const blockingReasons: string[] = [];
    for (const result of nonNull) {
      if (result.shouldContinue && result.reasons) {
        blockingReasons.push(...result.reasons);
      }
    }

    if (blockingReasons.length > 0) {
      return { shouldContinue: true, reasons: blockingReasons };
    }
    return { shouldContinue: false };
  }

  // ==================== 便捷方法：通用 Hook ====================

  /**
   * 执行通用 Hook（SessionStart/SessionEnd/PreCompact 等）
   *
   * 合并 additionalContext，任何 block 决策直接生效
   */
  async executeGeneric<T extends AilyChatHookType>(
    hookType: T,
    input: HookInputMap[T]
  ): Promise<GenericHookResult | undefined> {
    const results = await this.executeAll(hookType, input);
    const nonNull = (results as Array<GenericHookResult | null>).filter((r): r is GenericHookResult => r !== null);
    if (nonNull.length === 0) return undefined;

    let blocked = false;
    let blockReason: string | undefined;
    const contextParts: string[] = [];

    for (const result of nonNull) {
      if (result.decision === 'block') {
        blocked = true;
        blockReason = result.reason;
      }
      if (result.additionalContext) {
        contextParts.push(result.additionalContext);
      }
    }

    return {
      additionalContext: contextParts.length > 0 ? contextParts.join('\n') : undefined,
      decision: blocked ? 'block' : undefined,
      reason: blockReason,
    };
  }

  // ==================== 工具方法 ====================

  /**
   * 清除所有注册（用于会话重置/测试）
   */
  clear(): void {
    this.registry.clear();
  }

  /**
   * 获取调试信息
   */
  getDebugInfo(): Record<string, number> {
    const info: Record<string, number> = {};
    for (const [type, handlers] of this.registry) {
      info[type] = handlers.length;
    }
    return info;
  }
}

// ==================== 内部常量 ====================

/** 决策严格程度（用于 PreToolUse 合并） */
const DECISION_SEVERITY: Record<string, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

// ==================== 辅助函数 ====================

/**
 * 格式化 Hook 上下文消息 — 参考 Copilot formatHookContext()
 *
 * 当 Stop Hook 阻止停止时，将原因格式化为 user 消息注入 prompt
 */
export function formatHookContext(reasons: readonly string[]): string {
  if (reasons.length === 1) {
    return `You were about to complete but a hook blocked you with the following message: "${reasons[0]}". Please address this requirement before completing.`;
  }
  const formattedReasons = reasons.map((reason, i) => `${i + 1}. ${reason}`).join('\n');
  return `You were about to complete but multiple hooks blocked you with the following messages:\n${formattedReasons}\n\nPlease address all of these requirements before completing.`;
}
