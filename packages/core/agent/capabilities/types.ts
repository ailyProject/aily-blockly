/**
 * ask_user 选项
 */
export interface AgentAskUserOption {
	/** 选项标签 */
	label: string
	/** 选项说明 */
	description?: string
	/** 是否为推荐选项 */
	recommended?: boolean
}

/**
 * 审批风险等级
 */
export type AgentApprovalRisk =
	/** 低风险操作 */
	| 'low'
	/** 中风险操作 */
	| 'medium'
	/** 高风险操作 */
	| 'high'
	/** 极高风险操作 */
	| 'critical'

/**
 * ask_user 问题
 */
export interface AgentAskUserQuestion {
	/** 问题文本 */
	question: string
	/** 可选项列表 */
	options?: Array<AgentAskUserOption>
	/** 是否允许自由输入 */
	allow_freeform?: boolean
	/** 是否允许多选 */
	multi_select?: boolean
}

/**
 * ask_user 请求体
 */
export interface AgentAskUserRequest {
	/** 问题列表 */
	questions: Array<AgentAskUserQuestion>
}

/**
 * ask_user 单项回答
 */
export interface AgentAskUserAnswer {
	/** 对应问题文本 */
	question: string
	/** 用户回答 */
	answer: string | Array<string>
}

/**
 * ask_user 响应
 */
export interface AgentAskUserResponse {
	/** 结构化回答 */
	answers: Array<AgentAskUserAnswer>
	/** 宿主返回的原始数据 */
	raw?: unknown
}

/**
 * 审批请求
 */
export interface AgentApprovalRequest {
	/** 审批标题 */
	title?: string
	/** 审批原因 */
	reason: string
	/** 风险等级 */
	risk?: AgentApprovalRisk
	/** 补充详情 */
	details?: Record<string, unknown>
}

/**
 * 审批响应
 */
export interface AgentApprovalResponse {
	/** 是否批准 */
	approved: boolean
	/** 审批原因或拒绝理由 */
	reason?: string
	/** 宿主返回的原始数据 */
	raw?: unknown
}

export interface AgentUserCapabilities {
	ask?(request: AgentAskUserRequest): Promise<AgentAskUserResponse>
	approve?(request: AgentApprovalRequest): Promise<AgentApprovalResponse>
}

export interface AgentContextCapabilities {
	getProjectContext?(): Promise<string | null> | string | null
	getMemoryPrompt?(): Promise<string | null> | string | null
	getSkillsPrompt?(): Promise<string | null> | string | null
}

export interface AgentCapabilities {
	user?: AgentUserCapabilities
	context?: AgentContextCapabilities
}
