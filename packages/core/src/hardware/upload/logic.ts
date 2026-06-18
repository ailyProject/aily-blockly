import { isHardwareSerialPortType } from '../ports'

import type {
	HardwareSoftdeviceFlashResult,
	HardwareUploadErrorSummary,
	HardwareUploadFeedback,
	HardwareUploadPortType
} from './types'

const DEFAULT_UPLOAD_TIMEOUT_MS = 300_000
const BLE_UPLOAD_TIMEOUT_MS = 900_000
const SERIAL_RELEASE_DELAY_MS = 300

/**
 * 解析上传超时时间。
 * @param {HardwareUploadPortType | null | undefined} portType - 上传端口类型
 * @returns {number}
 */
export const resolveHardwareUploadTimeout = (portType: HardwareUploadPortType | null | undefined) =>
	portType === 'ble' ? BLE_UPLOAD_TIMEOUT_MS : DEFAULT_UPLOAD_TIMEOUT_MS

/**
 * 判断是否需要向串口类工具发送释放信号。
 * @param {{port: string | null | undefined, portType: HardwareUploadPortType | null | undefined}} input - 端口信息
 * @returns {boolean}
 */
export const shouldNotifySerialToolsForUpload = (input: {
	port: string | null | undefined
	portType: HardwareUploadPortType | null | undefined
}) => !!input.port && isHardwareSerialPortType(input.portType)

/**
 * 获取串口释放后的缓冲时间。
 * @param {string} signal - 工具信号名
 * @returns {number}
 */
export const getHardwareUploadSignalDelay = (signal: string) =>
	signal === 'serial-monitor:disconnect' ? SERIAL_RELEASE_DELAY_MS : 0

/**
 * 判断上传反馈是否成功。
 * @param {HardwareUploadFeedback | null | undefined} feedback - 上传反馈
 * @returns {boolean}
 */
export const isHardwareUploadFeedbackSuccess = (feedback: HardwareUploadFeedback | null | undefined) => {
	const result = feedback?.data?.result
	return feedback?.success !== false && feedback?.data?.success !== false && !!result && result.state !== 'error'
}

/**
 * 提取上传错误摘要。
 * @param {HardwareUploadFeedback | null | undefined} feedback - 上传反馈
 * @returns {HardwareUploadErrorSummary}
 */
export const getHardwareUploadErrorSummary = (
	feedback: HardwareUploadFeedback | null | undefined
): HardwareUploadErrorSummary => ({
	state: feedback?.data?.result?.state || 'error',
	text: feedback?.data?.result?.text || feedback?.error || '上传失败'
})

/**
 * 归一化 SoftDevice 烧录结果。
 * @param {HardwareSoftdeviceFlashResult | null | undefined} result - 原始结果
 * @param {unknown} error - 捕获到的异常
 * @returns {HardwareSoftdeviceFlashResult}
 */
export const normalizeHardwareSoftdeviceFlashResult = (
	result: HardwareSoftdeviceFlashResult | null | undefined,
	error?: unknown
): HardwareSoftdeviceFlashResult =>
	result || {
		success: false,
		message: error instanceof Error ? error.message : '烧录失败'
	}
