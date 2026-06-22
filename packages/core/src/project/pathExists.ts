import { existsSync } from 'node:fs'

/**
 * 判断目标项目路径在文件系统中是否已存在。
 * @param projectPath - 待检查的项目目录
 */
export const projectPathExists = (projectPath: string) => existsSync(projectPath)
