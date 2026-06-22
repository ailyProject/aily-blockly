import { createDefaultViewState } from '../document'
import { updateProjectDocument } from './updateDocument'

import type { BlocklyWorkspaceViewState } from '../document'

const normalizeViewState = (viewState: Partial<BlocklyWorkspaceViewState>): BlocklyWorkspaceViewState => ({
	scale: Number.isFinite(viewState.scale) ? Math.max(0.1, Number(viewState.scale)) : createDefaultViewState().scale,
	scrollX: Number.isFinite(viewState.scrollX) ? Number(viewState.scrollX) : createDefaultViewState().scrollX,
	scrollY: Number.isFinite(viewState.scrollY) ? Number(viewState.scrollY) : createDefaultViewState().scrollY
})

/**
 * 更新当前激活页面的视图状态。
 * @param projectPath - 当前项目目录
 * @param viewState - 新的视图状态
 */
export const updateProjectActiveViewState = (projectPath: string, viewState: Partial<BlocklyWorkspaceViewState>) =>
	updateProjectDocument(
		projectPath,
		document => {
			const nextViewState = normalizeViewState(viewState)
			const activePageId = document.activePageId

			return {
				...document,
				pages: document.pages.map(page => (page.id === activePageId ? { ...page, viewState: nextViewState } : page))
			}
		},
		'viewstate-update'
	)
