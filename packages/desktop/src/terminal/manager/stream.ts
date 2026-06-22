import { consumeTerminalExecuteLine } from './execute'
import { emitTerminalEvent } from './sessions'

type TerminalLineState = {
	lineBuffer: string
	skipNextLf: boolean
}

const flushTerminalLine = (sessionId: string, state: TerminalLineState) => {
	if (!state.lineBuffer.length) return
	if (consumeTerminalExecuteLine(sessionId, state.lineBuffer)) {
		state.lineBuffer = ''
		return
	}
	emitTerminalEvent(sessionId, {
		type: 'line',
		line: state.lineBuffer
	})
	state.lineBuffer = ''
}

/**
 * 消费一段 PTY 输出，并按更接近终端语义的边界发出 line 事件。
 * @param sessionId - 会话 ID
 * @param state - 当前会话的行缓冲状态
 * @param chunk - 原始 PTY 文本块
 */
export const consumeTerminalStreamChunk = (sessionId: string, state: TerminalLineState, chunk: string) => {
	for (const character of chunk) {
		if (state.skipNextLf && character === '\n') {
			state.skipNextLf = false
			continue
		}
		state.skipNextLf = false

		if (character === '\u0003') {
			flushTerminalLine(sessionId, state)
			if (!consumeTerminalExecuteLine(sessionId, '\u0003')) {
				emitTerminalEvent(sessionId, {
					type: 'line',
					line: '\u0003'
				})
			}
			continue
		}

		if (character === '\r') {
			flushTerminalLine(sessionId, state)
			state.skipNextLf = true
			continue
		}

		if (character === '\n') {
			flushTerminalLine(sessionId, state)
			continue
		}

		state.lineBuffer += character
	}
}
