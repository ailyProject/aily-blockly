import type { IPty } from '@lydell/node-pty'
import type { TerminalExecuteResult, TerminalSessionInfo, TerminalStreamEvent } from 'shared'

type TerminalSessionRecord = {
	info: TerminalSessionInfo
	pty: IPty
	listeners: Set<(event: TerminalStreamEvent) => void>
	lineBuffer: string
	skipNextLf: boolean
	captureMarker: string | null
	captureOutput: string
	captureExitCode: number | null
	captureResolve: ((exitCode: number | null, timedOut: boolean) => void) | null
	captureTimer: ReturnType<typeof setTimeout> | null
	captureIdleTimeoutMs: number
}

const sessions = new Map<string, TerminalSessionRecord>()

/**
 * 读取终端会话记录。
 * @param sessionId - 终端会话 ID
 */
export const readTerminalSession = (sessionId: string) => {
	const session = sessions.get(sessionId)
	if (!session) {
		throw new Error(`Terminal session not found: ${sessionId}`)
	}
	return session
}

/**
 * 写入新的终端会话记录。
 * @param sessionId - 终端会话 ID
 * @param session - 会话记录
 */
export const writeTerminalSession = (sessionId: string, session: TerminalSessionRecord) => {
	sessions.set(sessionId, session)
}

/**
 * 删除终端会话记录。
 * @param sessionId - 终端会话 ID
 */
export const deleteTerminalSession = (sessionId: string) => {
	sessions.delete(sessionId)
}

/**
 * 向订阅者广播终端事件。
 * @param sessionId - 终端会话 ID
 * @param event - 事件载荷
 */
export const emitTerminalEvent = (sessionId: string, event: Omit<TerminalStreamEvent, 'sessionId'>) => {
	const session = sessions.get(sessionId)
	if (!session) return

	const payload: TerminalStreamEvent = {
		sessionId,
		...event
	}
	for (const listener of session.listeners) {
		listener(payload)
	}
}

export type { TerminalExecuteResult }
