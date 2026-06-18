import { createTextMessage } from '../../utils/messages'
import { estimateMessageTokens } from '../../utils/tokens'
import { PromptPriority } from '../types'

import type { PromptBuildContext, PromptElement, PromptElementProvider } from '../types'

const TOOL_CONTINUATION_PROMPT =
	'Above are the results of calling one or more tools. The user cannot see those raw tool results, so continue the task and explain the important outcome clearly.'

export class ToolContinuationPromptProvider implements PromptElementProvider {
	id = 'tool-continuation'

	build(context: PromptBuildContext): PromptElement | null {
		if (context.toolCallingIteration <= 0) return null

		const message = createTextMessage({
			role: 'user',
			text: TOOL_CONTINUATION_PROMPT,
			source: 'mainAgent'
		})

		return {
			id: this.id,
			priority: PromptPriority.TOOL_CONTINUATION,
			messages: [message],
			tokens: estimateMessageTokens(message)
		}
	}
}
