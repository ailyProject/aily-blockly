/**
 * 统一上传状态。
 */
export type UploadStatus =
	/** 上传完成。 */
	| 'success'
	/** 上传失败。 */
	| 'error'
	/** 用户取消。 */
	| 'cancelled'
	/** 准备尚未就绪。 */
	| 'not-ready'

/**
 * 统一上传错误码。
 */
export type UploadErrorCode =
	/** 未提供必要端口。 */
	| 'missing-port'
	/** 构建失败。 */
	| 'build-failed'
	/** 未找到构建产物。 */
	| 'artifact-missing'
	/** 上传前置未就绪。 */
	| 'not-ready'
	/** 上传超时。 */
	| 'timeout'
	/** 设备断开。 */
	| 'disconnected'
	/** 用户取消。 */
	| 'cancelled'
	/** 命令执行失败。 */
	| 'command-failed'
	/** 设备协议 ACK 失败。 */
	| 'ack-failed'
	/** 未知错误。 */
	| 'unknown'

/**
 * 统一上传通道。
 */
export type UploadChannel =
	/** 串口上传。 */
	| 'serial'
	/** BLE OTA 上传。 */
	| 'ble'
	/** 调试探针上传。 */
	| 'debugger'

/**
 * 统一上传摘要。
 */
export interface UploadResultSummary {
	/** 当前上传通道。 */
	channel: UploadChannel
	/** 当前状态。 */
	status: UploadStatus
	/** 统一错误码。 */
	errorCode?: UploadErrorCode
	/** 面向用户的摘要消息。 */
	message: string
	/** 本次关联的固件产物路径。 */
	artifactPath?: string
	/** 最近阶段摘要。 */
	latestPhaseText?: string
}

/**
 * 统一上传恢复动作建议。
 */
export interface UploadRecoveryActions {
	/** 是否适合直接重试上传。 */
	canRetry: boolean
	/** 是否应重新准备上传计划。 */
	canReprepare: boolean
	/** 是否建议先重连设备。 */
	shouldReconnect: boolean
	/** 是否建议先重新选择端口。 */
	shouldSelectPort: boolean
	/** 是否建议先修复构建问题。 */
	shouldFixBuild: boolean
}

/**
 * 上传阶段类型。
 */
export type UploadProgressPhase =
	/** 命令刚启动。 */
	| 'start'
	/** 通用上传中。 */
	| 'uploading'
	/** 擦除阶段。 */
	| 'erasing'
	/** 写入阶段。 */
	| 'programming'
	/** 校验阶段。 */
	| 'verifying'
	/** 命令结束。 */
	| 'done'

/**
 * 结构化上传进度片段。
 */
export interface UploadProgressEvent {
	/** 当前进度来自哪个步骤。 */
	step: string
	/** 当前阶段。 */
	phase: UploadProgressPhase
	/** 当前匹配到的进度百分比。 */
	progress?: number
	/** 触发该进度事件的原始日志行。 */
	line: string
}
