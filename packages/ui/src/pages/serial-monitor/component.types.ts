import type { WritableSignal } from '@angular/core'
import type { SerialSessionMessage } from '@core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { SerialMonitorPageState, SerialMonitorUploadResultView } from './types'

/**
 * Serial Monitor 页面信号集合。
 */
export interface SerialMonitorSignals {
	/** 当前页面状态。 */
	state: WritableSignal<SerialMonitorPageState | null>
	/** 当前消息列表。 */
	messages: WritableSignal<Array<SerialSessionMessage>>
	/** 当前输入框内容。 */
	inputValue: WritableSignal<string>
	/** desktop 宿主运行时信息。 */
	runtimeInfo: WritableSignal<DesktopHostRuntimeInfo | null>
	/** 最近一次上传结果。 */
	uploadResult: WritableSignal<SerialMonitorUploadResultView | null>
	/** 页面加载状态。 */
	loading: WritableSignal<boolean>
	/** 当前是否忙碌。 */
	busy: WritableSignal<boolean>
	/** 页面级错误信息。 */
	error: WritableSignal<string | null>
}
