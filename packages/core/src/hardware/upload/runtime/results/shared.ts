import { summarizeHardwareUploadResult } from '../../result'

import type { HardwareRunUploadResult } from '../../types'

/**
 * 构造统一的上传结果并补 summary。
 * @param result - 基础上传结果
 */
export const withHardwareUploadSummary = (result: HardwareRunUploadResult): HardwareRunUploadResult => ({
	...result,
	summary: summarizeHardwareUploadResult(result)
})
