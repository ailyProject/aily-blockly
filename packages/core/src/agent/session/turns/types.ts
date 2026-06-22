import type { AgentMessage } from '../../types/message'

/**
 * 当前摘要锚点
 */
export interface AgentSummaryAnchor {
	/** 锚定 turn ID */
	turnId: string
	/** 锚定 turn 在会话中的索引 */
	turnIndex: number
	/** 锚定 round ID */
	roundId?: string
	/** 锚定 round 在 turn 中的索引 */
	roundIndex?: number
	/** 摘要内容 */
	summary: string
}

/** turn 在消息数组中的跨度 */
export interface AgentTurnSpan {
	/** 对应 turn ID */
	turnId: string
	/** turn 顺序索引 */
	turnIndex: number
	/** 消息起始下标，含当前值 */
	startIdx: number
	/** 消息结束下标，不含当前值 */
	endIdx: number
	/** 该 turn 是否包含信息型工具 */
	hasInfoTools: boolean
}

/**
 * 工具执行状态
 */
export type AgentToolExecutionState =
	/** 工具输入仍在流式生成中 */
	| 'input-streaming'
	/** 工具输入已确定但尚未产出结果 */
	| 'input-available'
	/** 工具正在等待审批 */
	| 'approval-requested'
	/** 工具审批结果已返回 */
	| 'approval-responded'
	/** 工具输出已可用 */
	| 'output-available'
	/** 工具执行报错 */
	| 'output-error'
	/** 工具被明确拒绝执行 */
	| 'output-denied'

/**
 * 单次工具执行摘要
 */
export interface AgentToolExecution {
	/** 工具调用 ID */
	toolCallId: string
	/** 工具名称 */
	toolName: string
	/** 工具执行状态 */
	state: AgentToolExecutionState
	/** 工具输入 */
	input?: unknown
	/** 工具输出 */
	output?: unknown
	/** 错误文本 */
	errorText?: string
	/** 是否为阶段性结果 */
	preliminary?: boolean
}

/** 单轮工具调用记录 */
export interface AgentToolCallRound {
	/** round 唯一 ID */
	id: string
	/** round 在一次 turn 中的顺序 */
	stepIndex: number
	/** 工具调用前后的 assistant 文本 */
	assistantText: string
	/** 本轮工具执行列表 */
	toolExecutions: Array<AgentToolExecution>
	/** 用于覆盖更早历史的摘要 */
	summary?: string
}

/** turn 请求部分 */
export interface AgentTurnRequest {
	/** 原始用户消息 */
	message: AgentMessage
	/** 请求时间戳 */
	timestamp: number
	/** 纯文本内容 */
	content: string
}

/**
 * turn 响应部分
 */
export interface AgentTurnResponse {
	/** assistant 消息快照 */
	messages: Array<AgentMessage>
	/** assistant 总文本 */
	assistantText: string
	/** 最终总结文本 */
	content: string
	/** 工具轮次列表 */
	toolCallRounds: Array<AgentToolCallRound>
}

/**
 * 结构化 turn
 */
export interface AgentTurn {
	/** turn ID */
	id: string
	/** 原始消息数组 */
	messages: Array<AgentMessage>
	/** 请求部分 */
	request: AgentTurnRequest
	/** 响应部分 */
	response?: AgentTurnResponse
	/** 创建时间戳 */
	createdAt: number
	/** 是否包含信息型工具 */
	hasInfoTools?: boolean
	/** turn 级摘要 */
	summary?: string
	/** 工具执行摘要 */
	toolExecutions?: Array<AgentToolExecution>
}

/**
 * 创建 turn 的输入参数
 */
export interface CreateAgentTurnInput {
	/** 可选 turn ID */
	id?: string
	/** 原始消息数组 */
	messages: Array<AgentMessage>
	/** 显式请求部分 */
	request?: AgentTurnRequest
	/** 显式响应部分 */
	response?: AgentTurnResponse
	/** 创建时间戳 */
	createdAt?: number
	/** 是否包含信息型工具 */
	hasInfoTools?: boolean
	/** turn 级摘要 */
	summary?: string
	/** 工具执行摘要 */
	toolExecutions?: Array<AgentToolExecution>
}

/**
 * 应用摘要到 turns 的输入参数
 */
export interface ApplyTurnSummaryArgs {
	/** 当前 turn 列表 */
	turns: Array<AgentTurn>
	/** 被覆盖的 turn ID 前缀 */
	turnIds: Array<string>
	/** 摘要锚定的 turn ID */
	anchorTurnId: string
	/** 摘要内容 */
	summary: string
	/** 可选 round 锚点 */
	anchorRoundId?: string
}

/**
 * 基于 turns 重建消息的结果
 */
export interface BuildTurnMessagesResult {
	/** 重建后的消息数组 */
	messages: Array<AgentMessage>
	/** 每个 turn 的跨度信息 */
	turnSpans: Array<AgentTurnSpan>
}
