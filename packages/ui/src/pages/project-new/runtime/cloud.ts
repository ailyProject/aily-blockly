import type { Core } from '@/utils/core'
import type { ProjectNewBoardCloudState, ProjectNewCloudTemplate } from '../types'

/**
 * 读取当前板卡可见的模板列表。
 * @param core - Core tRPC 句柄
 * @param options - 板卡与认证信息
 */
export const loadProjectTemplates = async (
	core: Core,
	options: { boardName?: string; authToken?: string }
): Promise<Array<ProjectNewCloudTemplate>> => {
	const authToken = options.authToken?.trim()
	const result = await core.cloud.listTemplates.query({
		page: 1,
		pageSize: 20,
		board: options.boardName,
		...(authToken ? { authToken } : {})
	})
	return result.items
}

/**
 * 读取当前板卡的云模板与公开示例状态。
 * @param core - Core tRPC 句柄
 * @param options - 板卡与认证信息
 */
export const loadProjectBoardCloudState = async (
	core: Core,
	options: { boardName?: string; authToken?: string; mode?: 'mine' | 'public' }
): Promise<ProjectNewBoardCloudState> => {
	if (options.mode === 'mine' && !options.authToken?.trim()) {
		const examples = await core.cloud.listPublicProjects.query({
			page: 1,
			pageSize: 1,
			board: options.boardName
		})
		return {
			templates: [],
			hasExamples: examples.total > 0
		}
	}

	const [templates, examples] = await Promise.all([
		loadProjectTemplates(core, options),
		core.cloud.listPublicProjects.query({
			page: 1,
			pageSize: 1,
			board: options.boardName
		})
	])

	return {
		templates,
		hasExamples: examples.total > 0
	}
}
