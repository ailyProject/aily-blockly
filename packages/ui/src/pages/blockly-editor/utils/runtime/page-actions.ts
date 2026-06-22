import { refreshBlocklyEditorPage } from './apply'

import type { Core } from '@/utils/core'
import type { BlocklyEditorPageSummary, BlocklyEditorSignals } from '../../types'

/**
 * 新增页面。
 * @param core - core 句柄
 * @param projectPath - 当前项目路径
 * @param signals - 页面信号集合
 */
export const createBlocklyEditorPage = async (core: Core, projectPath: string, signals: BlocklyEditorSignals) => {
	await core.project.createPage.mutate({
		projectPath
	})
	await refreshBlocklyEditorPage(core, projectPath, signals)
}

/**
 * 切换或重开指定页面。
 * @param core - core 句柄
 * @param projectPath - 当前项目路径
 * @param page - 目标页面
 * @param signals - 页面信号集合
 */
export const switchBlocklyEditorPage = async (
	core: Core,
	projectPath: string,
	page: BlocklyEditorPageSummary,
	signals: BlocklyEditorSignals
) => {
	if (!page.opened) {
		await core.project.openPage.mutate({
			projectPath,
			pageId: page.id,
			activate: true
		})
	} else {
		await core.project.switchPage.mutate({
			projectPath,
			pageId: page.id
		})
	}

	await refreshBlocklyEditorPage(core, projectPath, signals)
}

/**
 * 打开或关闭页面。
 * @param core - core 句柄
 * @param projectPath - 当前项目路径
 * @param pageId - 页面 ID
 * @param opened - 当前是否打开
 * @param signals - 页面信号集合
 */
export const toggleBlocklyEditorPage = async (
	core: Core,
	projectPath: string,
	pageId: string,
	opened: boolean,
	signals: BlocklyEditorSignals
) => {
	if (opened) {
		await core.project.closePage.mutate({
			projectPath,
			pageId
		})
	} else {
		await core.project.openPage.mutate({
			projectPath,
			pageId,
			activate: true
		})
	}

	await refreshBlocklyEditorPage(core, projectPath, signals)
}

/**
 * 重命名页面。
 * @param core - core 句柄
 * @param projectPath - 当前项目路径
 * @param pageId - 页面 ID
 * @param title - 新标题
 * @param signals - 页面信号集合
 */
export const renameBlocklyEditorPage = async (
	core: Core,
	projectPath: string,
	pageId: string,
	title: string,
	signals: BlocklyEditorSignals
) => {
	await core.project.renamePage.mutate({
		projectPath,
		pageId,
		title
	})
	await refreshBlocklyEditorPage(core, projectPath, signals)
}

/**
 * 刷新目录搜索结果。
 * @param core - core 句柄
 * @param query - 搜索词
 * @param signals - 页面信号集合
 */
export const updateBlocklyEditorSearch = async (core: Core, query: string, signals: BlocklyEditorSignals) => {
	const { searchBlocklyEditorCatalog } = await import('../../runtime')
	signals.searchQuery.set(query)
	signals.searchResultNames.set(await searchBlocklyEditorCatalog(core, query || 'esp32'))
}
