/**
 * Agent API 模型配置
 */
export interface AgentApiModelConfig {
	/** 模型标识 */
	model: string
	/** 提供方 API key */
	apiKey: string
	/** 自定义 base URL */
	baseUrl?: string
	/** 透传给 provider 的请求头 */
	headers?: Record<string, string>
	/** 当前 provider 类型 */
	provider?: 'openai'
	/** 采样温度 */
	temperature?: number
	/** top-p 采样参数 */
	topP?: number
	/** 最大输出 token 数 */
	maxOutputTokens?: number
	/** 推理强度 */
	reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
}
/**
 * Agent API 运行时配置
 */
export interface AgentApiRuntimeConfig {
	/** 当前模式 */
	mode?: 'agent' | 'ask'
	/** 当前 agent 名称 */
	agentName?: string
	/** 最大推理步数 */
	maxSteps?: number
	/** 最大 prompt token */
	maxPromptTokens?: number
	/** 自定义 system prompt */
	customSystemPrompt?: string
	/** 当前日期 */
	currentDate?: string
	/** 显式启用工具 */
	enabledTools?: Array<string>
	/** 显式禁用工具 */
	disabledTools?: Array<string>
	/** 是否启用 deferred tool discovery */
	useDeferredToolDiscovery?: boolean
}
/**
 * Agent session API 提交请求
 */
export interface AgentSessionRequest {
	/** resumable stream 与 session 共享的 id */
	id: string
	/** 用户输入文本 */
	text: string
	/** 会话标题 */
	title?: string
	/** 模型配置 */
	model: AgentApiModelConfig
	/** 运行时配置覆盖 */
	runtimeConfig?: AgentApiRuntimeConfig
	/** 附加元数据 */
	metadata?: Record<string, unknown>
}
