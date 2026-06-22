import { getCurrentProjectPath, getCurrentProjectSourceCode } from '@/runtime/project-session'

import { runTerminalBleUploadAction } from './build.run.upload.ble'
import { runTerminalCommandUploadAction } from './build.run.upload.command'

import type { TerminalCurrentUploadActionInput } from './build.run.upload.types'

/**
 * 创建 terminal 的当前 upload 动作。
 * @param input - 依赖、预览动作与输出动作
 */
export const createTerminalCurrentUploadActions = (input: TerminalCurrentUploadActionInput) => ({
	async runCurrentUpload() {
		const runtimeInfo = input.signals.runtimeInfo()
		const projectPath = getCurrentProjectPath()
		const targetId = input.signals.selectedUploadTargetId().trim()
		const target = input.signals.uploadTargets().find(item => item.id === targetId) ?? null
		const sessionId = input.signals.session()?.id
		if (!runtimeInfo || !projectPath || !target) return

		input.signals.actionBusy.set(true)
		input.signals.actionKind.set('upload')
		input.signals.lastUploadSummary.set(null)
		try {
			const code = getCurrentProjectSourceCode()
			const prepared = await input.previewActions.appendUploadPlanPreview(projectPath, target, code)
			if (prepared && !prepared.ready) {
				input.appendOutput('\n[upload skipped]\n')
				return
			}
			if (target.portType === 'ble') {
				await runTerminalBleUploadAction(input, {
					runtimeInfo,
					projectPath,
					code,
					target
				})
				return
			}
			await runTerminalCommandUploadAction(input, {
				runtimeInfo,
				projectPath,
				code,
				target,
				sessionId
			})
		} catch (error) {
			input.appendOutput(`\n[upload error]\n${error instanceof Error ? error.message : String(error)}\n`)
		} finally {
			input.signals.actionKind.set('')
			input.signals.actionBusy.set(false)
		}
	}
})
