import type { TerminalSessionInfo, TerminalStreamEvent, UploadChannel, UploadErrorCode, UploadStatus } from 'shared'

/**
 * 终端页面当前计算出的字符网格尺寸。
 */
export interface TerminalViewportSize {
	/** 终端可见列数。 */
	cols: number
	/** 终端可见行数。 */
	rows: number
}

/**
 * terminal 页面可见的上传目标条目。
 */
export interface TerminalUploadTargetOption {
	/** 当前目标稳定标识。 */
	id: string
	/** 当前目标类型。 */
	portType: 'serial' | 'debugger' | 'ble'
	/** 面向用户展示的目标名称。 */
	label: string
	/** 串口路径。 */
	name?: string
	/** debugger 对应的 probe serial。 */
	probeSerial?: string
	/** debugger 对应的 probe vid:pid。 */
	probeVidPid?: string
	/** BLE 设备 ID。 */
	deviceId?: string
}

/**
 * terminal 页面最近一次上传摘要。
 */
export interface TerminalUploadSummaryView {
	/** 上传通道。 */
	channel: UploadChannel
	/** 上传状态。 */
	status: UploadStatus
	/** 结构化错误码。 */
	errorCode?: UploadErrorCode
	/** 摘要消息。 */
	message: string
	/** 固件产物路径。 */
	artifactPath?: string
	/** 最近阶段。 */
	latestPhaseText?: string
	/** 恢复提示。 */
	recoveryHint: string
}

export type TerminalPageEvent = TerminalStreamEvent
export type TerminalPageSession = TerminalSessionInfo
