import { closePageInDocument } from '../document'
import { updateProjectDocument } from './updateDocument'

/**
 * 关闭项目文档中的页面。
 * @param projectPath - 当前项目目录
 * @param pageId - 页面 ID
 */
export const closeProjectDocumentPage = (projectPath: string, pageId: string) =>
	updateProjectDocument(projectPath, document => closePageInDocument(document, pageId))
