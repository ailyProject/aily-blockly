import { estimateMessagesTokens } from '../../utils/tokens'
import { PromptPriority } from '../types'

import type { PromptBuildContext, PromptElement, PromptElementProvider } from '../types'

export class HistoryPromptProvider implements PromptElementProvider {
	id = 'conversation-history'

	build(context: PromptBuildContext): PromptElement | null {
		if (context.session.messages.length === 0) return null

		const committedTurns = context.session.turns ?? []
		const turnSpans = context.session.turnSpans ?? []
		if (committedTurns.length > 0 && turnSpans.length === committedTurns.length) {
			const children: Array<PromptElement> = turnSpans.map(span => {
				const isLatestCommitted = span.turnIndex === turnSpans.length - 1
				const isOldest = span.turnIndex === 0 && turnSpans.length > 3
				const turnMessages = context.session.messages.slice(span.startIdx, span.endIdx)
				const priority = isLatestCommitted
					? PromptPriority.CURRENT_TURN
					: span.hasInfoTools
						? PromptPriority.CONTEXT_INJECTION
						: isOldest
							? PromptPriority.HISTORY_OLDEST
							: PromptPriority.HISTORY

				return {
					id: span.turnId,
					priority,
					messages: turnMessages,
					tokens: estimateMessagesTokens(turnMessages),
					evictable: !isLatestCommitted
				}
			})

			return {
				id: this.id,
				priority: PromptPriority.HISTORY,
				messages: [],
				tokens: children.reduce((sum, child) => sum + child.tokens, 0),
				children
			}
		}

		return {
			id: this.id,
			priority: PromptPriority.HISTORY,
			messages: context.session.messages,
			tokens: estimateMessagesTokens(context.session.messages)
		}
	}
}
