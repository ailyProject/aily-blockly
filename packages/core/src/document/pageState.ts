import { randomUUID } from 'node:crypto'

import { createEmptyWorkspaceContent, normalizeWorkspaceJson, stripSharedModel } from './workspace'

import type { BlocklyWorkspaceContent } from '../metadata'
import type { BlocklyPageSnapshot, BlocklyWorkspaceViewState } from './types'

/**
 * 创建默认视图状态
 */
export const createDefaultViewState = (): BlocklyWorkspaceViewState => ({
	scale: 1,
	scrollX: 0,
	scrollY: 0
})

/**
 * 生成页面 ID
 */
export const generatePageId = () => `page-${Date.now()}-${randomUUID().slice(0, 6)}`

/**
 * 创建空页面快照
 * @param id - 页面 ID
 * @param title - 页面标题
 */
export const createEmptyPageSnapshot = (id = generatePageId(), title = 'Page 1'): BlocklyPageSnapshot => ({
	id,
	title,
	content: createEmptyWorkspaceContent(),
	viewState: createDefaultViewState()
})

/**
 * 归一化页面内容
 * @param content - 页面内容
 */
export const normalizePageContent = (content: unknown): BlocklyWorkspaceContent =>
	stripSharedModel(normalizeWorkspaceJson(content))

/**
 * 归一化页面快照
 * @param page - 原始页面数据
 * @param index - 页面序号
 */
export const normalizePageSnapshot = (page: unknown, index: number): BlocklyPageSnapshot => {
	const source = page && typeof page === 'object' ? (page as Partial<BlocklyPageSnapshot>) : {}

	return {
		id: source.id || generatePageId(),
		title: source.title || `Page ${index + 1}`,
		content: normalizePageContent(source.content),
		viewState: source.viewState || createDefaultViewState()
	}
}

/**
 * 归一化打开页面 ID 列表
 * @param openedPageIds - 原始打开页面列表
 * @param pages - 页面列表
 * @param activePageId - 当前激活页面
 */
export const normalizeOpenedPageIds = (
	openedPageIds: unknown,
	pages: Array<BlocklyPageSnapshot>,
	activePageId: string
) => {
	const normalizedOpenedIds = new Set(Array.isArray(openedPageIds) ? openedPageIds : [])
	normalizedOpenedIds.add(activePageId)
	const pageIds = new Set(pages.map(page => page.id))
	const nextOpenedPageIds = pages
		.map(page => page.id)
		.filter(pageId => pageIds.has(pageId) && normalizedOpenedIds.has(pageId))

	return nextOpenedPageIds.length > 0 ? nextOpenedPageIds : [activePageId]
}
