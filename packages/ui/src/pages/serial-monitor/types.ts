import type { SerialSessionMessage, SerialSessionSnapshot } from '@core'
import type {
	QuickSendItem,
	SerialMonitorConfig,
	SerialMonitorConnectOptions,
	SerialMonitorInputMode,
	SerialMonitorViewMode,
	UploadChannel,
	UploadErrorCode,
	UploadRecoveryActions,
	UploadStatus
} from 'shared'

/**
 * 串口监视器页面状态。
 */
export interface SerialMonitorPageState {
	/** 当前可选串口列表。 */
	availablePorts: Array<string>
	/** 当前推荐波特率列表。 */
	availableBaudRates: Array<string>
	/** 当前快捷发送列表。 */
	quickSendList: Array<QuickSendItem>
	/** 当前串口持久化配置。 */
	serialMonitor: Required<SerialMonitorConfig>
	/** 当前连接参数预览。 */
	connectOptions: SerialMonitorConnectOptions
	/** 当前输入模式。 */
	inputMode: SerialMonitorInputMode
	/** 当前视图模式。 */
	viewMode: SerialMonitorViewMode
	/** 当前宿主平台。 */
	serialPlatform: string
	/** 当前串口宿主是否可用。 */
	serialAvailable: boolean
	/** 当前激活中的串口会话。 */
	session: SerialSessionSnapshot | null
}

/**
 * 串口监视器配置更新片段。
 */
export type SerialMonitorConfigPatch = Partial<Required<SerialMonitorConfig>>

/**
 * 串口列表中的最小端口条目。
 */
export interface SerialMonitorPortItem {
	/** 当前端口名称。 */
	name?: string
}

/**
 * serial-monitor 页面展示的步骤日志。
 */
export interface SerialMonitorCommandLogView {
	/** 当前日志属于哪个步骤。 */
	step: string
	/** 当前步骤标准输出。 */
	stdout: string
	/** 当前步骤标准错误。 */
	stderr: string
}

/**
 * serial-monitor 页面展示的上传结果。
 */
export interface SerialMonitorUploadResultView {
	/** 统一上传通道。 */
	channel: UploadChannel
	/** 统一上传状态。 */
	status: UploadStatus
	/** 统一错误码。 */
	errorCode?: UploadErrorCode
	/** 面向用户的摘要消息。 */
	message: string
	/** 上传是否成功。 */
	success: boolean
	/** 本次上传耗时。 */
	durationMs: number
	/** 上传端口。 */
	port?: string
	/** 固件产物路径。 */
	artifactPath?: string
	/** 最近阶段摘要。 */
	latestPhaseText?: string
	/** 分步骤日志。 */
	logs: Array<SerialMonitorCommandLogView>
	/** 当前错误文本。 */
	error?: string
	/** 统一状态展示文案。 */
	statusText?: string
	/** 面向用户的恢复建议。 */
	recoveryHint?: string
	/** 结构化恢复动作建议。 */
	recoveryActions?: UploadRecoveryActions
}
