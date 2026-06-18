import { createTextMessage } from '../../utils/messages'
import { estimateMessageTokens } from '../../utils/tokens'
import { PromptPriority } from '../types'

import type { PromptBuildContext, PromptElement, PromptElementProvider } from '../types'

const ASK_MODE_ROLE_TEXT =
	'Answer questions directly and keep tool usage to a minimum unless the user explicitly needs an action.'

export class ContextPromptProvider implements PromptElementProvider {
	id = 'context-injection'

	async build(context: PromptBuildContext): Promise<PromptElement | null> {
		const parts: Array<string> = []

		if (context.runtimeConfig.mode === 'ask') {
			parts.push(`<rules>${ASK_MODE_ROLE_TEXT}</rules>`)
		}

		if (context.runtimeConfig.useDeferredToolDiscovery) {
			const deferredListing = context.registry.getDeferredToolsListing({
				agentName: context.runtimeConfig.agentName
			})
			if (deferredListing) parts.push(deferredListing)
		}

		const projectContext = await context.capabilities.context?.getProjectContext?.()
		if (projectContext) parts.push(projectContext)

		const skillsPrompt = await context.capabilities.context?.getSkillsPrompt?.()
		if (skillsPrompt) parts.push(skillsPrompt)

		const memoryPrompt = await context.capabilities.context?.getMemoryPrompt?.()
		if (memoryPrompt) parts.push(memoryPrompt)

		if (parts.length === 0) return null

		const message = createTextMessage({
			role: 'user',
			text: `<aily-context>\n${parts.join('\n')}\n</aily-context>`,
			source: 'mainAgent'
		})

		return {
			id: this.id,
			priority: PromptPriority.CONTEXT_INJECTION,
			messages: [message],
			tokens: estimateMessageTokens(message),
			evictable: false
		}
	}
}
