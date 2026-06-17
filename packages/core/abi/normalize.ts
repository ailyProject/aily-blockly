import { getProjectAbiForSave, normalizeProjectDocument } from '../document'

import type { BlocklyProjectDocument } from '../document'
import type { BlocklyWorkspaceBlockNode, BlocklyWorkspaceContent } from '../metadata'
import type { ParsedProjectAbi, ProjectAbiPayload } from './types'

const isWorkspacePayload = (value: ProjectAbiPayload): value is BlocklyWorkspaceContent =>
	Boolean(value && typeof value === 'object' && 'blocks' in value && !('pages' in value))

/**
 * 归一化 project.abi 载荷
 * @param {unknown} jsonData - 原始 ABI 数据
 * @returns {BlocklyProjectDocument}
 */
export const normalizeProjectAbi = (jsonData: unknown): BlocklyProjectDocument => normalizeProjectDocument(jsonData)

/**
 * 根据项目文档生成用于落盘的 ABI 载荷
 * @param {BlocklyProjectDocument} document - 项目文档
 * @returns {ProjectAbiPayload}
 */
export const buildProjectAbiPayload = (document: BlocklyProjectDocument): ProjectAbiPayload =>
	getProjectAbiForSave(document)

/**
 * 解析 ABI 文本并归一化
 * @param {string} raw - project.abi 文件内容
 * @returns {ParsedProjectAbi}
 */
export const parseProjectAbiText = (raw: string): ParsedProjectAbi => {
	const parsed = JSON.parse(raw)
	const normalizedDocument = normalizeProjectDocument(parsed)
	const payload = buildProjectAbiPayload(normalizedDocument)

	return {
		raw,
		payload
	}
}

/**
 * 序列化 ABI 载荷
 * @param {ProjectAbiPayload} payload - ABI 载荷
 * @returns {string}
 */
export const stringifyProjectAbi = (payload: ProjectAbiPayload) => JSON.stringify(payload, null, 2)

/**
 * 统计 ABI 中的块数量
 * @param {ProjectAbiPayload} payload - ABI 载荷
 * @returns {number}
 */
export const countAbiBlocks = (payload: ProjectAbiPayload): number => {
	const workspacePayload: BlocklyWorkspaceContent = isWorkspacePayload(payload)
		? payload
		: (buildProjectAbiPayload(normalizeProjectDocument(payload)) as BlocklyWorkspaceContent)

	let count = 0

	const countRecursive = (block: BlocklyWorkspaceBlockNode | undefined): void => {
		if (!block) return
		count += 1

		const inputs = block.inputs && typeof block.inputs === 'object' ? block.inputs : {}
		for (const input of Object.values(inputs) as Array<{
			block?: BlocklyWorkspaceBlockNode
			shadow?: BlocklyWorkspaceBlockNode
		}>) {
			countRecursive(input?.block)
			countRecursive(input?.shadow)
		}

		countRecursive(block.next?.block)
	}

	for (const block of workspacePayload.blocks?.blocks ?? []) {
		countRecursive(block)
	}

	return count
}
