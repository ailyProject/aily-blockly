import type { AgentApiKeyConfig, AgentModelConfigOption, AgentSecurityWorkspaces, AilyAgentConfig } from './types'

/**
 * Auto 自动模型选项
 */
export const AUTO_AGENT_MODEL: AgentModelConfigOption = {
	model: 'auto',
	name: 'Auto',
	family: 'auto',
	speed: '1x',
	enabled: true,
	isCustom: false
}

/**
 * 默认安全工作区配置
 */
export const DEFAULT_AGENT_SECURITY_WORKSPACES: AgentSecurityWorkspaces = {
	project: true,
	library: true
}

/**
 * 默认模型列表
 */
export const DEFAULT_AGENT_MODELS: Array<AgentModelConfigOption> = []

/**
 * 默认 API Key 配置列表
 */
export const DEFAULT_AGENT_API_KEYS: Array<AgentApiKeyConfig> = []

/**
 * 默认 Agent 最大循环次数
 */
export const DEFAULT_AGENT_MAX_COUNT = 100

/**
 * 默认 Subagent 超时时间（毫秒）
 */
export const DEFAULT_AGENT_SUBAGENT_TIMEOUT = 300_000

/**
 * 默认上下文窗口大小
 */
export const DEFAULT_AGENT_CONTEXT_WINDOW_SIZE = 0

/**
 * 默认工具结果压缩阈值比例
 */
export const DEFAULT_AGENT_COMPRESSION_THRESHOLD_RATIO = 0.5

/**
 * 默认摘要阈值比例
 */
export const DEFAULT_AGENT_SUMMARIZATION_THRESHOLD_RATIO = 0.75

/**
 * 默认自动保存开关
 */
export const DEFAULT_AGENT_AUTO_SAVE_EDITS = true

/**
 * 默认 Agent 配置
 */
export const DEFAULT_AILY_AGENT_CONFIG: AilyAgentConfig = {
	maxCount: DEFAULT_AGENT_MAX_COUNT,
	enabledTools: [],
	disabledTools: [],
	securityWorkspaces: DEFAULT_AGENT_SECURITY_WORKSPACES,
	apiKeys: DEFAULT_AGENT_API_KEYS,
	models: DEFAULT_AGENT_MODELS,
	subagentTimeout: DEFAULT_AGENT_SUBAGENT_TIMEOUT,
	contextWindowSize: DEFAULT_AGENT_CONTEXT_WINDOW_SIZE,
	compressionThresholdRatio: DEFAULT_AGENT_COMPRESSION_THRESHOLD_RATIO,
	summarizationThresholdRatio: DEFAULT_AGENT_SUMMARIZATION_THRESHOLD_RATIO,
	autoSaveEdits: DEFAULT_AGENT_AUTO_SAVE_EDITS
}
