import { openPageInDocument } from '../document'
import { updateProjectDocument } from './updateDocument'

/**
 * 打开项目文档中的页面，并可选激活。
 * @param projectPath - 当前项目目录
 * @param pageId - 页面 ID
 * @param activate - 是否激活页面
 */
export const openProjectDocumentPage = (projectPath: string, pageId: string, activate = true) =>
	updateProjectDocument(projectPath, document => openPageInDocument(document, pageId, activate))
