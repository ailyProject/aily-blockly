import type { WritableSignal } from '@angular/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type {
	TerminalPageSession,
	TerminalUploadSummaryView,
	TerminalUploadTargetOption,
	TerminalViewportSize
} from './types'

/**
 * Terminal 页面信号集合。
 */
export interface TerminalPageSignals {
	/** 当前终端会话。 */
	session: WritableSignal<TerminalPageSession | null>
	/** 当前字符网格尺寸。 */
	viewport: WritableSignal<TerminalViewportSize | null>
	/** 当前宿主运行时信息。 */
	runtimeInfo: WritableSignal<DesktopHostRuntimeInfo | null>
	/** 当前可见上传目标列表。 */
	uploadTargets: WritableSignal<Array<TerminalUploadTargetOption>>
	/** 当前选中的上传目标。 */
	selectedUploadTargetId: WritableSignal<string>
	/** 最近一次上传摘要。 */
	lastUploadSummary: WritableSignal<TerminalUploadSummaryView | null>
	/** 当前输出文本片段。 */
	lines: WritableSignal<Array<string>>
	/** 当前累计行数。 */
	lineCount: WritableSignal<number>
	/** 当前是否有动作执行中。 */
	actionBusy: WritableSignal<boolean>
	/** 当前正在执行的动作类型。 */
	actionKind: WritableSignal<'terminal' | 'build' | 'upload' | ''>
	/** 页面初始化是否仍在进行。 */
	loading: WritableSignal<boolean>
	/** 页面级错误信息。 */
	error: WritableSignal<string | null>
}
