import { createEmptyPageSnapshot } from './pageState'

import type { BlocklyProjectDocument } from './types'

/**
 * 创建新页面并激活。
 * @param document - 项目文档
 * @param title - 可选页面标题
 */
export const createPageInDocument = (document: BlocklyProjectDocument, title?: string): BlocklyProjectDocument => {
	const page = createEmptyPageSnapshot(undefined, title || `Page ${document.pages.length + 1}`)

	return {
		...document,
		pages: [...document.pages, page],
		openedPageIds: [...document.openedPageIds, page.id],
		activePageId: page.id
	}
}

/**
 * 重命名页面。
 * @param document - 项目文档
 * @param pageId - 页面 ID
 * @param title - 新标题
 */
export const renamePageInDocument = (
	document: BlocklyProjectDocument,
	pageId: string,
	title: string
): BlocklyProjectDocument => {
	const nextTitle = title.trim()
	if (!nextTitle) return document

	return {
		...document,
		pages: document.pages.map(page => (page.id === pageId ? { ...page, title: nextTitle } : page))
	}
}

/**
 * 切换当前激活页面。
 * @param document - 项目文档
 * @param pageId - 目标页面 ID
 */
export const switchPageInDocument = (document: BlocklyProjectDocument, pageId: string): BlocklyProjectDocument => {
	if (!pageId || pageId === document.activePageId) return document
	if (!document.pages.some(page => page.id === pageId)) return document

	return {
		...document,
		activePageId: pageId
	}
}
