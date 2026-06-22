import { loadCloudSpaceRootPath, loadCloudSpaceRuntimeInfo } from '../../runtime'

import type { CloudProjectScope } from 'shared'
import type { CloudSpaceActionContext } from '../../types'

/**
 * 创建 Cloud Space 的加载与筛选动作。
 * @param input - 页面动作依赖
 */
export const createCloudSpaceLoadActions = (input: CloudSpaceActionContext) => ({
	async loadRuntimeInfo() {
		const state = input.getState()
		state.runtimeInfo.set(await loadCloudSpaceRuntimeInfo(input.desktop, input.loadDesktopHostRuntimeInfo))
	},
	updateQuery(event: Event) {
		const state = input.getState()
		state.statusMessage.set(null)
		input.resetImportSuggestion()
		state.page.set(1)
		state.query.set((event.target as HTMLInputElement).value)
		void input.refresh()
	},
	updateBoard(event: Event) {
		const state = input.getState()
		state.statusMessage.set(null)
		input.resetImportSuggestion()
		state.page.set(1)
		state.board.set((event.target as HTMLInputElement).value)
		void input.refresh()
	},
	updateAuthToken(event: Event) {
		const state = input.getState()
		state.statusMessage.set(null)
		state.authToken.set((event.target as HTMLInputElement).value)
	},
	selectScope(scope: CloudProjectScope) {
		const state = input.getState()
		if (state.scope() === scope) return
		input.resetImportSuggestion()
		state.page.set(1)
		state.scope.set(scope)
		void input.refresh()
	},
	selectPageSize(pageSize: number) {
		const state = input.getState()
		if (state.pageSize() === pageSize) return
		state.statusMessage.set(null)
		input.resetImportSuggestion()
		state.pageSize.set(pageSize)
		state.page.set(1)
		void input.refresh()
	},
	goToPreviousPage() {
		const state = input.getState()
		const nextPage = Math.max(1, state.page() - 1)
		if (nextPage === state.page()) return
		state.statusMessage.set(null)
		input.resetImportSuggestion()
		state.page.set(nextPage)
		void input.refresh()
	},
	goToNextPage() {
		const state = input.getState()
		const currentState = state.state()
		const totalPages = currentState ? Math.max(1, Math.ceil(currentState.total / currentState.pageSize)) : 1
		const nextPage = Math.min(totalPages, state.page() + 1)
		if (nextPage === state.page()) return
		state.statusMessage.set(null)
		input.resetImportSuggestion()
		state.page.set(nextPage)
		void input.refresh()
	},
	async chooseRootPath() {
		const state = input.getState()
		try {
			state.statusMessage.set(null)
			input.resetImportSuggestion()
			const nextRootPath = await input.selectDesktopDirectory(input.desktop!, state.rootPath())
			if (!nextRootPath) return
			state.rootPath.set(nextRootPath)
			state.pendingTargetPath.set('')
			state.targetPathConflict.set(false)
		} catch (error) {
			state.statusMessage.set(error instanceof Error ? error.message : String(error))
		}
	},
	async ensureRootPath() {
		const state = input.getState()
		state.rootPath.set(await loadCloudSpaceRootPath(input.core, state.runtimeInfo()))
	}
})
