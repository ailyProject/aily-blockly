import { createEmptyPageSnapshot, normalizeOpenedPageIds, normalizePageSnapshot } from './pageState'
import {
	composeWorkspacePayload,
	extractSharedModel,
	normalizeSharedModel,
	normalizeWorkspaceJson,
	stripSharedModel
} from './workspace'

import type { BlocklyProjectDocument } from './types'

const DEFAULT_SCHEMA_VERSION = 1

/**
 * 归一化项目文档
 * @param jsonData - 原始项目 ABI / 文档数据
 * @param schemaVersion - 目标 schema 版本
 */
export const normalizeProjectDocument = (
	jsonData: unknown,
	schemaVersion = DEFAULT_SCHEMA_VERSION
): BlocklyProjectDocument => {
	if (jsonData && typeof jsonData === 'object' && Array.isArray((jsonData as { pages?: unknown[] }).pages)) {
		const source = jsonData as Partial<BlocklyProjectDocument>
		const pages = source.pages!.length
			? source.pages!.map((page, index) => normalizePageSnapshot(page, index))
			: [createEmptyPageSnapshot('page-1', 'Page 1')]
		const activePageId = pages.some(page => page.id === source.activePageId) ? String(source.activePageId) : pages[0].id
		const openedPageIds = normalizeOpenedPageIds(source.openedPageIds, pages, activePageId)

		return {
			schemaVersion,
			activePageId,
			openedPageIds,
			pages,
			sharedModel: normalizeSharedModel(source.sharedModel)
		}
	}

	const legacyWorkspaceJson = normalizeWorkspaceJson(jsonData)
	const legacyPage = createEmptyPageSnapshot('page-1', 'Page 1')
	legacyPage.content = stripSharedModel(legacyWorkspaceJson)

	return {
		schemaVersion,
		activePageId: legacyPage.id,
		openedPageIds: [legacyPage.id],
		pages: [legacyPage],
		sharedModel: extractSharedModel(legacyWorkspaceJson)
	}
}

/**
 * 生成用于保存的项目 ABI 载荷
 * @param document - 项目文档
 */
export const getProjectAbiForSave = (document: BlocklyProjectDocument) => {
	if (document.pages.length === 1) {
		return composeWorkspacePayload(document.pages[0].content, document.sharedModel)
	}

	return document
}
