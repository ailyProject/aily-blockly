import { createPageInDocument } from '../document'
import { updateProjectDocument } from './updateDocument'

/**
 * 在项目文档中新增页面并激活。
 * @param projectPath - 当前项目目录
 * @param title - 可选页面标题
 */
export const createProjectDocumentPage = (projectPath: string, title?: string) =>
	updateProjectDocument(projectPath, document => createPageInDocument(document, title))
