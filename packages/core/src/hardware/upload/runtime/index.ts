import { killCurrentUploadChild, setCurrentUploadCancelled } from './execute'
import { createPreflightUploadResult } from './preflight'
import { prepareHardwareUploadExecution } from './prepare'
import { runPreparedHardwareUpload } from './run'

import type { HardwareRunUploadInput, HardwareRunUploadResult } from '../types'

export * from './prepare'

/**
 * 取消当前正在执行的上传。
 */
export const cancelHardwareUpload = () => {
	setCurrentUploadCancelled(true)
	return killCurrentUploadChild()
}

/**
 * 执行项目上传链路。
 * @param input - 上传输入
 */
export const runHardwareUpload = async (input: HardwareRunUploadInput): Promise<HardwareRunUploadResult> => {
	const startedAt = Date.now()
	setCurrentUploadCancelled(false)
	const prepared = await prepareHardwareUploadExecution(input)
	const preflightResult = createPreflightUploadResult(startedAt, prepared)
	if (preflightResult) return preflightResult

	return runPreparedHardwareUpload(
		startedAt,
		prepared as typeof prepared & { ready: true; step: NonNullable<typeof prepared.step> }
	)
}
