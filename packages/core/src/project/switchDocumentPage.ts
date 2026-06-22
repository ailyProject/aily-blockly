import { switchPageInDocument } from '../document'
import { updateProjectDocument } from './updateDocument'

/**
 * 切换项目文档的当前激活页面。
 * @param projectPath - 当前项目目录
 * @param pageId - 目标页面 ID
 */
export const switchProjectDocumentPage = (projectPath: string, pageId: string) =>
	updateProjectDocument(projectPath, document => switchPageInDocument(document, pageId))
