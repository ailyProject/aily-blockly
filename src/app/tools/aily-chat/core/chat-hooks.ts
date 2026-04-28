/**
 * Chat Hook 系统 — 类型定义层
 *
 * 参考 Copilot `vscode.proposed.chatHooks.d.ts` + `IChatHookService`：
 *   - ChatHookType 枚举全部 10 种生命周期事件
 *   - 每种 Hook 有明确的 Input / Output 类型
 *   - Hook 结果支持拦截（allow/deny/block）+ 上下文注入（additionalContext）
 *
 * 与 Copilot 的映射关系：
 *   Copilot ChatHookType       → AilyChatHookType
 *   Copilot IChatHookService   → AilyChatHookService
 *   Copilot ChatHookCommand    → AilyHookHandler (函数式而非外部命令)
 *   Copilot processHookResults → AilyChatHookService 内部合并逻辑
 *
 * 设计差异：
 *   Copilot 的 Hook 是 shell command（外部进程），我们用内部函数回调。
 *   这样更轻量、类型安全，同时保留了相同的语义。
 */

// ==================== Hook 类型枚举 ====================

/**
 * 生命周期事件类型 — 参考 Copilot ChatHookType
 */
export type AilyChatHookType =
  | 'SessionStart'      // 会话首轮开始
  | 'SessionEnd'        // 会话结束/保存
  | 'UserPromptSubmit'  // 用户消息提交
  | 'PreToolUse'        // 工具调用前（可拦截/修改参数）
  | 'PostToolUse'       // 工具调用后（可阻止结果）
  | 'PreCompact'        // 上下文压缩前
  | 'SubagentStart'     // 子代理启动前
  | 'SubagentStop'      // 子代理停止前
  | 'Stop'              // Agent 循环结束前（可阻止停止）
  | 'ErrorOccurred';    // 错误发生时

// ==================== Hook Input 类型 ====================

/** SessionStart Hook 输入 */
export interface SessionStartHookInput {
  /** 会话 ID */
  readonly sessionId: string;
  /** 当前模式 */
  readonly mode: string;
}

/** SessionEnd Hook 输入 */
export interface SessionEndHookInput {
  readonly sessionId: string;
  readonly turnCount: number;
}

/** UserPromptSubmit Hook 输入 */
export interface UserPromptSubmitHookInput {
  /** 用户提交的原始文本 */
  readonly prompt: string;
  readonly mode: string;
}

/** PreToolUse Hook 输入 */
export interface PreToolUseHookInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolCallId: string;
}

/** PostToolUse Hook 输入 */
export interface PostToolUseHookInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResult: unknown;
  readonly toolCallId: string;
  readonly isError: boolean;
}

/** PreCompact Hook 输入 */
export interface PreCompactHookInput {
  /** 触发方式 */
  readonly trigger: 'auto' | 'manual';
  /** 当前 token 使用率 (0-1) */
  readonly usageRatio: number;
  /** 当前总 token 数 */
  readonly currentTokens: number;
  /** 最大上下文 token 数 */
  readonly maxTokens: number;
}

/** SubagentStart Hook 输入 */
export interface SubagentStartHookInput {
  readonly agentId: string;
  readonly agentType: string;
}

/** SubagentStop Hook 输入 */
export interface SubagentStopHookInput {
  readonly agentId: string;
  readonly agentType: string;
  /** 是否已因 Stop Hook 活跃而续写（防止无限循环） */
  readonly stopHookActive: boolean;
}

/** Stop Hook 输入 */
export interface StopHookInput {
  /** 是否已因 Stop Hook 活跃而续写（防止无限循环） */
  readonly stopHookActive: boolean;
  /** 本 Turn 的工具调用迭代次数 */
  readonly toolCallingIteration: number;
}

/** ErrorOccurred Hook 输入 */
export interface ErrorOccurredHookInput {
  readonly error: Error | string;
  readonly phase: 'stream' | 'tool_execution' | 'compression' | 'other';
}

