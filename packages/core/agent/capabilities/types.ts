export interface AgentAskUserOption {
	label: string
	description?: string
	recommended?: boolean
}

export interface AgentAskUserQuestion {
	question: string
	options?: Array<AgentAskUserOption>
	allow_freeform?: boolean
	multi_select?: boolean
}

export interface AgentAskUserRequest {
	questions: Array<AgentAskUserQuestion>
}

export interface AgentAskUserAnswer {
	question: string
	answer: string | Array<string>
}

export interface AgentAskUserResponse {
	answers: Array<AgentAskUserAnswer>
	raw?: unknown
}

export interface AgentApprovalRequest {
	title?: string
	reason: string
	risk?: 'low' | 'medium' | 'high' | 'critical'
	details?: Record<string, unknown>
}

export interface AgentApprovalResponse {
	approved: boolean
	reason?: string
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
