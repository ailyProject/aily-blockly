/**
 * 安全工作区选项名称
 */
export type WorkspaceSecurityName =
	/** 允许访问当前项目文件 */
	| 'project'
	/** 允许访问库目录与库源码 */
	| 'library'
/**
 * 安全工作区配置项
 */
export interface WorkspaceSecurityOption {
	/** 选项唯一名称 */
	name: WorkspaceSecurityName
	/** 设置页展示名称 */
	displayName: string
	/** 当前是否启用 */
	enabled: boolean
}
/**
 * Agent 工具开关配置
 */
export interface AgentToolsConfig {
	/** 显式启用的工具列表 */
	enabledTools: Array<string>
	/** 显式禁用的工具列表 */
	disabledTools: Array<string>
}
/**
 * 可复用的 API Key 配置
 */
export interface AgentApiKeyConfig {
	/** 配置唯一 ID */
	id: string
	/** 给用户显示的配置名称 */
	name: string
	/** 对应服务的基础地址 */
	baseUrl: string
	/** 访问该服务使用的密钥 */
	apiKey: string
	/** 当前配置是否可参与选择 */
	enabled: boolean
}
/**
 * 单个模型的可见性与连通性配置
 */
export interface AgentModelConfigOption {
	/** 模型唯一标识 */
	model: string
	/** 给用户显示的模型名称 */
	name: string
	/** 模型所属家族 */
	family: string
	/** 速度档位或描述文本 */
	speed: string
	/** 是否在模型列表中展示 */
	enabled: boolean
	/** 是否为用户自定义模型 */
	isCustom?: boolean
	/** 该模型专用的服务基础地址 */
	baseUrl?: string
	/** 该模型专用的访问密钥 */
	apiKey?: string
	/** 关联到的 API Key 配置 ID */
	apiKeyId?: string
}
/**
 * 工作区安全开关集合
 */
export interface AgentSecurityWorkspaces {
	/** 是否允许访问项目文件 */
	project?: boolean
	/** 是否允许访问库文件 */
	library?: boolean
}
/**
 * Aily Agent 配置模型
 */
export interface AilyAgentConfig {
	/** 兼容旧版本：是否启用自定义 API Key */
	useCustomApiKey?: boolean
	/** 兼容旧版本：默认 API 服务地址 */
	baseUrl?: string
	/** 兼容旧版本：默认 API 密钥 */
	apiKey?: string
	/** 单轮会话内最大工具调用次数 */
	maxCount?: number
	/** 兼容旧版本：主 Agent 默认启用的工具 */
	enabledTools?: Array<string>
	/** 兼容旧版本：主 Agent 默认禁用的工具 */
	disabledTools?: Array<string>
	/** 按 Agent 名称划分的工具配置 */
	agentTools?: Record<string, AgentToolsConfig | undefined>
	/** 文件访问安全配置 */
	securityWorkspaces?: AgentSecurityWorkspaces
	/** 可复用 API Key 配置列表 */
	apiKeys?: Array<AgentApiKeyConfig>
	/** 模型列表配置 */
	models?: Array<AgentModelConfigOption>
	/** Subagent 单次调用总超时 */
	subagentTimeout?: number
	/** 自定义上下文窗口大小，0 表示自动检测 */
	contextWindowSize?: number
	/** 工具结果压缩阈值比例 */
	compressionThresholdRatio?: number
	/** LLM 摘要阈值比例 */
	summarizationThresholdRatio?: number
	/** AI 编辑完成后是否自动保存 */
	autoSaveEdits?: boolean
}
