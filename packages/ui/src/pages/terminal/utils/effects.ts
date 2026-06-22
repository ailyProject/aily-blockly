import { effect } from '@angular/core'

import { resolveTerminalXtermViewport, syncTerminalXtermOutput } from '../runtime/xterm'

import type { Desktop } from '@/utils/desktop'
import type { ElementRef, Signal } from '@angular/core'
import type { TerminalXtermRuntime } from '../runtime/xterm'

/**
 * 注册 terminal 页面使用的 xterm 与 viewport 同步 effect。
 * @param input - 页面持有的 runtime、signals 与回调
 */
export const setupTerminalPageEffects = (input: {
	desktop: NonNullable<Desktop> | null
	terminalHost: Signal<ElementRef<HTMLElement> | undefined>
	terminalReady: Signal<number>
	getSessionId: () => string
	getLines: () => Array<string>
	getRuntime: () => TerminalXtermRuntime | null
	getRenderedSessionId: () => string
	getRenderedChunkCount: () => number
	setRenderedState: (state: { renderedSessionId: string; renderedChunkCount: number }) => void
	initializeTerminal: (host: HTMLElement) => void
	disposeTerminal: () => void
	syncViewport: (host: ElementRef<HTMLElement>, viewport: { cols: number; rows: number }) => Promise<void>
}) => {
	effect(onCleanup => {
		const host = input.terminalHost()?.nativeElement
		if (!host || input.getRuntime()) return

		input.initializeTerminal(host)
		onCleanup(() => {
			input.disposeTerminal()
		})
	})

	effect(onCleanup => {
		const terminalHost = input.terminalHost()?.nativeElement
		input.terminalReady()
		if (!input.desktop || !input.getSessionId() || !terminalHost || !input.getRuntime()) return

		const syncViewport = async () => {
			const nextViewport = resolveTerminalXtermViewport(input.getRuntime(), terminalHost)
			await input.syncViewport(input.terminalHost()!, nextViewport)
		}

		const observer = new ResizeObserver(() => {
			void syncViewport().catch(() => null)
		})
		observer.observe(terminalHost)
		void syncViewport().catch(() => null)

		onCleanup(() => {
			observer.disconnect()
		})
	})

	effect(() => {
		input.terminalReady()
		const runtime = input.getRuntime()
		if (!runtime) return

		input.setRenderedState(
			syncTerminalXtermOutput({
				runtime,
				sessionId: input.getSessionId(),
				renderedSessionId: input.getRenderedSessionId(),
				renderedChunkCount: input.getRenderedChunkCount(),
				chunks: input.getLines()
			})
		)
	})
}
