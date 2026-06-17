import { createSessionId } from '../utils/ids'
import { normalizeAgentRuntimeConfig } from './config'
import { deriveSessionHistory } from './state'
import { rebuildAgentTurnsFromMessages } from './turns'

import type { AgentSession, CreateAgentSessionInput } from './types'

export const createAgentSession = (input: CreateAgentSessionInput): AgentSession => {
	const now = new Date()
	const turns = input.turns ?? (input.messages ? rebuildAgentTurnsFromMessages(input.messages) : [])
	const hasStructuredTurns = turns.length > 0
	const built = hasStructuredTurns ? deriveSessionHistory(turns) : null

	return {
		id: input.id ?? createSessionId(),
		title: input.title?.trim() || '',
		messages: built?.messages ?? input.messages ?? [],
		turns,
		turnSpans: built?.turnSpans ?? input.turnSpans ?? [],
		revision: input.revision ?? 0,
		runtimeConfig: normalizeAgentRuntimeConfig(input.runtimeConfig),
		metadata: input.metadata ?? {},
		createdAt: input.createdAt ?? now,
		updatedAt: input.updatedAt ?? now
	}
}
