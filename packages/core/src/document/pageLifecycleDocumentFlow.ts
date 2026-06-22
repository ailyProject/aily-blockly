import type { BlocklyProjectDocument } from './types'

/**
 * 打开页面并可选激活。
 * @param document - 项目文档
 * @param pageId - 目标页面 ID
 * @param activate - 是否激活页面
 */
export const openPageInDocument = (
	document: BlocklyProjectDocument,
	pageId: string,
	activate = true
): BlocklyProjectDocument => {
	const page = document.pages.find(item => item.id === pageId)
	if (!page) return document

	const isAlreadyOpened = document.openedPageIds.includes(pageId)
	if (isAlreadyOpened && (!activate || document.activePageId === pageId)) {
		return document
	}

	const openedPageIds = isAlreadyOpened
		? document.openedPageIds
		: document.pages.map(item => item.id).filter(id => id === pageId || document.openedPageIds.includes(id))

	return {
		...document,
		openedPageIds,
		activePageId: activate ? pageId : document.activePageId
	}
}

/**
 * 关闭页面并返回更新后的文档。
 * @param document - 项目文档
 * @param pageId - 要关闭的页面 ID
 */
export const closePageInDocument = (document: BlocklyProjectDocument, pageId: string): BlocklyProjectDocument => {
	if (document.openedPageIds.length <= 1) return document
	if (!document.openedPageIds.includes(pageId)) return document

	const closeIndex = document.openedPageIds.findIndex(openedPageId => openedPageId === pageId)
	if (closeIndex < 0) return document

	const nextOpenedPageIds = document.openedPageIds.filter(openedPageId => openedPageId !== pageId)
	let nextActivePageId = document.activePageId

	if (pageId === document.activePageId) {
		const fallbackIndex = closeIndex >= nextOpenedPageIds.length ? nextOpenedPageIds.length - 1 : closeIndex
		nextActivePageId = nextOpenedPageIds[Math.max(fallbackIndex, 0)] || nextOpenedPageIds[0]
	}

	return {
		...document,
		openedPageIds: nextOpenedPageIds,
		activePageId: nextActivePageId
	}
}
