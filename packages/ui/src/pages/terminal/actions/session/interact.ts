import {
	executeTerminalCommand,
	interruptTerminalSession,
	saveTerminalSelectedUploadTargetId,
	writeTerminalInput
} from '../../runtime'

import type { Core } from '@/utils/core'
import type { Desktop, SelectDesktopDirectory } from '@/utils/desktop'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { Unsubscribable } from '@trpc/server/observable'
import type { TerminalPageSignals } from '../../utils/types'

/**
 * 创建 terminal 交互动作。
 * @param input - terminal 状态、宿主依赖与输出动作
 */
export const createTerminalInteractionActions = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	signals: TerminalPageSignals
	selectDesktopDirectory: SelectDesktopDirectory
	loadDesktopHostRuntimeInfo: (desktop: NonNullable<Desktop>) => Promise<DesktopHostRuntimeInfo>
	appendOutput: (text: string) => void
	getSubscription: () => Unsubscribable | null
	setSubscription: (subscription: Unsubscribable | null) => void
}) => ({
	async runPwd() {
		const sessionId = input.signals.session()?.id
		if (!input.desktop || !sessionId) return
		const result = await executeTerminalCommand(input.desktop, sessionId, 'pwd')
		input.appendOutput(`\n[executeOnce]\n${result.output}\n`)
	},
	clear() {
		input.signals.lines.set([])
		input.signals.lineCount.set(0)
	},
	async interrupt() {
		const sessionId = input.signals.session()?.id
		if (!input.desktop || !sessionId) return
		await interruptTerminalSession(input.desktop, sessionId)
	},
	async chooseUploadTarget(targetId: string) {
		const target = input.signals.uploadTargets().find(item => item.id === targetId)
		input.signals.selectedUploadTargetId.set(targetId)
		await saveTerminalSelectedUploadTargetId(input.core, input.signals.runtimeInfo(), target)
	}
})
