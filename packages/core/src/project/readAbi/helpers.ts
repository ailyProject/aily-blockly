import { countAbiBlocks } from '../../abi'

import type { BlocklyProjectDocument } from '../../document'
import type { ProjectAbiSummary } from '../readAbi'

/**
 * 统计工作区中的块数量。
 * @param payload - 单页工作区内容
 */
export const countWorkspaceBlocks = (payload: unknown) =>
	countAbiBlocks(payload as Parameters<typeof countAbiBlocks>[0])

/**
 * 统计共享变量数量。
 * @param variables - 共享变量载荷
 */
export const countSharedVariables = (variables: unknown) =>
	Array.isArray(variables)
		? variables.length
		: variables && typeof variables === 'object'
			? Object.keys(variables).length
			: 0

/**
 * 创建没有可用文档内容时的 ABI 摘要。
 * @param input - 文件路径和可选解析错误
 */
export const createEmptyProjectAbiSummary = (input: {
	exists: boolean
	filePath: string
	parseError?: string
}): ProjectAbiSummary => ({
	exists: input.exists,
	filePath: input.filePath,
	...(input.parseError ? { parseError: input.parseError } : {}),
	openedPageCount: 0,
	pageCount: 0,
	totalBlockCount: 0,
	sharedVariableCount: 0,
	sharedProcedureCount: 0,
	pages: []
})

/**
 * 基于已解析文档创建完整 ABI 摘要。
 * @param input - 文件路径与已解析文档
 */
export const createProjectAbiSummaryFromDocument = (input: {
	filePath: string
	document: BlocklyProjectDocument
}): ProjectAbiSummary => ({
	exists: true,
	filePath: input.filePath,
	schemaVersion: input.document.schemaVersion,
	activePageId: input.document.activePageId,
	openedPageCount: input.document.openedPageIds.length,
	pageCount: input.document.pages.length,
	totalBlockCount: countAbiBlocks(input.document),
	sharedVariableCount: countSharedVariables(input.document.sharedModel.variables),
	sharedProcedureCount: input.document.sharedModel.procedureBlocks.length,
	pages: input.document.pages.map(page => ({
		id: page.id,
		title: page.title,
		blockCount: countWorkspaceBlocks(page.content),
		opened: input.document.openedPageIds.includes(page.id),
		active: input.document.activePageId === page.id
	}))
})
