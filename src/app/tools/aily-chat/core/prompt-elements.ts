/**
 * 声明式 Prompt 组合管线 — PromptElement 定义层
 *
 * 参考 Copilot @vscode/prompt-tsx 架构：
 *   - 每个 PromptElement 声明 priority / flexGrow / messages
 *   - PromptRenderer 按预算自动裁剪、弹性分配
 *   - 调用方只声明"要什么"，管线自动决定"放多少"
 *
 * 与 Copilot 的映射关系：
 *   Copilot TSX Component  → 我们的 PromptElement 接口
 *   Copilot PromptRenderer → 我们的 PromptPipeline.render()
 *   Copilot priority prop  → PromptElement.priority
 *   Copilot flexGrow prop  → PromptElement.flexGrow
 *   Copilot flexReserve    → PromptElement.flexReserve
 */

// ==================== 核心类型 ====================

/**
 * 消息格式（OpenAI Chat Completion API 兼容）
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

/**
 * PromptElement — 声明式 Prompt 组件
 *
 * 对应 Copilot prompt-tsx 中的一个 TSX 组件：
 *   <SystemMessage priority={1000}>...</SystemMessage>
 *   <UserMessage priority={900}>...</UserMessage>
 *   <HistoryMessages priority={700} flexGrow={1}>...</HistoryMessages>
 *
 * 每个 Element 声明自己的内容、优先级、弹性系数，
 * PromptPipeline 统一管理预算和裁剪。
 */
export interface PromptElement {
  /** 唯一标识 */
  id: string;

  /**
   * 优先级（0-1000，参考 Copilot prompt-tsx z-index 语义）
   *
   * 值越大越不容易被淘汰：
   *   1000 = 系统指令（永远保留）
   *    900 = 当前用户消息
   *    800 = 摘要
   *    750 = 上下文注入（skills/memory）
   *    700 = 历史对话
   *    100 = 最旧历史
   */
  priority: number;

  /**
   * 弹性增长系数（参考 Copilot flexGrow）
   *
   * 预算有剩余时按比例分配额外空间。
   * 0 = 不参与弹性分配（默认）
   * 1+ = 按比例瓜分剩余预算
   */
  flexGrow?: number;

  /**
   * 弹性预留（参考 Copilot flexReserve）
   *
   * 即使预算不足也必须保留的最低 token 数。
   * 用于保证关键内容至少有最小可见性。
   */
  flexReserve?: number;

  /**
   * 最大 token 占用（上限，防止单个 Element 独占）
   */
  maxTokens?: number;

  /**
   * 该 Element 包含的消息数组
   *
   * render() 时由 PromptElementProvider 计算填充。
   * 可以是静态内容，也可以是动态生成的（如 Turn 历史）。
   */
  messages: ChatMessage[];

  /**
   * 该 Element 当前占用的 token 数（预计算或 lazy 计算）
   */
  tokens: number;

  /**
   * 是否可被淘汰（false = 永远保留，优先级仅用于排序）
   * 默认 true
   */
  evictable?: boolean;

  /**
   * 子 Element 列表（树形嵌套，对应 Copilot TSX 嵌套组件）
   *
   * 子 Element 继承父级的 evictable 约束，
   * 但 priority 独立（可以比父级高或低）。
   * 淘汰时整个子树一起淘汰。
   */
  children?: PromptElement[];
}

// ==================== 优先级常量 ====================

/**
 * 参考 Copilot prompt-tsx 的优先级语义
 */
export const PromptPriority = {
  /** 系统指令 — 永远保留 */
  SYSTEM: 1000,
  /** 当前 Turn 用户消息 */
  CURRENT_USER: 900,
  /** 当前 Turn 工具调用 & 结果 */
  CURRENT_TURN: 899,
  /** 摘要消息 */
  SUMMARY: 800,
  /** 瞬态上下文注入（skills/memory/deferred tools） */
  CONTEXT_INJECTION: 750,
  /** 历史中含信息类工具的 Turn */
  HISTORY_INFO: 750,
  /** 普通历史 Turn */
  HISTORY_BASE: 700,
  /** 工具续写提示 */
  TOOL_CONTINUATION: 690,
  /** 最旧历史 */
  HISTORY_OLDEST: 100,
} as const;

// ==================== Element 工厂（对应 Copilot TSX 组件） ====================

/**
 * PromptElementProvider — 元素提供者接口
 *
 * 对应 Copilot prompt-tsx 中的 React 组件 render() 方法：
 * 每个 Provider 负责从引擎状态构建一个 PromptElement。
 *
 * 声明式的核心：Provider 只声明"我的内容是什么、优先级是多少"，
 * 不关心预算分配，由 PromptPipeline 统一裁剪。
 */
export interface PromptElementProvider {
  /** Provider 标识 */
  id: string;
  /** 构建 PromptElement（每次 API 调用前执行） */
  build(context: PromptBuildContext): PromptElement | null;
}

/**
 * 构建上下文 — 传递给每个 Provider 的共享状态
 */
export interface PromptBuildContext {
  /** 当前模式 ('agent' | 'ask') */
  mode: string;
  /** 当前消息来源 ('mainAgent' | 'subAgent' | ...) */
  messageSource: string;
  /** 工具调用循环迭代次数（0 = 首次，>0 = 续写） */
  toolCallingIteration: number;
  /** 引擎引用（用于访问 turnManager/config 等） */
  engine: any;
}

// ==================== 渲染结果 ====================

/**
 * 管线渲染结果
 */
export interface PromptRenderResult {
  /** 最终消息数组（按注入顺序排列，ready for API） */
  messages: ChatMessage[];
  /** 各 Element 的 token 明细 */
  elementBreakdown: Array<{
    id: string;
    priority: number;
    tokens: number;
    messageCount: number;
    evicted: boolean;
  }>;
  /** 总 token 数 */
  totalTokens: number;
  /** 可用预算 */
  budget: number;
  /** 被淘汰的 Element 数 */
  evictedCount: number;
}
