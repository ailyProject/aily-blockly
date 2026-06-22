import type { Desktop } from '@/utils/desktop'
import type { TerminalPageEvent } from '../types'

/**
 * 创建终端会话。
 * @param desktop - desktop ERPC 句柄
 * @param cwd - 工作目录
 */
export const createTerminalSession = async (desktop: NonNullable<Desktop>, cwd?: string) =>
	desktop.terminal.create.mutate({
		cwd,
		cols: 120,
		rows: 32
	})

/**
 * 向终端写入数据。
 * @param desktop - desktop ERPC 句柄
 * @param sessionId - 终端会话 ID
 * @param data - 输入内容
 */
export const writeTerminalInput = (desktop: NonNullable<Desktop>, sessionId: string, data: string) =>
	desktop.terminal.write.mutate({ sessionId, data })

/**
 * 在当前终端会话中执行一次命令并等待输出稳定。
 * @param desktop - desktop ERPC 句柄
 * @param sessionId - 终端会话 ID
 * @param command - 待执行命令
 * @param idleTimeoutMs - 静默超时
 */
export const executeTerminalCommand = (
	desktop: NonNullable<Desktop>,
	sessionId: string,
	command: string,
	idleTimeoutMs?: number
) =>
	desktop.terminal.executeOnce.mutate({
		sessionId,
		command,
		idleTimeoutMs
	})

/**
 * 向终端发送 Ctrl+C 中断。
 * @param desktop - desktop ERPC 句柄
 * @param sessionId - 终端会话 ID
 */
export const interruptTerminalSession = (desktop: NonNullable<Desktop>, sessionId: string) =>
	desktop.terminal.interrupt.mutate({ sessionId })

/**
 * 把终端字符网格尺寸同步给 desktop PTY。
 * @param desktop - desktop ERPC 句柄
 * @param sessionId - 终端会话 ID
 * @param cols - 列数
 * @param rows - 行数
 */
export const resizeTerminalSession = (desktop: NonNullable<Desktop>, sessionId: string, cols: number, rows: number) =>
	desktop.terminal.resize.mutate({ sessionId, cols, rows })

/**
 * 关闭终端会话。
 * @param desktop - desktop ERPC 句柄
 * @param sessionId - 终端会话 ID
 */
export const closeTerminalSession = (desktop: NonNullable<Desktop>, sessionId: string) =>
	desktop.terminal.close.mutate({ sessionId })

/**
 * 订阅终端输出流。
 * @param desktop - desktop ERPC 句柄
 * @param sessionId - 终端会话 ID
 * @param onData - 输出事件回调
 */
export const subscribeTerminalStream = (
	desktop: NonNullable<Desktop>,
	sessionId: string,
	onData: (event: TerminalPageEvent) => void,
	onError: (error: unknown) => void
) =>
	desktop.terminal.stream.subscribe(
		{ sessionId },
		{
			onData: event => {
				onData(event as TerminalPageEvent)
			},
			onError
		}
	)
