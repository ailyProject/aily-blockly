import type { AgentMessage } from '../types/message'

/**
 * 创建文本消息所需参数
 */
export interface CreateTextMessageArgs {
	/** 消息角色 */
	role: AgentMessage['role']
	/** 文本内容 */
	text: string
	/** 消息来源 */
	source?: string
	/** 使用的模型标识 */
	model?: string
}
