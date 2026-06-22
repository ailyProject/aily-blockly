import { createDefaultViewState } from './pageState'

import type { BlocklyPageSnapshot, BlocklyProjectDocument } from './types'

/**
 * 获取当前激活页面。
 * @param document - 项目文档
 */
export const getActivePage = (document: BlocklyProjectDocument): BlocklyPageSnapshot | undefined =>
	document.pages.find(page => page.id === document.activePageId)

/**
 * 归一化页面视图状态。
 * @param viewState - 原始视图状态
 */
export const normalizePageViewState = (viewState: BlocklyPageSnapshot['viewState'] | undefined) =>
	viewState || createDefaultViewState()
