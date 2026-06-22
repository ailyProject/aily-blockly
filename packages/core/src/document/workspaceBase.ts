import type { BlocklyWorkspaceContent } from '../metadata'

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

export const cloneWorkspaceValue = clone
