import * as pty from '@lydell/node-pty'

import {
	DEFAULT_TERMINAL_COLS,
	DEFAULT_TERMINAL_ROWS,
	resolveTerminalDefaultCwd,
	resolveTerminalEnv,
	resolveTerminalShellArgs,
	resolveTerminalShellCommand,
	resolveTerminalShellKind
} from './env'
import { createTerminalExecuteCommand, waitForTerminalCommand } from './execute'
import { killTerminalProcessTree } from './kill'
import { bindTerminalDataListener, bindTerminalExitListener } from './listeners'
import { deleteTerminalSession, readTerminalSession, writeTerminalSession } from './sessions'
import { createTerminalSessionId } from './shared'

import type { TerminalSessionInfo } from 'shared'
import type { DesktopTerminalManager } from '../types'

/**
 * 创建 desktop 终端管理器。
 */
export const createDesktopTerminalManager = (): DesktopTerminalManager => ({
	async createSession(options = {}) {
		const shell = resolveTerminalShellKind()
		const cols = options.cols ?? DEFAULT_TERMINAL_COLS
		const rows = options.rows ?? DEFAULT_TERMINAL_ROWS
		const cwd = options.cwd || resolveTerminalDefaultCwd()
		const id = createTerminalSessionId()

		const child = pty.spawn(resolveTerminalShellCommand(shell), resolveTerminalShellArgs(shell), {
			name: 'xterm-color',
			cols,
			rows,
			cwd,
			env: resolveTerminalEnv()
		})

		const info: TerminalSessionInfo = {
			id,
			pid: child.pid,
			shell,
			cwd,
			cols,
			rows
		}
		writeTerminalSession(id, {
			info,
			pty: child,
			listeners: new Set(),
			lineBuffer: '',
			skipNextLf: false,
			captureMarker: null,
			captureOutput: '',
			captureExitCode: null,
			captureResolve: null,
			captureTimer: null,
			captureIdleTimeoutMs: 1000
		})
		bindTerminalDataListener(id, child)
		bindTerminalExitListener(id, child)

		return info
	},
	async write(sessionId, data) {
		readTerminalSession(sessionId).pty.write(data)
	},
	async executeOnce(sessionId, command, idleTimeoutMs) {
		const session = readTerminalSession(sessionId)
		const resultPromise = waitForTerminalCommand(sessionId, idleTimeoutMs)
		const wrappedCommand = createTerminalExecuteCommand(
			session.info.shell,
			command,
			session.captureMarker || '__AILY_CMD_EXIT__:'
		)
		session.pty.write(`${wrappedCommand}\r`)
		return resultPromise
	},
	async interrupt(sessionId) {
		readTerminalSession(sessionId).pty.write('\u0003')
	},
	async resize(sessionId, cols, rows) {
		const session = readTerminalSession(sessionId)
		session.pty.resize(cols, rows)
		session.info = {
			...session.info,
			cols,
			rows
		}
	},
	async close(sessionId) {
		const session = readTerminalSession(sessionId)
		await killTerminalProcessTree(session.info.pid)
		session.pty.kill()
		deleteTerminalSession(sessionId)
	},
	subscribe(sessionId, listener) {
		const session = readTerminalSession(sessionId)
		session.listeners.add(listener)
		return () => {
			session.listeners.delete(listener)
		}
	}
})
