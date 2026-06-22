import { cloneWorkspaceValue, normalizeWorkspaceJson } from './workspaceBase'

import type { BlocklyWorkspaceBlockNode, BlocklyWorkspaceContent } from '../metadata'
import type { BlocklySharedModel } from './types'

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
			? cloneWorkspaceValue((sharedModel as { variables?: unknown }).variables)
			: undefined,
	procedureBlocks:
		sharedModel &&
		typeof sharedModel === 'object' &&
		Array.isArray((sharedModel as { procedureBlocks?: unknown[] }).procedureBlocks)
			? (sharedModel as { procedureBlocks: Array<BlocklyWorkspaceBlockNode> }).procedureBlocks.map(block =>
					cloneWorkspaceValue(block)
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
		variables:
			'variables' in normalized ? cloneWorkspaceValue((normalized as { variables?: unknown }).variables) : undefined,
		procedureBlocks: workspaceBlocks
			.filter(block => isSharedProcedureBlock(block))
			.map(block => cloneWorkspaceValue(block))
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
