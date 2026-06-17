import type { BlocklyProjectDocument, BlocklyWorkspaceBlockNode, BlocklyWorkspaceContent } from './types'

/**
 * 收集单个块树中的所有 block type
 * @param {BlocklyWorkspaceBlockNode | undefined} block - 当前块节点
 * @param {Set<string>} blockTypes - 收集结果集合
 * @returns {void}
 */
export const collectBlockTypesFromBlock = (
	block: BlocklyWorkspaceBlockNode | undefined,
	blockTypes: Set<string>
): void => {
	if (!block || typeof block !== 'object') return

	if (typeof block.type === 'string' && block.type.length > 0) {
		blockTypes.add(block.type)
	}

	const inputs = block.inputs && typeof block.inputs === 'object' ? block.inputs : {}
	for (const input of Object.values(inputs)) {
		collectBlockTypesFromBlock(input?.block, blockTypes)
		collectBlockTypesFromBlock(input?.shadow, blockTypes)
	}

	collectBlockTypesFromBlock(block.next?.block, blockTypes)
}

/**
 * 从工作区内容中收集 block type
 * @param {BlocklyWorkspaceContent | null | undefined} content - 工作区内容
 * @returns {string[]}
 */
export const collectBlockTypesFromWorkspaceContent = (
	content: BlocklyWorkspaceContent | null | undefined
): Array<string> => {
	const blockTypes = new Set<string>()
	const blocks = Array.isArray(content?.blocks?.blocks) ? content.blocks.blocks : []

	for (const block of blocks) {
		collectBlockTypesFromBlock(block, blockTypes)
	}

	return [...blockTypes].sort()
}

/**
 * 从项目文档中收集 block type
 * @param {BlocklyProjectDocument} document - 项目文档
 * @returns {string[]}
 */
export const collectBlockTypesFromProjectDocument = (document: BlocklyProjectDocument): Array<string> => {
	const blockTypes = new Set<string>()

	for (const page of document.pages ?? []) {
		for (const blockType of collectBlockTypesFromWorkspaceContent(page?.content)) {
			blockTypes.add(blockType)
		}
	}

	for (const block of document.sharedModel?.procedureBlocks ?? []) {
		collectBlockTypesFromBlock(block, blockTypes)
	}

	return [...blockTypes].sort()
}
