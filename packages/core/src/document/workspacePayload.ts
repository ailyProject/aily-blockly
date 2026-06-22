import { cloneWorkspaceValue, normalizeWorkspaceJson } from './workspaceBase'

import type { BlocklyWorkspaceContent } from '../metadata'
import type { BlocklySharedModel } from './types'

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
		? sharedModel.procedureBlocks.map(block => cloneWorkspaceValue(block))
		: []

	workspaceJson.blocks!.blocks = [...sharedProcedureBlocks, ...pageBlocks.map(block => cloneWorkspaceValue(block))]
	if (sharedModel.variables) {
		;(workspaceJson as BlocklyWorkspaceContent & { variables?: unknown }).variables = cloneWorkspaceValue(
			sharedModel.variables
		)
	} else {
		delete (workspaceJson as { variables?: unknown }).variables
	}

	return workspaceJson
}
