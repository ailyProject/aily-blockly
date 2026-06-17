import { tool } from 'ai'

import type { AgentCapabilities } from '../capabilities/types'
import type { AgentRuntimeEventSink } from '../runtime/events'
import type { AgentRuntimeConfig } from '../session/config'
import type { AgentSession } from '../session/types'
import type { AgentToolRegistry } from './registry'

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

export const buildToolSet = ({ registry, session, runtimeConfig, capabilities, signal, emit }: BuildToolSetArgs) => {
	const descriptors = registry.getToolsForAgent({
		agentName: runtimeConfig.agentName,
		enabledTools: runtimeConfig.enabledTools,
		disabledTools: runtimeConfig.disabledTools
	})

	return Object.fromEntries(
		descriptors.map(descriptor => [
			descriptor.name,
			tool({
				description: descriptor.description,
				inputSchema: descriptor.inputSchema,
				execute: async input =>
					descriptor.execute(input, {
						session,
						runtimeConfig,
						capabilities,
						signal,
						emit
					})
			})
		])
	)
}
