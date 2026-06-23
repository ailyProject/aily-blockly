import { normalizeDocumentLifecycleState } from '../document'
import { extractSharedModel, normalizeWorkspaceJson, stripSharedModel } from '../document/workspace'
import { readProjectDocument } from './readDocument'

import type { BlocklyWorkspaceContent } from '../metadata'

/**
 * 比较新的 workspace payload 是否会改变当前激活页面的 ABI 文档。
 * @param projectPath - 当前项目目录
 * @param workspacePayload - 上层传入的完整 workspace payload
 */
export const compareProjectActiveWorkspace = async (projectPath: string, workspacePayload: unknown) => {
	const snapshot = await readProjectDocument(projectPath)
	const normalizedWorkspace = normalizeWorkspaceJson(workspacePayload)
	const nextSharedModel = extractSharedModel(normalizedWorkspace)
	const nextPageContent = stripSharedModel(normalizedWorkspace) as BlocklyWorkspaceContent
	const activePageId = snapshot.document.activePageId

	const nextDocument = normalizeDocumentLifecycleState({
		...snapshot.document,
		sharedModel: nextSharedModel,
		pages: snapshot.document.pages.map(page =>
			page.id === activePageId ? { ...page, content: nextPageContent } : page
		)
	})
	const currentDocument = normalizeDocumentLifecycleState(snapshot.document)

	return {
		changed: JSON.stringify(currentDocument) !== JSON.stringify(nextDocument),
		activePageId
	}
}
