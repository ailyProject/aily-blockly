import { emitTerminalEvent, readTerminalSession } from './sessions'

import type { TerminalExecuteResult, TerminalShellKind } from 'shared'

export const TERMINAL_EXECUTE_MARKER_PREFIX = '__AILY_CMD_EXIT__:'

/**
 * 为 executeOnce 构造可跨 shell 解析退出码的包装命令。
 * @param shell - 当前 shell 类型
 * @param command - 原始待执行命令
 * @param marker - 当前 executeOnce 实例对应的唯一 marker
 */
export const createTerminalExecuteCommand = (shell: TerminalShellKind, command: string, marker: string) =>
	shell === 'powershell'
		? `& { ${command} }; Write-Output "${marker}$LASTEXITCODE"`
		: `${command}; printf "\\n${marker}%s\\n" "$?"`

const finishTerminalExecuteCapture = (
	sessionId: string,
	result: Omit<TerminalExecuteResult, 'sessionId'>,
	resolve: (result: TerminalExecuteResult) => void
) => {
	const session = readTerminalSession(sessionId)
	if (session.lineBuffer.length) {
		session.captureOutput += session.lineBuffer
		session.lineBuffer = ''
	}
	if (session.captureTimer) {
		clearTimeout(session.captureTimer)
		session.captureTimer = null
	}
	session.captureMarker = null
	session.captureOutput = ''
	session.captureExitCode = null
	session.captureResolve = null
	resolve({
		sessionId,
		...result
	})
}

/**
 * 为终端会话开始一次 executeOnce 捕获。
 * @param sessionId - 终端会话 ID
 * @param idleTimeoutMs - 静默超时
 */
export const waitForTerminalCommand = (sessionId: string, idleTimeoutMs = 1000) =>
	new Promise<TerminalExecuteResult>(resolve => {
		const session = readTerminalSession(sessionId)
		const marker = `${TERMINAL_EXECUTE_MARKER_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}:`
		session.captureMarker = marker
		session.captureOutput = ''
		session.captureExitCode = null
		session.captureIdleTimeoutMs = idleTimeoutMs

		const refreshTimer = () => {
			if (session.captureTimer) clearTimeout(session.captureTimer)
			session.captureTimer = setTimeout(() => {
				finishTerminalExecuteCapture(
					sessionId,
					{
						output: session.captureOutput,
						timedOut: true,
						exitCode: session.captureExitCode
					},
					resolve
				)
			}, idleTimeoutMs)
		}

		session.captureResolve = (exitCode: number | null, timedOut: boolean) => {
			finishTerminalExecuteCapture(
				sessionId,
				{
					output: session.captureOutput,
					timedOut,
					exitCode
				},
				resolve
			)
		}

		refreshTimer()
	})

/**
 * 处理 executeOnce 捕获中的一整行输出。
 * @param sessionId - 终端会话 ID
 * @param line - 已规整的一整行文本
 */
export const consumeTerminalExecuteLine = (sessionId: string, line: string) => {
	const session = readTerminalSession(sessionId)
	const marker = session.captureMarker
	if (!marker) return false

	if (line.startsWith(marker)) {
		const exitCodeValue = Number.parseInt(line.slice(marker.length).trim(), 10)
		const exitCode = Number.isFinite(exitCodeValue) ? exitCodeValue : null
		session.captureExitCode = exitCode
		session.captureResolve?.(exitCode, false)
		return true
	}

	session.captureOutput += `${line}\n`
	if (session.captureTimer) {
		clearTimeout(session.captureTimer)
		session.captureTimer = setTimeout(() => {
			session.captureResolve?.(session.captureExitCode, true)
		}, session.captureIdleTimeoutMs || 1000)
	}

	emitTerminalEvent(sessionId, {
		type: 'data',
		chunk: `${line}\n`
	})
	emitTerminalEvent(sessionId, {
		type: 'line',
		line
	})
	return true
}
