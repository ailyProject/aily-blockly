import type { AgentCapabilities } from '../capabilities'
import type { AgentModelConfig } from '../models'
import type { PromptPipeline } from '../prompts'
import type {
	AgentRuntimeConfig,
	AgentSession,
	AgentSessionStore,
	ApplySessionSummaryArgs,
	CreateAgentSessionInput
} from '../session'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentMessage } from '../types/message'

/**
 * Agent runtime 初始化选项
 */
export interface AgentRuntimeOptions {
	/** 外部能力集合 */
	capabilities?: AgentCapabilities
	/** 会话存储实现 */
	sessionStore?: AgentSessionStore
	/** 工具注册表 */
	registry?: AgentToolRegistry
	/** Prompt pipeline 实现 */
	promptPipeline?: PromptPipeline
}

/**
 * 单次运行输入
 */
export interface AgentRunInput {
	/** 复用的会话 ID */
	sessionId?: string
	/** 会话标题 */
	title?: string
	/** 用户输入文本 */
	text: string
	/** 模型配置 */
	model: AgentModelConfig
	/** 运行时配置覆盖 */
	runtimeConfig?: Partial<AgentRuntimeConfig>
	/** 附加元数据 */
	metadata?: Record<string, unknown>
	/** 中断信号 */
	signal?: AbortSignal
}

/**
 * 单次运行结果
 */
export interface AgentRunResult {
	/** 更新后的会话 */
	session: AgentSession
	/** 本轮生成的消息 */
	responseMessages: Array<AgentMessage>
}

/**
 * runtime 暴露的会话控制面
 */
export interface AgentRuntimeSessionControls {
	/** 创建会话 */
	createSession(input: CreateAgentSessionInput): Promise<AgentSession>
	/** 读取会话 */
	getSession(sessionId: string): Promise<AgentSession | null>
	/** 保存会话 */
	saveSession(session: AgentSession): Promise<AgentSession>
	/** 截断到指定 turn */
	truncateToTurn(sessionId: string, turnId: string): Promise<AgentSession | null>
	/** 删除某个 turn 及之后的历史 */
	removeFromTurn(sessionId: string, turnId: string): Promise<AgentSession | null>
	/** 移除最后一个未完成 turn */
	removeIncompleteLast(sessionId: string): Promise<AgentSession | null>
	/** 应用摘要 */
	applySummary(
		sessionId: string,
		args: ApplySessionSummaryArgs
	): Promise<{ applied: boolean; session: AgentSession | null }>
}
