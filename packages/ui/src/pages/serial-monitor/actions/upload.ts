import { getCurrentProjectPath, getCurrentProjectSourceCode } from '@/runtime/project-session'

import { runSerialMonitorUpload } from '../utils/upload'

import type { Core } from '@/utils/core'
import type { SerialMonitorSignals } from '../types'

/**
 * 创建 Serial Monitor 上传动作。
 * @param input - 页面信号与 core 依赖
 */
export const createSerialMonitorUploadActions = (input: { core: Core; signals: SerialMonitorSignals }) => ({
	async runUpload() {
		const current = input.signals.state()
		const runtimeInfo = input.signals.runtimeInfo()
		const projectPath = getCurrentProjectPath()
		if (!current?.connectOptions.path || !runtimeInfo || !projectPath) return

		input.signals.busy.set(true)
		input.signals.error.set(null)
		try {
			input.signals.uploadResult.set(
				await runSerialMonitorUpload({
					core: input.core,
					runtimeInfo,
					state: current,
					projectPath,
					code: getCurrentProjectSourceCode()
				})
			)
		} catch (error) {
			input.signals.uploadResult.set(null)
			input.signals.error.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.busy.set(false)
		}
	}
})
