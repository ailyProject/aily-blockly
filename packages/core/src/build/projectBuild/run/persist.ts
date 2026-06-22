import { saveProjectBuildMetadata } from '../../../project'

/**
 * 回写本次构建结果的元数据摘要。
 * @param input - 项目路径、源码、状态与耗时
 */
export const persistProjectBuildRunMetadata = (input: {
	projectPath: string
	sourceCode: string
	status: 'success' | 'failed' | 'cancelled'
	durationMs: number
}) => saveProjectBuildMetadata(input).catch(() => null)
