import { summarizeUploadResult } from 'shared'

import type { HardwareRunUploadResult } from './types'

/**
 * 把上传执行结果规整成统一摘要。
 * @param result - 上传执行结果
 */
export const summarizeHardwareUploadResult = (result: HardwareRunUploadResult) => summarizeUploadResult(result)
