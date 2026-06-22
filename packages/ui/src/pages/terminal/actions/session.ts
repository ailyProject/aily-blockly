import { createTerminalInteractionActions } from './session.interact'
import { createTerminalLifecycleActions } from './session.lifecycle'

import type { Core } from '@/utils/core'
import type { Desktop, SelectDesktopDirectory } from '@/utils/desktop'
import type { ElementRef } from '@angular/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { Unsubscribable } from '@trpc/server/observable'
import type { TerminalPageSignals } from '../component.types'
import type { TerminalViewportSize } from '../types'

export * from './session.interact'
export * from './session.lifecycle'

/**
 * 创建 terminal 会话相关动作。
 * @param input - terminal 状态、宿主依赖与输出动作
 */
export const createTerminalSessionActions = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	signals: TerminalPageSignals
	selectDesktopDirectory: SelectDesktopDirectory
	loadDesktopHostRuntimeInfo: (desktop: NonNullable<Desktop>) => Promise<DesktopHostRuntimeInfo>
	appendOutput: (text: string) => void
	getSubscription: () => Unsubscribable | null
	setSubscription: (subscription: Unsubscribable | null) => void
}) => {
	const lifecycle = createTerminalLifecycleActions(input)
	const interactions = createTerminalInteractionActions(input)

	return {
		...lifecycle,
		...interactions,
		async syncViewport(outputBox: ElementRef<HTMLElement>, viewport: TerminalViewportSize) {
			const session = input.signals.session()
			if (!input.desktop || !session) return
			const currentViewport = input.signals.viewport()
			if (currentViewport && currentViewport.cols === viewport.cols && currentViewport.rows === viewport.rows) return
			const { resizeTerminalSession } = await import('../runtime')
			await resizeTerminalSession(input.desktop, session.id, viewport.cols, viewport.rows)
			input.signals.viewport.set(viewport)
		}
	}
}
