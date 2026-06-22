import { extractSharedModel, normalizeWorkspaceJson, stripSharedModel } from '../document/workspace'
import { invalidateProjectGeneratedState } from './invalidateGeneratedState'
import { updateProjectDocument } from './updateDocument'

import type { BlocklyWorkspaceContent } from '../metadata'

/**
 * 用新的 workspace payload 更新当前激活页面及共享模型。
 * @param projectPath - 当前项目目录
 * @param workspacePayload - 编辑后的完整 workspace payload
 */
export const updateProjectActiveWorkspace = (projectPath: string, workspacePayload: unknown) =>
	updateProjectDocument(
		projectPath,
		document => {
			const normalizedWorkspace = normalizeWorkspaceJson(workspacePayload)
			const nextSharedModel = extractSharedModel(normalizedWorkspace)
			const nextPageContent = stripSharedModel(normalizedWorkspace) as BlocklyWorkspaceContent
			const activePageId = document.activePageId

			return {
				...document,
				sharedModel: nextSharedModel,
				pages: document.pages.map(page => (page.id === activePageId ? { ...page, content: nextPageContent } : page))
			}
		},
		'workspace-update'
	).then(async snapshot => {
		await invalidateProjectGeneratedState(projectPath)
		return snapshot
	})
