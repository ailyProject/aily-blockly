import type { AgentMessage } from '../types/message'

const estimatePartTokens = (part: AgentMessage['parts'][number]) => {
	if (part.type === 'text') return Math.ceil(part.text.length * 0.4)
	if (part.type === 'reasoning') return Math.ceil((part.text ?? '').length * 0.4)
	if ('input' in part && part.input) return Math.ceil(JSON.stringify(part.input).length * 0.4)
	if ('output' in part && part.output) return Math.ceil(JSON.stringify(part.output).length * 0.4)
	return 12
}

export const estimateMessageTokens = (message: AgentMessage) =>
	4 + message.parts.reduce((sum, part) => sum + estimatePartTokens(part), 0)

export const estimateMessagesTokens = (messages: Array<AgentMessage>) =>
	messages.reduce((sum, message) => sum + estimateMessageTokens(message), 2)
