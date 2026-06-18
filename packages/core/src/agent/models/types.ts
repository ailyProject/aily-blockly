import type { ProviderOptions } from '@ai-sdk/provider-utils'
import type { LanguageModel, ToolSet } from 'ai'

/**
 * Agent 模型配置
 */
export interface AgentModelConfig {
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
	reasoningEffort?: AgentReasoningEffort
}

/**
 * 解析后的模型实例
 */
export interface ResolvedAgentModel {
	/** 可直接交给 AI SDK 的模型实例 */
	model: LanguageModel
	/** provider 专属选项 */
	providerOptions?: ProviderOptions
	/** provider 自带的补充工具 */
	tools?: ToolSet
}

/**
 * 模型推理强度
 */
export type AgentReasoningEffort =
	/** 最小推理开销 */
	| 'minimal'
	/** 低推理强度 */
	| 'low'
	/** 中等推理强度 */
	| 'medium'
	/** 高推理强度 */
	| 'high'
