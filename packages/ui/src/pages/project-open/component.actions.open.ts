import { focusDesktopProcess } from '@/utils/desktop'

import {
	formatProjectOpenConflictMessage,
	loadProjectOpenLifecycle,
	openExistingProject,
	resolveProjectOpenSessionConflict
} from './runtime'

import type { ProjectOpenActionContext } from './component.actions.types'

/**
 * 创建 Project Open 的打开动作。
 * @param input - 页面依赖与状态
 */
export const createProjectOpenOpenActions = (input: ProjectOpenActionContext) => ({
	async openProject() {
		const projectPath = input.state.resolvedProjectPath().trim()
		if (!projectPath) return

		input.state.openBusy.set(true)
		input.state.statusMessage.set(null)
		try {
			const lifecycle = await loadProjectOpenLifecycle(input.core, projectPath)
			input.state.previewLifecycle.set(lifecycle)
			if (!lifecycle.hasPackageJson) {
				input.state.statusMessage.set('Resolved directory is not a valid project.')
				return
			}
			const conflict = resolveProjectOpenSessionConflict(projectPath, lifecycle, input.state.runtimeInfo()?.pid)
			if (conflict) {
				input.state.openSessionConflict.set(conflict)
				input.state.statusMessage.set(formatProjectOpenConflictMessage(conflict.owner))
				return
			}

			await openExistingProject(input.core, input.router, projectPath)
		} catch (error) {
			input.state.statusMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.state.openBusy.set(false)
		}
	},
	cancelConflictOpen() {
		const conflict = input.state.openSessionConflict()
		if (!conflict) return
		input.state.openSessionConflict.set(null)
		input.state.statusMessage.set(`Open canceled for ${conflict.projectPath}.`)
	},
	async focusConflictOwner() {
		const conflict = input.state.openSessionConflict()
		if (!conflict?.pid) {
			input.state.statusMessage.set('Current conflict does not expose a focusable desktop process.')
			return
		}
		if (!input.desktop) {
			input.state.statusMessage.set('Desktop focus is only available inside the Electron host.')
			return
		}

		input.state.openBusy.set(true)
		input.state.statusMessage.set(null)
		try {
			const result = await focusDesktopProcess(input.desktop, conflict.pid)
			if (!result.success) {
				input.state.statusMessage.set(result.error || 'Failed to focus the existing desktop session.')
				return
			}

			input.state.statusMessage.set(
				`Requested desktop process ${conflict.pid} to come forward for ${conflict.projectPath}.`
			)
		} catch (error) {
			input.state.statusMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.state.openBusy.set(false)
		}
	},
	async forceOpenProject() {
		const conflict = input.state.openSessionConflict()
		if (!conflict?.projectPath) return

		input.state.openBusy.set(true)
		input.state.statusMessage.set(null)
		try {
			await input.core.project.releaseOpenSessionLock.mutate({
				projectPath: conflict.projectPath
			})
			input.state.openSessionConflict.set(null)
			input.state.statusMessage.set(null)
			await openExistingProject(input.core, input.router, conflict.projectPath)
		} catch (error) {
			input.state.statusMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.state.openBusy.set(false)
		}
	}
})
