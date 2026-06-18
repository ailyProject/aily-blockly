import type { AgentApiKeyConfig, AgentModelConfigOption, AgentSecurityWorkspaces, AilyAgentConfig } from './types'

/**
 * Auto 自动模型选项
 */
export declare const AUTO_AGENT_MODEL: AgentModelConfigOption
/**
 * 默认安全工作区配置
 */
export declare const DEFAULT_AGENT_SECURITY_WORKSPACES: AgentSecurityWorkspaces
/**
 * 默认模型列表
 */
export declare const DEFAULT_AGENT_MODELS: Array<AgentModelConfigOption>
/**
 * 默认 API Key 配置列表
 */
export declare const DEFAULT_AGENT_API_KEYS: Array<AgentApiKeyConfig>
/**
 * 默认 Agent 最大循环次数
 */
export declare const DEFAULT_AGENT_MAX_COUNT = 100
/**
 * 默认 Subagent 超时时间（毫秒）
 */
export declare const DEFAULT_AGENT_SUBAGENT_TIMEOUT = 300000
/**
 * 默认上下文窗口大小
 */
export declare const DEFAULT_AGENT_CONTEXT_WINDOW_SIZE = 0
/**
 * 默认工具结果压缩阈值比例
 */
export declare const DEFAULT_AGENT_COMPRESSION_THRESHOLD_RATIO = 0.5
/**
 * 默认摘要阈值比例
 */
export declare const DEFAULT_AGENT_SUMMARIZATION_THRESHOLD_RATIO = 0.75
/**
 * 默认自动保存开关
 */
export declare const DEFAULT_AGENT_AUTO_SAVE_EDITS = true
/**
 * 默认 Agent 配置
 */
export declare const DEFAULT_AILY_AGENT_CONFIG: AilyAgentConfig
