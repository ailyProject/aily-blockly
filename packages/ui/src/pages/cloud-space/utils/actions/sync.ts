import { dispatchProjectMutationEvent } from '@/runtime/project-events'
import { getCurrentProjectPath } from '@/runtime/project-session'

import { writeStoredCloudSpaceSyncHistory } from '../state'

import type { CloudSpaceActionContext } from '../../types'

const CLOUD_SPACE_SYNC_HISTORY_LIMIT = 5

/**
 * 创建 Cloud Space 的当前项目同步动作。
 * @param input - 页面动作依赖
 */
export const createCloudSpaceSyncActions = (input: CloudSpaceActionContext) => ({
	async syncCurrentProject() {
		const state = input.getState()
		const authToken = state.authToken().trim()
		const projectPath = getCurrentProjectPath()
		if (!authToken) {
			state.statusMessage.set('Syncing the current project requires a bearer token.')
			return
		}
		if (!projectPath) {
			state.statusMessage.set('No opened project is available to sync.')
			return
		}

		state.syncBusy.set(true)
		state.statusMessage.set(null)
		try {
			const result = await input.core.project.syncCloudProject.mutate({
				projectPath,
				authToken
			})
			const summary = {
				projectPath,
				projectId: result.projectId,
				archiveSize: result.archiveSize,
				cloudIdUpdated: result.cloudIdUpdated,
				syncedAt: new Date().toISOString()
			}
			state.statusMessage.set(result.cloudIdUpdated ? `${result.message} (cloudId updated locally)` : result.message)
			state.syncSummary.set(summary)
			state.syncHistory.update(history => {
				const nextHistory = [summary, ...history].slice(0, CLOUD_SPACE_SYNC_HISTORY_LIMIT)
				writeStoredCloudSpaceSyncHistory(nextHistory)
				return nextHistory
			})
			state.currentProjectBinding.update(current =>
				current
					? {
							...current,
							cloudId: result.projectId
						}
					: {
							projectPath,
							cloudId: result.projectId
						}
			)
			dispatchProjectMutationEvent({
				projectPath,
				type: 'cloud-sync',
				cloudId: result.projectId,
				occurredAt: summary.syncedAt
			})
			if (state.scope() === 'mine') {
				await input.refresh()
			}
		} catch (error) {
			state.statusMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			state.syncBusy.set(false)
		}
	}
})