// ==================== Hook 类型映射 ====================

/** 将 HookType 映射到对应的 Input 类型 */
export interface HookInputMap {
  SessionStart: SessionStartHookInput;
  SessionEnd: SessionEndHookInput;
  UserPromptSubmit: UserPromptSubmitHookInput;
  PreToolUse: PreToolUseHookInput;
  PostToolUse: PostToolUseHookInput;
  PreCompact: PreCompactHookInput;
  SubagentStart: SubagentStartHookInput;
  SubagentStop: SubagentStopHookInput;
  Stop: StopHookInput;
  ErrorOccurred: ErrorOccurredHookInput;
}

// ==================== Hook Output / Result 类型 ====================

/**
 * PreToolUse Hook 合并结果 — 参考 Copilot IPreToolUseHookResult
 *
 * 多个 Hook 的决策按最严格原则合并：deny > ask > allow
 */
export interface PreToolUseHookResult {
  /** 权限决策 */
  permissionDecision?: 'allow' | 'deny' | 'ask';
  /** 决策原因 */
  permissionDecisionReason?: string;
  /** Hook 可修改工具输入参数 */
  updatedInput?: object;
  /** 注入的额外上下文 */
  additionalContext?: string[];
}

/**
 * PostToolUse Hook 合并结果 — 参考 Copilot IPostToolUseHookResult
 */
export interface PostToolUseHookResult {
  /** 阻止决策 */
  decision?: 'block';
  /** 阻止原因 */
  reason?: string;
  /** 注入的额外上下文 */
  additionalContext?: string[];
}

/**
 * Stop Hook 合并结果 — 参考 Copilot StopHookResult
 */
export interface StopHookResult {
  /** 是否应继续（不停止） */
  shouldContinue: boolean;
  /** 继续的原因列表 */
  reasons?: readonly string[];
}

/**
 * 通用 Hook 结果（用于不需要特殊合并逻辑的 Hook）
 */
export interface GenericHookResult {
  /** 额外上下文注入 */
  additionalContext?: string;
  /** 阻止决策 */
  decision?: 'block';
  /** 阻止原因 */
  reason?: string;
}

// ==================== Hook Result 类型映射 ====================

/** 将 HookType 映射到对应的 Result 类型 */
export interface HookResultMap {
  SessionStart: GenericHookResult;
  SessionEnd: GenericHookResult;
  UserPromptSubmit: GenericHookResult;
  PreToolUse: PreToolUseHookResult;
  PostToolUse: PostToolUseHookResult;
  PreCompact: GenericHookResult;
  SubagentStart: GenericHookResult;
  SubagentStop: StopHookResult;
  Stop: StopHookResult;
  ErrorOccurred: GenericHookResult;
}

// ==================== Hook Handler 类型 ====================

/**
 * Hook 处理函数 — 对应 Copilot ChatHookCommand
 *
 * 与 Copilot 的差异：
 *   Copilot 使用 shell 子进程 + JSON stdin/stdout
 *   我们使用 TypeScript 函数 + 类型安全的参数/返回
 *
 * @param input Hook 输入数据
 * @returns Hook 结果（可选），null/undefined 表示不干预
 */
export type AilyHookHandler<T extends AilyChatHookType> =
  (input: HookInputMap[T]) => HookResultMap[T] | null | undefined | Promise<HookResultMap[T] | null | undefined>;

// ==================== Hook 注册描述 ====================

/**
 * Hook 注册条目
 */
export interface HookRegistration<T extends AilyChatHookType = AilyChatHookType> {
  /** Hook 类型 */
  hookType: T;
  /** 处理函数 */
  handler: AilyHookHandler<T>;
  /** 注册来源标识（用于调试/遥测） */
  source: string;
  /** 优先级（数值越大越先执行，默认 0） */
  priority?: number;
}
