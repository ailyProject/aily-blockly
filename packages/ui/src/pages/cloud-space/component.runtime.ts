import { subscribeProjectMutationEvent } from '@/runtime/project-events'
import { getCurrentProjectPath } from '@/runtime/project-session'

import { loadCloudSpacePageState, loadCloudSpaceRootPath } from './runtime'

import type { Core } from '@/utils/core'
import type { ReturnTypeOfCreateCloudSpacePageState } from './component.types'

/**
 * 刷新 Cloud Space 页面状态与当前项目绑定。
 * @param core - core 句柄
 * @param state - 页面状态
 */
export const refreshCloudSpacePage = async (core: Core, state: ReturnTypeOfCreateCloudSpacePageState) => {
	state.loading.set(true)
	state.error.set(null)
	try {
		state.rootPath.set(await loadCloudSpaceRootPath(core, state.runtimeInfo()))
		const currentProjectPath = getCurrentProjectPath().trim()
		state.currentProjectBinding.set(
			currentProjectPath ? await core.project.getCloudBinding.query({ projectPath: currentProjectPath }) : null
		)
		state.state.set(
			await loadCloudSpacePageState(core, {
				scope: state.scope(),
				search: state.query(),
				board: state.board(),
				authToken: state.authToken(),
				page: state.page(),
				pageSize: state.pageSize()
			})
		)
		const currentState = state.state()
		if (currentState) {
			state.page.set(currentState.page)
			state.pageSize.set(currentState.pageSize)
		}
	} catch (error) {
		state.error.set(error instanceof Error ? error.message : String(error))
	} finally {
		state.loading.set(false)
	}
}

/**
 * 订阅 Cloud Space 依赖的项目会话变更。
 * @param core - core 句柄
 * @param state - 页面状态
 */
export const watchCloudSpaceProjectMutations = (core: Core, state: ReturnTypeOfCreateCloudSpacePageState) =>
	subscribeProjectMutationEvent(async detail => {
		if (detail.type !== 'session-change') return
		const nextProjectPath = detail.projectPath.trim()
		try {
			state.currentProjectBinding.set(
				nextProjectPath ? await core.project.getCloudBinding.query({ projectPath: nextProjectPath }) : null
			)
		} catch {
			state.currentProjectBinding.set(null)
		}
	})
