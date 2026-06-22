import { createSessionId } from '../utils/ids'

import type { AgentMessage } from '../types/message'
import type { AgentTurnRequest } from './turns/types'

export const INFO_TOOL_NAMES = new Set([
	'read_file',
	'fetch',
	'web_search',
	'grep',
	'grep_tool',
	'glob_tool',
	'get_directory_tree',
	'list_directory',
	'search_boards_libraries',
	'get_workspace_overview_tool'
])

export const getTextContent = (message: AgentMessage) =>
	message.parts
		.filter(part => part.type === 'text')
		.map(part => part.text)
		.join('')

export const buildTurnRequest = (message: AgentMessage): AgentTurnRequest => ({
	message,
	timestamp: message.metadata?.timestamp ?? Date.now(),
	content: getTextContent(message)
})

export const createToolCallRoundId = (stepIndex: number) => `round_${stepIndex}_${createSessionId()}`
