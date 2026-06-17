import { randomUUID } from 'node:crypto'

import type { BlocklyWorkspaceBlockNode, BlocklyWorkspaceContent } from '../metadata'
import type {
	BlocklyPageSnapshot,
	BlocklyProjectDocument,
	BlocklySharedModel,
	BlocklyWorkspaceViewState
} from './types'

const DEFAULT_SCHEMA_VERSION = 1

const clone = <T>(value: T): T => structuredClone(value)

/**
 * 创建空工作区内容
 */
export const createEmptyWorkspaceContent = (): BlocklyWorkspaceContent =>
	({
		blocks: {
			languageVersion: 0,
			blocks: []
		}
	}) as BlocklyWorkspaceContent

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
 * 归一化工作区 JSON
 * @param workspaceJson - 原始工作区 JSON
 */
export const normalizeWorkspaceJson = (workspaceJson: unknown): BlocklyWorkspaceContent => {
	const nextJson = (clone(workspaceJson) as BlocklyWorkspaceContent | null) ?? createEmptyWorkspaceContent()

	if (!nextJson.blocks) {
		nextJson.blocks = {
			languageVersion: 0,
			blocks: []
		}
	}

	const blocksContainer = nextJson.blocks

	if (!Array.isArray(blocksContainer.blocks)) {
		blocksContainer.blocks = []
	}

	return nextJson
}

/**
 * 判断块是否属于共享过程块
 * @param block - 块节点
 */
export const isSharedProcedureBlock = (block: BlocklyWorkspaceBlockNode | undefined) =>
	Boolean(block?.type?.startsWith('procedures_'))

/**
 * 归一化共享模型
 * @param sharedModel - 原始共享模型
 */
export const normalizeSharedModel = (sharedModel: unknown): BlocklySharedModel => ({
	variables:
		sharedModel && typeof sharedModel === 'object' && 'variables' in sharedModel
			? clone((sharedModel as { variables?: unknown }).variables)
			: undefined,
	procedureBlocks:
		sharedModel &&
		typeof sharedModel === 'object' &&
		Array.isArray((sharedModel as { procedureBlocks?: unknown[] }).procedureBlocks)
			? (sharedModel as { procedureBlocks: Array<BlocklyWorkspaceBlockNode> }).procedureBlocks.map(block =>
					clone(block)
				)
			: []
})

/**
 * 从工作区提取共享模型
 * @param workspaceJson - 工作区内容
 */
export const extractSharedModel = (workspaceJson: BlocklyWorkspaceContent): BlocklySharedModel => {
	const normalized = normalizeWorkspaceJson(workspaceJson)
	const workspaceBlocks = Array.isArray(normalized.blocks?.blocks) ? normalized.blocks.blocks : []

	return {
		variables: 'variables' in normalized ? clone((normalized as { variables?: unknown }).variables) : undefined,
		procedureBlocks: workspaceBlocks.filter(block => isSharedProcedureBlock(block)).map(block => clone(block))
	}
}

/**
 * 从工作区中移除共享模型
 * @param workspaceJson - 工作区内容
 */
export const stripSharedModel = (workspaceJson: BlocklyWorkspaceContent): BlocklyWorkspaceContent => {
	const normalized = normalizeWorkspaceJson(workspaceJson)
	normalized.blocks!.blocks = normalized.blocks!.blocks!.filter(block => !isSharedProcedureBlock(block))
	delete (normalized as { variables?: unknown }).variables
	return normalized
}

/**
 * 组合页面工作区与共享模型为实际工作区载荷
 * @param pageContent - 页面工作区内容
 * @param sharedModel - 共享模型
 */
export const composeWorkspacePayload = (
	pageContent: BlocklyWorkspaceContent | null | undefined,
	sharedModel: BlocklySharedModel
): BlocklyWorkspaceContent => {
	const workspaceJson = normalizeWorkspaceJson(pageContent)
	const pageBlocks = Array.isArray(workspaceJson.blocks?.blocks) ? workspaceJson.blocks.blocks : []
	const sharedProcedureBlocks = Array.isArray(sharedModel.procedureBlocks)
		? sharedModel.procedureBlocks.map(block => clone(block))
		: []

	workspaceJson.blocks!.blocks = [...sharedProcedureBlocks, ...pageBlocks.map(block => clone(block))]

	if (sharedModel.variables) {
		;(workspaceJson as BlocklyWorkspaceContent & { variables?: unknown }).variables = clone(sharedModel.variables)
	} else {
		delete (workspaceJson as { variables?: unknown }).variables
	}

	return workspaceJson
}

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
