import { importCloudSpaceProject, mutateCloudSpaceProject, openCloudSpaceProject } from '../../runtime'

import type { CloudProjectMutationAction } from 'shared'
import type { CloudSpaceActionContext } from '../../types'

/**
 * 创建 Cloud Space 的项目导入与 owner 动作。
 * @param input - 页面动作依赖
 */
export const createCloudSpaceProjectActions = (input: CloudSpaceActionContext) => ({
	async importProject(projectId: string, targetName?: string) {
		const state = input.getState()
		const project = state.state()?.items.find(item => item.id === projectId)
		if (!project || !state.rootPath()) return

		const nextTargetName = targetName || `${project.name}-${project.id}`
		state.importBusyId.set(project.id)
		state.statusMessage.set(null)
		state.pendingTargetPath.set('')
		state.targetPathConflict.set(false)
		input.resetImportSuggestion()
		try {
			const result = await importCloudSpaceProject({
				core: input.core,
				project,
				rootPath: state.rootPath(),
				targetName: nextTargetName,
				runtimeInfo: state.runtimeInfo()
			})
			state.statusMessage.set(result.message)
			state.pendingTargetPath.set(result.pendingTargetPath ?? '')
			state.targetPathConflict.set(result.targetPathConflict)
			if (result.suggestedImportName) {
				state.suggestedImportProjectId.set(project.id)
				state.suggestedImportName.set(result.suggestedImportName)
				return
			}
			input.resetImportSuggestion()
			if (result.success && result.projectPath) {
				await openCloudSpaceProject(input.core, input.router, result.projectPath)
			}
		} catch (error) {
			state.statusMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			state.importBusyId.set(null)
		}
	},
	async importProjectWithSuggestedName(importProject: (projectId: string, targetName?: string) => Promise<void>) {
		const state = input.getState()
		const projectId = state.suggestedImportProjectId()
		const suggestedName = state.suggestedImportName()
		if (projectId && suggestedName) {
			await importProject(projectId, suggestedName)
		}
	},
	async runProjectAction(projectId: string, action: CloudProjectMutationAction) {
		const state = input.getState()
		const authToken = state.authToken().trim()
		if (!authToken) {
			state.statusMessage.set('Mine scope requires a bearer token.')
			return
		}
		state.actionBusyKey.set(`${projectId}:${action}`)
		state.statusMessage.set(null)
		try {
			const result = await mutateCloudSpaceProject({ core: input.core, projectId, action, authToken })
			state.statusMessage.set(result.message)
			await input.refresh()
		} catch (error) {
			state.statusMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			state.actionBusyKey.set(null)
		}
	},
	actionBusy(projectId: string, action: CloudProjectMutationAction) {
		return input.getState().actionBusyKey() === `${projectId}:${action}`
	}
})
