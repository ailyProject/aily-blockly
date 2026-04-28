/**
 * Turn 结构化存储类型定义
 *
 * 参考 Copilot 架构：用不可变 Turn[] 作为 source of truth，
 * 每次 API 调用前从 Turn[] 重建 messages 数组。
 *
 * Turn 的核心优势：
 * - 分离存储层与传输层（Turn = 存储，messages = 传输）
 * - 工具结果与 Turn 绑定，不存在中间态丢失
 * - 压缩/裁剪在 buildMessages() 中执行，不修改原始数据
 * - 支持 checkpoint/rollback 以 turn 为单位
 */

// ==================== 核心数据结构 ====================

/**
 * 单轮工具调用记录
 *
 * 一个 ToolCallRound 对应 LLM 一次响应中的所有 tool_calls，
 * 以及对应的执行结果。
 */
export interface ToolCallRound {
  /** 唯一标识，用于将摘要锚定到具体 round */
  id: string;
  /** 本轮 LLM 在发起 tool_calls 前/同时输出的推理文本 */
  assistantContent?: string;
  /** 可选摘要文本；存在时表示更早历史已被该摘要覆盖 */
  summary?: string;
  /** 本轮中 LLM 请求的所有 tool_calls */
  toolCalls: ToolCallEntry[];
  /** tool_call_id → 执行结果，结果收集完成后填充 */
  results: Record<string, ToolCallResult>;
}

export interface ToolCallEntry {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ToolCallResult {
  content: string;
  isError: boolean;
  /** 原始工具名（冗余存储，方便查询） */
  toolName: string;
}

/**
 * 单个 Turn — 一次完整的 user → assistant 交互
 *
 * 包含用户请求、LLM 响应（可能有多轮工具调用），
 * 以及可选的压缩/摘要元信息。
 */
export interface Turn {
  /** 唯一标识（用于 checkpoint/rollback） */
  id: string;
  /** 用户请求 */
  request: TurnRequest;
  /** LLM 响应（流结束后填充） */
  response?: TurnResponse;
  /** 元信息 */
  metadata?: TurnMetadata;
}

export interface TurnRequest {
  content: string;
  timestamp: number;
}

export interface TurnResponse {
  /** 最终的 assistant 文本内容 */
  content: string;
  /**
   * 工具调用轮次列表
   *
   * 每一轮对应一次 LLM API 调用中的 tool_calls + results。
   * 多轮表示 continueToolCallingLoop 发生了多次。
   */
  toolCallRounds: ToolCallRound[];
}

export interface TurnMetadata {
  /** turn 级摘要内容：仅在无 tool rounds 或旧数据迁移时作为兜底 */
  summary?: string;
  /** 该 turn 的消息来源 */
  source?: string;
}

// ==================== Turn 边界标记（用于 Turn-aware 裁剪） ====================

/**
 * Turn 在消息数组中的位置跨度
 *
 * 由 TurnManager.buildMessages() 一并生成，
 * 供 ContextBudgetService.prioritizedTrim() 以 Turn 为最小移除单元进行裁剪。
 *
 * Copilot 原则：Turn 要么完整保留，要么整体移除，绝不拆散。
 * 这保证了 tool_call ↔ tool_result 的配对完整性。
 */
export interface TurnSpan {
  /** Turn 的唯一 ID */
  turnId: string;
  /** Turn 在 Turn[] 中的索引（0-based） */
  turnIndex: number;
  /** 在 messages[] 中的起始索引（inclusive） */
  startIdx: number;
  /** 在 messages[] 中的结束索引（exclusive） */
  endIdx: number;
  /** 该 Turn 是否包含信息类工具调用（read_file/fetch/grep 等） */
  hasInfoTools: boolean;
}

// ==================== 序列化接口 ====================

/**
 * Turn[] 的序列化格式（用于持久化）
 *
 * 作为 SessionData 的唯一对话存储格式，
 * conversationMessages 已废弃。
 */
export interface SerializedTurns {
  version: 1;
  turns: Turn[];
}
