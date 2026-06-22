import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

import { measureTerminalViewport } from '../sizing.runtime'

import type { TerminalViewportSize } from '../types'

/**
 * terminal 页面持有的 xterm 运行时句柄。
 */
export interface TerminalXtermRuntime {
	/**
	 * 当前 xterm 实例。
	 */
	terminal: Terminal

	/**
	 * 当前使用的 fit addon。
	 */
	fitAddon: FitAddon

	/**
	 * 当前使用的 clipboard addon。
	 */
	clipboardAddon: ClipboardAddon
}

/**
 * 在指定宿主节点上创建 xterm 终端。
 * @param host - 渲染宿主元素
 * @param onData - 用户输入回调
 */
export const createTerminalXtermRuntime = (host: HTMLElement, onData: (data: string) => void): TerminalXtermRuntime => {
	const terminal = new Terminal({
		cursorBlink: true,
		convertEol: false,
		fontFamily: 'GeistMono, ui-monospace, monospace',
		fontSize: 13,
		lineHeight: 1.45,
		scrollback: 6000,
		theme: {
			background: '#0b1020',
			foreground: '#d7e4ff',
			selectionBackground: 'rgba(130, 170, 255, 0.28)',
			cursor: '#d7e4ff'
		}
	})
	const fitAddon = new FitAddon()
	const clipboardAddon = new ClipboardAddon()
	terminal.loadAddon(fitAddon)
	terminal.loadAddon(clipboardAddon)
	terminal.open(host)
	fitAddon.fit()
	terminal.onData(onData)

	return {
		terminal,
		fitAddon,
		clipboardAddon
	}
}

/**
 * 销毁 xterm 运行时句柄。
 * @param runtime - xterm 运行时
 */
export const disposeTerminalXtermRuntime = (runtime: TerminalXtermRuntime | null) => {
	runtime?.terminal.dispose()
}

/**
 * 根据当前 xterm 句柄推导字符网格尺寸。
 * @param runtime - xterm 运行时
 * @param host - 渲染宿主元素
 */
export const resolveTerminalXtermViewport = (
	runtime: TerminalXtermRuntime | null,
	host: HTMLElement
): TerminalViewportSize => {
	const proposed = runtime?.fitAddon.proposeDimensions()
	if (proposed?.cols && proposed?.rows) {
		return {
			cols: proposed.cols,
			rows: proposed.rows
		}
	}

	return measureTerminalViewport(host)
}

/**
 * 把新的输出片段写入 xterm，并返回更新后的渲染游标。
 * @param input - 当前 session 与输出渲染状态
 */
export const syncTerminalXtermOutput = (input: {
	runtime: TerminalXtermRuntime
	sessionId: string
	renderedSessionId: string
	renderedChunkCount: number
	chunks: Array<string>
}) => {
	let renderedSessionId = input.renderedSessionId
	let renderedChunkCount = input.renderedChunkCount

	if (renderedSessionId !== input.sessionId) {
		input.runtime.terminal.reset()
		renderedChunkCount = 0
		renderedSessionId = input.sessionId
	}

	if (input.chunks.length < renderedChunkCount) {
		input.runtime.terminal.reset()
		renderedChunkCount = 0
	}

	if (input.chunks.length > renderedChunkCount) {
		for (const chunk of input.chunks.slice(renderedChunkCount)) {
			input.runtime.terminal.write(chunk)
		}
		renderedChunkCount = input.chunks.length
		input.runtime.terminal.scrollToBottom()
	}

	return {
		renderedSessionId,
		renderedChunkCount
	}
}
