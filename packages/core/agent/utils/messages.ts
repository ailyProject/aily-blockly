import { createMessageId } from './ids'

import type { AgentMessage } from '../types/message'

export interface CreateTextMessageArgs {
	role: AgentMessage['role']
	text: string
	source?: string
	model?: string
}

export const createTextMessage = ({ role, text, source, model }: CreateTextMessageArgs): AgentMessage => ({
	id: createMessageId(),
	role,
	parts: [{ type: 'text', text }],
	metadata: {
		timestamp: Date.now(),
		source,
		model
	},
	createdAt: new Date()
})
