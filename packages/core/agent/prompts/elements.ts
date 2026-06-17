import type { AgentCapabilities } from '../capabilities/types'
import type { AgentRuntimeConfig } from '../session/config'
import type { AgentSession } from '../session/types'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentMessage } from '../types/message'

export enum PromptPriority {
	CURRENT_TURN = 899,
	CONTEXT_INJECTION = 750,
	HISTORY = 700,
	HISTORY_OLDEST = 100,
	TOOL_CONTINUATION = 690
}

/**
 * Prompt 元素
 */
export interface PromptElement {
	/** 元素 ID */
	id: string
	/** 优先级 */
	priority: number
	/** 要注入的消息 */
	messages: Array<AgentMessage>
	/** 该元素的 token 估算 */
	tokens: number
	/** 是否允许被裁剪 */
	evictable?: boolean
	/** 子元素 */
	children?: Array<PromptElement>
}

/**
 * Prompt 构建上下文
 */
export interface PromptBuildContext {
	/** 当前会话 */
	session: AgentSession
	/** 当前 runtime 配置 */
	runtimeConfig: AgentRuntimeConfig
	/** 工具注册表 */
	registry: AgentToolRegistry
	/** 外部能力集合 */
	capabilities: AgentCapabilities
	/** 当前工具循环迭代次数 */
	toolCallingIteration: number
}

/**
 * Prompt 渲染明细
 */
export interface PromptRenderBreakdown {
	/** 元素 ID */
	id: string
	/** 优先级 */
	priority: number
	/** token 数 */
	tokens: number
	/** 消息数量 */
	messageCount: number
	/** 是否被裁剪 */
	evicted: boolean
}

/**
 * Prompt 渲染结果
 */
export interface PromptRenderResult {
	/** 最终消息数组 */
	messages: Array<AgentMessage>
	/** 总 token 数 */
	totalTokens: number
	/** 本次预算 */
	budget: number
	/** 被裁剪的元素数 */
	evictedCount: number
	/** 明细列表 */
	elementBreakdown: Array<PromptRenderBreakdown>
}

/**
 * Prompt 元素提供者接口
 */
export interface PromptElementProvider {
	/** 提供者 ID */
	id: string
	/** 构建元素 */
	build(context: PromptBuildContext): Promise<PromptElement | null> | PromptElement | null
}
