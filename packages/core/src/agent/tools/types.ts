import type { ZodTypeAny } from 'zod'
import type { AgentCapabilities } from '../capabilities/types'
import type { AgentRuntimeEventSink } from '../runtime/types'
import type { AgentRuntimeConfig } from '../session/config'
import type { AgentSession } from '../session/types'
import type { AgentToolRegistry } from './registry'

/**
 * 工具可用性级别
 */
export type AgentToolAvailability =
	/** 默认核心工具，始终可用 */
	| 'core'
	/** 按需发现和加载的工具 */
	| 'deferred'

/**
 * 工具执行上下文
 */
export interface AgentToolExecutionContext {
	/** 当前会话 */
	session: AgentSession
	/** 当前 runtime 配置 */
	runtimeConfig: AgentRuntimeConfig
	/** 外部能力集合 */
	capabilities: AgentCapabilities
	/** 取消信号 */
	signal?: AbortSignal
	/** 事件派发函数 */
	emit: AgentRuntimeEventSink
}

/**
 * 工具描述符
 */
export interface AgentToolDescriptor<TInput = unknown, TOutput = unknown> {
	/** 工具名称 */
	name: string
	/** 工具说明 */
	description: string
	/** 输入 schema */
	inputSchema: ZodTypeAny
	/** 可用性级别 */
	availability?: AgentToolAvailability
	/** 所属分组 */
	group?: string
	/** 搜索标签 */
	tags?: Array<string>
	/** 可见的 agent 列表 */
	visibleToAgents?: Array<string>
	/** 实际执行函数 */
	execute(input: TInput, context: AgentToolExecutionContext): Promise<TOutput> | TOutput
}

/**
 * 工具过滤条件
 */
export interface AgentToolFilter {
	/** 当前 agent 名称 */
	agentName: string
	/** 可选启用白名单 */
	enabledTools?: Array<string>
	/** 可选禁用黑名单 */
	disabledTools?: Array<string>
}

/**
 * 构建 AI SDK 工具集所需参数
 */
export interface BuildToolSetArgs {
	/** 工具注册表 */
	registry: AgentToolRegistry
	/** 当前会话 */
	session: AgentSession
	/** 运行时配置 */
	runtimeConfig: AgentRuntimeConfig
	/** 外部能力集合 */
	capabilities: AgentCapabilities
	/** 中断信号 */
	signal?: AbortSignal
	/** 事件派发函数 */
	emit: AgentRuntimeEventSink
}

/**
 * deferred 工具列表渲染参数
 */
export interface DeferredToolListingOptions {
	/** 当前 agent 名称 */
	agentName: string
	/** 可选启用白名单 */
	enabledTools?: Array<string>
	/** 可选禁用黑名单 */
	disabledTools?: Array<string>
}
