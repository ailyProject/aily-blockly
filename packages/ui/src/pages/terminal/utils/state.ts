import { computed, signal } from '@angular/core'

import type { DesktopHostRuntimeInfo } from '@desktop'
import type {
	TerminalPageSession,
	TerminalPageSignals,
	TerminalUploadSummaryView,
	TerminalUploadTargetOption,
	TerminalViewportSize
} from './types'

/**
 * 创建 terminal 页面本地状态。
 */
export const createTerminalPageState = () => {
	const session = signal<TerminalPageSession | null>(null)
	const viewport = signal<TerminalViewportSize | null>(null)
	const runtimeInfo = signal<DesktopHostRuntimeInfo | null>(null)
	const uploadTargets = signal<Array<TerminalUploadTargetOption>>([])
	const selectedUploadTargetId = signal('')
	const lastUploadSummary = signal<TerminalUploadSummaryView | null>(null)
	const lines = signal<Array<string>>([])
	const lineCount = signal(0)
	const actionBusy = signal(false)
	const actionKind = signal<'terminal' | 'build' | 'upload' | ''>('')
	const loading = signal(true)
	const error = signal<string | null>(null)
	const bleBridgeAvailable = signal(false)
	const selectedUploadTarget = computed(
		() => uploadTargets().find(target => target.id === selectedUploadTargetId()) ?? null
	)
	const selectedUploadTargetLabel = computed(() => selectedUploadTarget()?.label || '')

	const signals: TerminalPageSignals = {
		session,
		viewport,
		runtimeInfo,
		uploadTargets,
		selectedUploadTargetId,
		lastUploadSummary,
		lines,
		lineCount,
		actionBusy,
		actionKind,
		loading,
		error
	}

	return {
		session,
		viewport,
		runtimeInfo,
		uploadTargets,
		selectedUploadTargetId,
		lastUploadSummary,
		lines,
		lineCount,
		actionBusy,
		actionKind,
		loading,
		error,
		bleBridgeAvailable,
		selectedUploadTarget,
		selectedUploadTargetLabel,
		signals
	}
}
