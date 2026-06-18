import type { LanguageModelUsage, UIDataTypes, UIMessage, UITools } from 'ai'

/**
 * Agent 状态块状态
 */
export type AgentStateStatus =
	/** 进行中状态 */
	| 'doing'
	/** 完成状态 */
	| 'done'
	/** 警告状态 */
	| 'warn'
	/** 错误状态 */
	| 'error'

/**
 * agent-state 数据块
 */
export interface AgentStateData {
	/** 状态块 ID */
	id: string
	/** 状态值 */
	state: AgentStateStatus
	/** 显示文本 */
	text: string
}

/**
 * 自定义 UI data parts
 */
export interface AgentDataParts extends UIDataTypes {
	/** 供 UI 展示运行进度和状态块的自定义片段 */
	'agent-state': AgentStateData
}

/**
 * Agent 消息元数据
 */
export interface AgentMessageMetadata {
	/** 生成时间戳 */
	timestamp: number
	/** 消息来源 */
	source?: string
	/** 使用的模型标识 */
	model?: string
	/** 模型使用量 */
	usage?: LanguageModelUsage
}

/**
 * Agent UI tools 类型别名
 */
export type AgentUiTools = UITools

/**
 * Agent UI 消息类型
 */
export type AgentMessage = UIMessage<AgentMessageMetadata, AgentDataParts, AgentUiTools> & { createdAt?: Date }
