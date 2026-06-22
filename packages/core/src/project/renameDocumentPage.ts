import { renamePageInDocument } from '../document'
import { updateProjectDocument } from './updateDocument'

/**
 * 重命名项目文档中的页面。
 * @param projectPath - 当前项目目录
 * @param pageId - 页面 ID
 * @param title - 新标题
 */
export const renameProjectDocumentPage = (projectPath: string, pageId: string, title: string) =>
	updateProjectDocument(projectPath, document => renamePageInDocument(document, pageId, title))
