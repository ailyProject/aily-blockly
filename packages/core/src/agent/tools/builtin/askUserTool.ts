import { array, boolean, object, string } from 'zod'

import type { AgentAskUserRequest } from '../../capabilities/types'
import type { AgentToolDescriptor } from '../types'

const optionSchema = object({
	label: string().trim().min(1),
	description: string().trim().optional(),
	recommended: boolean().optional()
})

const questionSchema = object({
	question: string().trim().min(1),
	options: array(optionSchema).optional(),
	allow_freeform: boolean().optional(),
	multi_select: boolean().optional()
})

export const createAskUserTool = (): AgentToolDescriptor<AgentAskUserRequest> => ({
	name: 'ask_user',
	description:
		'Ask the user one or more structured questions and wait for answers when the task cannot continue safely without clarification.',
	inputSchema: object({
		questions: array(questionSchema).min(1)
	}),
	execute: async (input, context) => {
		const ask = context.capabilities.user?.ask
		if (!ask) {
			throw new Error('User input capability is not configured')
		}

		return ask(input)
	}
})
