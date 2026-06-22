import { getActivePage } from '../document'
import { composeWorkspacePayload } from '../document/workspace'
import { readProjectDocument } from './readDocument'

import type { BlocklyWorkspaceViewState } from '../document'
import type { BlocklyWorkspaceContent } from '../metadata'

/**
 * 项目当前激活工作区快照。
 */
export interface ProjectActiveWorkspaceSnapshot {
	/** 当前项目是否存在 `project.abi` 文件。 */
	exists: boolean
	/** 当前激活页面 ID。 */
	activePageId: string
	/** 当前激活页面标题。 */
	activePageTitle: string
	/** 当前激活页面视图状态。 */
	viewState: BlocklyWorkspaceViewState
	/** 合成后的工作区载荷。 */
	workspace: BlocklyWorkspaceContent
	/** 当前顶层块数量。 */
	topLevelBlockCount: number
	/** 当前顶层块类型预览。 */
	topLevelBlockTypes: Array<string>
}

/**
 * 读取当前项目激活页面的合成 workspace payload。
 * @param projectPath - 当前项目目录
 */
export const readProjectActiveWorkspace = async (projectPath: string): Promise<ProjectActiveWorkspaceSnapshot> => {
	const snapshot = await readProjectDocument(projectPath)
	const activePage = getActivePage(snapshot.document) ?? snapshot.document.pages[0]
	const workspace = composeWorkspacePayload(activePage?.content, snapshot.document.sharedModel)
	const topLevelBlocks = workspace.blocks?.blocks ?? []

	return {
		exists: snapshot.exists,
		activePageId: activePage?.id || snapshot.document.activePageId,
		activePageTitle: activePage?.title || '',
		viewState: activePage?.viewState ?? { scale: 1, scrollX: 0, scrollY: 0 },
		workspace,
		topLevelBlockCount: topLevelBlocks.length,
		topLevelBlockTypes: topLevelBlocks
			.map(block => block?.type?.trim())
			.filter((value): value is string => Boolean(value))
	}
}
