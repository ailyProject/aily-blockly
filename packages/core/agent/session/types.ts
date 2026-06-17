import type { AgentMessage } from '../types/message'
import type { AgentTurn, AgentTurnSpan } from './turns'

/**
 * Agent 运行模式
 */
export type AgentMode =
	/** 允许调用工具并执行任务 */
	| 'agent'
	/** 以问答模式直接回复 */
	| 'ask'

/**
 * Agent runtime 配置
 */
export interface AgentRuntimeConfig {
	/** 对话模式 */
	mode: AgentMode
	/** 当前 agent 标识 */
	agentName: string
	/** 单次执行允许的最大 step 数 */
	maxSteps: number
	/** prompt 最大 token 预算 */
	maxPromptTokens: number
	/** 额外系统提示词 */
	customSystemPrompt?: string
	/** 当前日期字符串 */
	currentDate?: string
	/** 显式启用的工具列表 */
	enabledTools?: Array<string>
	/** 显式禁用的工具列表 */
	disabledTools: Array<string>
	/** 是否启用 deferred tool discovery */
	useDeferredToolDiscovery: boolean
}

/**
 * Agent 会话状态
 */
export interface AgentSession {
	/** 会话唯一 ID */
	id: string
	/** 会话标题 */
	title: string
	/** 当前派生出的历史消息 */
	messages: Array<AgentMessage>
	/** 结构化 turn 列表 */
	turns: Array<AgentTurn>
	/** 每个 turn 在消息数组中的跨度 */
	turnSpans: Array<AgentTurnSpan>
	/** 会话修订号 */
	revision: number
	/** 运行时配置 */
	runtimeConfig: AgentRuntimeConfig
	/** 额外元数据 */
	metadata: Record<string, unknown>
	/** 创建时间 */
	createdAt: Date
	/** 更新时间 */
	updatedAt: Date
}

/**
 * 创建会话时的输入参数
 */
export interface CreateAgentSessionInput {
	/** 可选外部指定的会话 ID */
	id?: string
	/** 初始标题 */
	title?: string
	/** 初始消息数组 */
	messages?: Array<AgentMessage>
	/** 初始结构化 turns */
	turns?: Array<AgentTurn>
	/** 初始 turn spans */
	turnSpans?: Array<AgentTurnSpan>
	/** 初始修订号 */
	revision?: number
	/** 初始 runtime 配置 */
	runtimeConfig?: Partial<AgentRuntimeConfig>
	/** 初始元数据 */
	metadata?: Record<string, unknown>
	/** 创建时间 */
	createdAt?: Date
	/** 更新时间 */
	updatedAt?: Date
}

/**
 * 会话存储接口
 */
export interface AgentSessionStore {
	/** 根据会话 ID 读取会话 */
	get(sessionId: string): Promise<AgentSession | null>
	/** 保存会话 */
	save(session: AgentSession): Promise<void>
	/** 删除会话 */
	delete(sessionId: string): Promise<void>
	/** 列出所有会话 */
	list(): Promise<Array<AgentSession>>
}
