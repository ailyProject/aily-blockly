/**
 * Turn 数据源抽象 — Phase C: 替代 blockly TurnManager
 *
 * 定义了历史摘要桥接与主路径会话编排所需的最小接口。
 *
 * 由 LexTurnSessionBridge 实现，LexOwnerFacade 只对外暴露该 owner。
 */

// ==================== TurnSpan（从 turn-types.ts 迁移） ====================

/**
 * Turn 在消息数组中的位置跨度
 *
 * 由 ITurnDataSource.buildMessagesWithSpans() 一并生成，
 * 供历史兼容裁剪/摘要路径按 Turn 边界理解消息布局。
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

// ==================== ITurnDataSource ====================

/**
 * Turn 数据源接口 — 会话历史的唯一抽象
 *
 * 替代 blockly TurnManager 的直接引用，解耦历史摘要桥接 / 预算显示辅助 / 主路径会话编排
 * 与具体的 TurnManager 实现。当前由 LexTurnSessionBridge 承接。
 */
export interface ITurnDataSource {
  /** 从 Turn[] 构建 LLM 消息数组（OpenAI 格式） */
  buildMessages(): any[];

  /** 从 Turn[] 构建消息 + TurnSpan 边界信息 */
  buildMessagesWithSpans(): { messages: any[]; turnSpans: TurnSpan[] };

  /** 当前 Turn 历史版本号（供消费方判定消息/跨度快照是否已变化） */
  readonly revision: number;
}
