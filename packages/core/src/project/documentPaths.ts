import path from 'node:path'

/**
 * 解析当前项目主文档路径。
 * @param projectPath - 当前项目目录
 */
export const resolveProjectDocumentPath = (projectPath: string) => path.join(projectPath, 'project.abi')

/**
 * 解析当前项目临时文档路径。
 * @param projectPath - 当前项目目录
 */
export const resolveProjectTempDocumentPath = (projectPath: string) => path.join(projectPath, 'project.abi.temp')

/**
 * 根据主文档路径推导对应的临时文档路径。
 * @param filePath - 主文档路径
 */
export const resolveProjectTempDocumentPathFromPrimary = (filePath: string) =>
	filePath.endsWith('.temp') ? filePath : `${filePath}.temp`
