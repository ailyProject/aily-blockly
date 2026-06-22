import { deleteTerminalSession, emitTerminalEvent, readTerminalSession } from './sessions'
import { consumeTerminalStreamChunk } from './stream'

/**
 * 安全读取终端会话，不存在时返回空。
 * @param sessionId - 会话 ID
 */
export const readTerminalSessionSafely = (sessionId: string) => {
	try {
		return readTerminalSession(sessionId)
	} catch {
		return null
	}
}

/**
 * 绑定终端输出监听。
 * @param sessionId - 会话 ID
 * @param child - pty 子进程
 */
export const bindTerminalDataListener = (sessionId: string, child: import('@lydell/node-pty').IPty) => {
	child.onData(chunk => {
		const session = readTerminalSessionSafely(sessionId)
		if (!session) return
		if (!session.captureMarker) {
			emitTerminalEvent(sessionId, {
				type: 'data',
				chunk
			})
		}

		consumeTerminalStreamChunk(sessionId, session, chunk)
	})
}

/**
 * 绑定终端退出监听。
 * @param sessionId - 会话 ID
 * @param child - pty 子进程
 */
export const bindTerminalExitListener = (sessionId: string, child: import('@lydell/node-pty').IPty) => {
	child.onExit(({ exitCode, signal }) => {
		const session = readTerminalSessionSafely(sessionId)
		if (session?.lineBuffer) {
			const pendingLine = session.lineBuffer
			session.lineBuffer = ''
			if (!session.captureMarker) {
				emitTerminalEvent(sessionId, {
					type: 'line',
					line: pendingLine
				})
			}
		}
		if (session?.captureMarker) {
			session.captureResolve?.(session.captureExitCode ?? exitCode ?? null, false)
		}
		emitTerminalEvent(sessionId, {
			type: 'exit',
			exitCode,
			signal: typeof signal === 'number' ? signal : undefined
		})
		deleteTerminalSession(sessionId)
	})
}
