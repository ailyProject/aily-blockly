import { createNoopAgentCapabilities } from '../capabilities'
import {
	ContextPromptProvider,
	HistoryPromptProvider,
	PromptPipeline,
	ToolContinuationPromptProvider
} from '../prompts'
import { MemoryAgentSessionStore } from '../session'
import { createDefaultToolRegistry } from '../tools'

import type { AgentRuntimeOptions } from './types'

/**
 * 解析 AgentRuntime 的默认依赖集合。
 * @param options - runtime 初始化选项
 */
export const resolveAgentRuntimeDefaults = (options: AgentRuntimeOptions = {}) => ({
	capabilities: options.capabilities ?? createNoopAgentCapabilities(),
	sessionStore: options.sessionStore ?? new MemoryAgentSessionStore(),
	registry: options.registry ?? createDefaultToolRegistry(),
	promptPipeline:
		options.promptPipeline ??
		new PromptPipeline().registerAll([
			new ContextPromptProvider(),
			new HistoryPromptProvider(),
			new ToolContinuationPromptProvider()
		])
})
