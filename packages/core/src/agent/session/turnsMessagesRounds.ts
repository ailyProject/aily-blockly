import { createMessageId } from '../utils/ids'
import { createTextMessage } from '../utils/messages'
import { buildToolParts } from './turnsMessagesParts'

import type { AgentMessage } from '../types/message'
import type { AgentToolCallRound } from './turns/types'

/**
 * 生成 turn 级摘要消息。
 * @param turnId - 当前 turn ID
 * @param summary - 摘要文本
 */
export const createSummaryMessage = (turnId: string, summary: string): AgentMessage =>
	createTextMessage({
		role: 'system',
		text: `<conversation-summary turn="${turnId}">\n${summary}\n</conversation-summary>`
	})

/**
 * 将单个工具调用 round 构造成 assistant message。
 * @param round - 单轮工具调用记录
 */
export const buildMessageFromToolCallRound = (round: AgentToolCallRound): AgentMessage => ({
	id: createMessageId(),
	role: 'assistant',
	metadata: { timestamp: Date.now() },
	parts: [
		...(round.assistantText ? [{ type: 'text' as const, text: round.assistantText, state: 'done' as const }] : []),
		...buildToolParts(round.toolExecutions)
	]
})
