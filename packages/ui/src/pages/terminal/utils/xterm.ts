import { writeTerminalInput } from '../runtime'
import { createTerminalXtermRuntime, disposeTerminalXtermRuntime } from '../runtime/xterm'

import type { Desktop } from '@/utils/desktop'
import type { TerminalXtermRuntime } from '../runtime/xterm'

/**
 * 在 terminal 页面挂载 xterm 运行时。
 * @param input - 宿主元素、desktop 句柄、会话读取器与错误处理器
 */
export const mountTerminalXterm = (input: {
	host: HTMLElement
	desktop: NonNullable<Desktop> | null
	getSessionId: () => string
	onError: (error: unknown) => void
}): TerminalXtermRuntime =>
	createTerminalXtermRuntime(input.host, data => {
		const sessionId = input.getSessionId()
		if (!input.desktop || !sessionId) return

		void writeTerminalInput(input.desktop, sessionId, data).catch(error => {
			input.onError(error)
		})
	})

/**
 * 释放 terminal 页面持有的 xterm 运行时。
 * @param runtime - 当前 xterm 运行时
 */
export const unmountTerminalXterm = (runtime: TerminalXtermRuntime | null) => {
	disposeTerminalXtermRuntime(runtime)
}
