import type { AgentSessionRequest } from '@shared'

/**
 * 构建 agent API 句柄时的地址覆盖项
 */
export interface CreateAgentApiOptions {
	/** 直接指定完整 agent session API 地址 */
	api?: string
	/** 直接指定完整 base URL */
	baseUrl?: string
}

/**
 * Agent API transport 的提交选项
 */
export interface AgentApiSendOptions {
	/** 可选中断信号 */
	signal?: AbortSignal
}

/**
 * Agent API transport 句柄
 */
export interface AgentApi {
	/** agent session API 地址 */
	api: string
	/** 提交一轮 agent 请求并返回 SSE/stream body */
	send(request: AgentSessionRequest, options?: AgentApiSendOptions): Promise<ReadableStream<Uint8Array> | null>
	/** 使用相同 id 恢复已有流 */
	resume(id: string, options?: AgentApiSendOptions): Promise<ReadableStream<Uint8Array> | null>
}
