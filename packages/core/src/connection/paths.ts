import { join } from 'node:path'

import type { ConnectionGraphPaths } from './types'

/**
 * 解析连线图相关文件路径。
 * @param projectPath - 项目根路径
 */
export const resolveConnectionGraphPaths = (projectPath: string): ConnectionGraphPaths => ({
	jsonPath: join(projectPath, 'connection_output.json'),
	awsPath: join(projectPath, 'connection.aws')
})
