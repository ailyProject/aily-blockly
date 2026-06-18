import {
	DEFAULT_AGENT_AUTO_SAVE_EDITS,
	DEFAULT_AGENT_COMPRESSION_THRESHOLD_RATIO,
	DEFAULT_AGENT_CONTEXT_WINDOW_SIZE,
	DEFAULT_AGENT_MAX_COUNT,
	DEFAULT_AGENT_SUBAGENT_TIMEOUT,
	DEFAULT_AGENT_SUMMARIZATION_THRESHOLD_RATIO
} from 'shared'

import type { AilyAgentConfig } from 'shared'

/**
 * 判断当前配置是否启用了自定义 API 能力。
 * @param config - 当前 Agent 配置
 */
export const hasCustomAgentApiAccess = (config: AilyAgentConfig) =>
	Boolean(
		config.useCustomApiKey ||
		(config.apiKeys?.length ?? 0) > 0 ||
		config.models?.some(model => model.isCustom && model.apiKey && model.baseUrl)
	)

/**
 * 返回兼容旧版 getter 的默认基础地址。
 * @param config - 当前 Agent 配置
 */
export const getPrimaryAgentBaseUrl = (config: AilyAgentConfig) => config.apiKeys?.[0]?.baseUrl ?? config.baseUrl ?? ''

/**
 * 返回兼容旧版 getter 的默认 API Key。
 * @param config - 当前 Agent 配置
 */
export const getPrimaryAgentApiKey = (config: AilyAgentConfig) => config.apiKeys?.[0]?.apiKey ?? config.apiKey ?? ''

/**
 * 返回最大工具调用次数。
 * @param config - 当前 Agent 配置
 */
export const getAgentMaxCount = (config: AilyAgentConfig) => config.maxCount ?? DEFAULT_AGENT_MAX_COUNT

/**
 * 返回 Subagent 调用总超时时间。
 * @param config - 当前 Agent 配置
 */
export const getAgentSubagentTimeout = (config: AilyAgentConfig) =>
	config.subagentTimeout ?? DEFAULT_AGENT_SUBAGENT_TIMEOUT

/**
 * 返回上下文窗口大小。
 * @param config - 当前 Agent 配置
 */
export const getAgentContextWindowSize = (config: AilyAgentConfig) =>
	config.contextWindowSize ?? DEFAULT_AGENT_CONTEXT_WINDOW_SIZE

/**
 * 返回工具结果压缩阈值比例。
 * @param config - 当前 Agent 配置
 */
export const getAgentCompressionThresholdRatio = (config: AilyAgentConfig) =>
	config.compressionThresholdRatio ?? DEFAULT_AGENT_COMPRESSION_THRESHOLD_RATIO

/**
 * 返回摘要阈值比例。
 * @param config - 当前 Agent 配置
 */
export const getAgentSummarizationThresholdRatio = (config: AilyAgentConfig) =>
	config.summarizationThresholdRatio ?? DEFAULT_AGENT_SUMMARIZATION_THRESHOLD_RATIO

/**
 * 返回自动保存开关。
 * @param config - 当前 Agent 配置
 */
export const getAgentAutoSaveEdits = (config: AilyAgentConfig) => config.autoSaveEdits ?? DEFAULT_AGENT_AUTO_SAVE_EDITS
