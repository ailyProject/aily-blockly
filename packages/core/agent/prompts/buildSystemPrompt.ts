import dayjs from 'dayjs'

import type { AgentRuntimeConfig } from '../session/config'
import type { AgentSession } from '../session/types'

const AGENT_MODE_PROMPT = [
	'You are the Aily Blockly agent runtime.',
	'Preserve existing user-visible behavior while migrating implementation details to AI SDK.',
	'Use tools when they reduce ambiguity or are required for the task.',
	'When tool results are not user-visible, summarize the relevant outcome in normal language.'
].join('\n')

const ASK_MODE_PROMPT = [
	'You are the Aily Blockly assistant in QA mode.',
	'Answer directly and do not run tools unless the user explicitly needs them.'
].join('\n')

export interface BuildSystemPromptArgs {
	session: AgentSession
	runtimeConfig: AgentRuntimeConfig
}

export const buildSystemPrompt = ({ session, runtimeConfig }: BuildSystemPromptArgs): string => {
	const modePrompt = runtimeConfig.mode === 'ask' ? ASK_MODE_PROMPT : AGENT_MODE_PROMPT

	return [
		modePrompt,
		runtimeConfig.customSystemPrompt ?? '',
		session.title ? `Current Session Title: ${session.title}` : '',
		`Real World Date: ${runtimeConfig.currentDate ?? dayjs().format('YYYY-MM-DD')}`
	]
		.filter(Boolean)
		.join('\n\n')
}
