import type { normalizeAgentRuntimeConfig } from '../../session'

/**
 * 准备运行前用于解析或新建会话的参数。
 */
export interface EnsureRuntimeSessionInput {
	/** 复用的会话 ID。 */
	sessionId?: string
	/** 新会话标题。 */
	title?: string
	/** 已规整的 runtime 配置。 */
	runtimeConfig: ReturnType<typeof normalizeAgentRuntimeConfig>
}
