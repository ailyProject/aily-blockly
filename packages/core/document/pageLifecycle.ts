import { createDefaultViewState, createEmptyPageSnapshot, normalizeProjectDocument } from './normalize'

import type { BlocklyPageSnapshot, BlocklyProjectDocument } from './types'

/**
 * 获取当前激活页面
 * @param {BlocklyProjectDocument} document - 项目文档
 * @returns {BlocklyPageSnapshot | undefined}
 */
export const getActivePage = (document: BlocklyProjectDocument): BlocklyPageSnapshot | undefined =>
	document.pages.find(page => page.id === document.activePageId)

/**
 * 创建新页面并激活
 * @param {BlocklyProjectDocument} document - 项目文档
 * @param {string | undefined} title - 可选页面标题
 * @returns {BlocklyProjectDocument}
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
 * 打开页面并可选激活
 * @param {BlocklyProjectDocument} document - 项目文档
 * @param {string} pageId - 目标页面 ID
 * @param {boolean} activate - 是否激活页面
 * @returns {BlocklyProjectDocument}
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
 * 关闭页面并返回更新后的文档
 * @param {BlocklyProjectDocument} document - 项目文档
 * @param {string} pageId - 要关闭的页面 ID
 * @returns {BlocklyProjectDocument}
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

/**
 * 重命名页面
 * @param {BlocklyProjectDocument} document - 项目文档
 * @param {string} pageId - 页面 ID
 * @param {string} title - 新标题
 * @returns {BlocklyProjectDocument}
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
 * 切换当前激活页面
 * @param {BlocklyProjectDocument} document - 项目文档
 * @param {string} pageId - 目标页面 ID
 * @returns {BlocklyProjectDocument}
 */
export const switchPageInDocument = (document: BlocklyProjectDocument, pageId: string): BlocklyProjectDocument => {
	if (!pageId || pageId === document.activePageId) return document
	if (!document.pages.some(page => page.id === pageId)) return document

	return {
		...document,
		activePageId: pageId
	}
}

/**
 * 归一化页面视图状态
 * @param {BlocklyPageSnapshot['viewState'] | undefined} viewState - 原始视图状态
 * @returns {BlocklyPageSnapshot['viewState']}
 */
export const normalizePageViewState = (viewState: BlocklyPageSnapshot['viewState'] | undefined) =>
	viewState || createDefaultViewState()

/**
 * 用当前规范重新整理项目文档
 * @param {BlocklyProjectDocument} document - 原始文档
 * @returns {BlocklyProjectDocument}
 */
export const normalizeDocumentLifecycleState = (document: BlocklyProjectDocument) => normalizeProjectDocument(document)
