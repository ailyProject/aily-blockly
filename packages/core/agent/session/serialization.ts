import { createAgentSession } from './createSession'
import { createAgentTurn } from './turns'

import type { AgentMessage } from '../types/message'
import type { AgentToolCallRound, AgentToolExecution, AgentTurn, AgentTurnRequest, AgentTurnResponse } from './turns'
import type { AgentSession } from './types'

/**
 * 可序列化的 turn request
 */
export interface SerializedAgentTurnRequest extends AgentTurnRequest {
	/** 持久化的原始用户消息 */
	message: AgentMessage
}

/**
 * 可序列化的 turn response
 */
export interface SerializedAgentTurnResponse extends Omit<AgentTurnResponse, 'toolCallRounds'> {
	/** 可序列化的工具轮次 */
	toolCallRounds: Array<AgentToolCallRound>
}

/**
 * 可序列化的 turn
 */
export interface SerializedAgentTurn {
	/** turn ID */
	id: string
	/** 原始消息快照 */
	messages: Array<AgentMessage>
	/** 请求部分 */
	request: SerializedAgentTurnRequest
	/** 响应部分 */
	response?: SerializedAgentTurnResponse
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
 * 可序列化的会话
 */
export interface SerializedAgentSession {
	/** 会话 ID */
	id: string
	/** 会话标题 */
	title: string
	/** 派生消息数组 */
	messages: Array<AgentMessage>
	/** 结构化 turns */
	turns: Array<SerializedAgentTurn>
	/** turn spans */
	turnSpans: AgentSession['turnSpans']
	/** 修订号 */
	revision: number
	/** runtime 配置 */
	runtimeConfig: AgentSession['runtimeConfig']
	/** 元数据 */
	metadata: Record<string, unknown>
	/** 创建时间 */
	createdAt: string
	/** 更新时间 */
	updatedAt: string
}

const serializeTurn = (turn: AgentTurn): SerializedAgentTurn => ({
	id: turn.id,
	messages: turn.messages,
	request: turn.request,
	response: turn.response,
	createdAt: turn.createdAt,
	hasInfoTools: turn.hasInfoTools,
	summary: turn.summary,
	toolExecutions: turn.toolExecutions
})

const deserializeTurn = (turn: SerializedAgentTurn): AgentTurn =>
	createAgentTurn({
		id: turn.id,
		messages: turn.messages,
		request: turn.request,
		response: turn.response,
		createdAt: turn.createdAt,
		hasInfoTools: turn.hasInfoTools,
		summary: turn.summary,
		toolExecutions: turn.toolExecutions
	})

export const serializeAgentSession = (session: AgentSession): SerializedAgentSession => ({
	id: session.id,
	title: session.title,
	messages: session.messages,
	turns: session.turns.map(serializeTurn),
	turnSpans: session.turnSpans,
	revision: session.revision,
	runtimeConfig: session.runtimeConfig,
	metadata: session.metadata,
	createdAt: session.createdAt.toISOString(),
	updatedAt: session.updatedAt.toISOString()
})

export const deserializeAgentSession = (session: SerializedAgentSession): AgentSession =>
	createAgentSession({
		id: session.id,
		title: session.title,
		turns: session.turns.map(deserializeTurn),
		turnSpans: session.turnSpans,
		revision: session.revision,
		runtimeConfig: session.runtimeConfig,
		metadata: session.metadata,
		createdAt: new Date(session.createdAt),
		updatedAt: new Date(session.updatedAt)
	})
