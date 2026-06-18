import { createMessageId } from './ids'

import type { AgentMessage } from '../types/message'
import type { CreateTextMessageArgs } from './types'

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
