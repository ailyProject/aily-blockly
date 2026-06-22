import { writeTerminalInput } from '../runtime'
import { selectTerminalBleDevice } from './ble'

import type { Desktop } from '@/utils/desktop'
import type { WritableSignal } from '@angular/core'
import type { TerminalXtermRuntime } from '../runtime/xterm'
import type { TerminalUploadTargetOption } from '../types'

/**
 * 复制 terminal 当前选中内容或全部输出。
 * @param input - xterm 运行时与当前输出文本
 */
export const copyTerminalOutput = async (input: { runtime: TerminalXtermRuntime | null; lines: Array<string> }) => {
	const selectedText = input.runtime?.terminal.getSelection() || ''
	const text = selectedText.trim() ? selectedText : input.lines.join('')
	if (!text.trim()) return

	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text)
			return
		}
	} catch {
		// fall through to legacy copy path
	}

	const textarea = document.createElement('textarea')
	textarea.value = text
	textarea.setAttribute('readonly', 'true')
	textarea.style.position = 'fixed'
	textarea.style.opacity = '0'
	document.body.appendChild(textarea)
	textarea.select()
	document.execCommand('copy')
	document.body.removeChild(textarea)
}

/**
 * 把系统剪贴板内容写入当前 terminal 会话。
 * @param input - desktop 句柄、session 读取器与错误处理器
 */
export const pasteTerminalClipboard = async (input: {
	desktop: NonNullable<Desktop> | null
	getSessionId: () => string
	runtime: TerminalXtermRuntime | null
	onError: (error: unknown) => void
}) => {
	try {
		const text = await navigator.clipboard?.readText()
		const sessionId = input.getSessionId()
		if (!text || !input.desktop || !sessionId) return
		await writeTerminalInput(input.desktop, sessionId, text)
		input.runtime?.terminal.focus()
	} catch (error) {
		input.onError(error)
	}
}

/**
 * 通过 desktop BLE chooser 选择 terminal 上传目标。
 * @param input - BLE 依赖与错误处理器
 */
export const chooseTerminalBleDevice = (input: {
	desktop: NonNullable<Desktop> | null
	uploadTargets: WritableSignal<Array<TerminalUploadTargetOption>>
	selectedUploadTargetId: WritableSignal<string>
	chooseUploadTarget: (targetId: string) => Promise<void>
	onError: (error: unknown) => void
}) => selectTerminalBleDevice(input)
