import { object, record, string, enum as zodEnum } from 'zod'

import type { AgentApprovalRequest } from '../../capabilities/types'
import type { AgentToolDescriptor } from '../types'

const inputSchema = object({
	title: string().trim().optional(),
	reason: string().trim().min(1),
	risk: zodEnum(['low', 'medium', 'high', 'critical']).optional(),
	details: record(string(), string()).optional()
})

export const createAskApprovalTool = (): AgentToolDescriptor<AgentApprovalRequest> => ({
	name: 'ask_approval',
	description: 'Request structured user approval before continuing a risky or stateful action.',
	inputSchema,
	execute: async (input, context) => {
		const approve = context.capabilities.user?.approve
		if (!approve) {
			throw new Error('User approval capability is not configured')
		}

		return approve(input)
	}
})
