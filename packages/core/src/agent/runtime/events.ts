import type { AgentRuntimeEvent, AgentUiMessageChunk } from './types'

export type { AgentRuntimeEvent, AgentUiMessageChunk } from './types'

export const mapUiChunkToRuntimeEvent = (chunk: AgentUiMessageChunk): AgentRuntimeEvent => {
	switch (chunk.type) {
		case 'text-start':
			return { type: 'text-start', id: chunk.id, chunk }
		case 'text-delta':
			return { type: 'text-delta', id: chunk.id, text: chunk.delta, chunk }
		case 'text-end':
			return { type: 'text-end', id: chunk.id, chunk }
		case 'reasoning-start':
			return { type: 'reasoning-start', id: chunk.id, chunk }
		case 'reasoning-delta':
			return { type: 'reasoning-delta', id: chunk.id, text: chunk.delta, chunk }
		case 'reasoning-end':
			return { type: 'reasoning-end', id: chunk.id, chunk }
		case 'tool-input-start':
			return { type: 'tool-input-start', toolCallId: chunk.toolCallId, toolName: chunk.toolName, chunk }
		case 'tool-input-delta':
			return { type: 'tool-input-delta', toolCallId: chunk.toolCallId, delta: chunk.inputTextDelta, chunk }
		case 'tool-input-available':
			return {
				type: 'tool-input-available',
				toolCallId: chunk.toolCallId,
				toolName: chunk.toolName,
				input: chunk.input,
				chunk
			}
		case 'tool-input-error':
			return {
				type: 'tool-input-error',
				toolCallId: chunk.toolCallId,
				toolName: chunk.toolName,
				errorText: chunk.errorText,
				chunk
			}
		case 'tool-output-available':
			return {
				type: 'tool-output-available',
				toolCallId: chunk.toolCallId,
				output: chunk.output,
				preliminary: chunk.preliminary ?? false,
				chunk
			}
		case 'tool-output-error':
			return {
				type: 'tool-output-error',
				toolCallId: chunk.toolCallId,
				errorText: chunk.errorText,
				chunk
			}
		case 'tool-output-denied':
			return { type: 'tool-output-denied', toolCallId: chunk.toolCallId, chunk }
		case 'source-url':
			return { type: 'source-url', sourceId: chunk.sourceId, url: chunk.url, chunk }
		case 'source-document':
			return {
				type: 'source-document',
				sourceId: chunk.sourceId,
				title: chunk.title,
				mediaType: chunk.mediaType,
				chunk
			}
		case 'file':
			return { type: 'file', url: chunk.url, mediaType: chunk.mediaType, chunk }
		case 'finish':
			return { type: 'finish', chunk }
		case 'error':
			return { type: 'error', error: chunk.errorText, message: chunk.errorText }
		default:
			return { type: 'raw-chunk', chunkType: chunk.type, chunk }
	}
}
