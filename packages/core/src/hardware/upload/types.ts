/**
 * 上传端口类型
 */
export type HardwareUploadPortType =
	/** 普通串口上传 */
	| 'serial'
	/** BLE OTA 上传 */
	| 'ble'
	/** debugger 上传 */
	| 'debugger'
	/** 其它未知类型 */
	| (string & {})

/**
 * 上传反馈结果
 */
export interface HardwareUploadFeedback {
	/** 当前步骤是否成功 */
	success?: boolean
	/** 上传结果载荷 */
	data?: {
		/** 上传动作返回结果 */
		result?: {
			/** 当前状态 */
			state?: string
			/** 当前文本 */
			text?: string
			/** 保留其它字段 */
			[key: string]: unknown
		}
		/** 顶层 success */
		success?: boolean
		/** 保留其它字段 */
		[key: string]: unknown
	}
	/** 错误文本 */
	error?: string
}

/**
 * 上传错误摘要
 */
export interface HardwareUploadErrorSummary {
	/** 错误状态 */
	state: string
	/** 错误文本 */
	text: string
}

/**
 * SoftDevice 烧录结果
 */
export interface HardwareSoftdeviceFlashResult {
	/** 当前是否成功 */
	success: boolean
	/** 面向用户的消息 */
	message: string
}
