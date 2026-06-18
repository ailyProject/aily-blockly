import type { AilyAppConfig, RecentModelProject } from 'shared'

const maxRecentModelProjects = 6

/**
 * 读取最近模型项目列表。
 * @param config - 应用配置
 */
export const getRecentModelProjects = (config: AilyAppConfig | null | undefined) =>
	Array.isArray(config?.recentModelProjects) ? [...config.recentModelProjects] : []

/**
 * 添加一条最近模型项目记录。
 * @param config - 应用配置
 * @param project - 待添加项目
 */
export const addRecentModelProject = (
	config: AilyAppConfig | null | undefined,
	project: RecentModelProject
): AilyAppConfig => {
	const nextProjects = [project, ...getRecentModelProjects(config)].filter(
		(item, index, list) => list.findIndex(candidate => candidate.path === item.path) === index
	)

	return {
		...(config ?? {}),
		recentModelProjects: nextProjects.slice(0, maxRecentModelProjects)
	}
}

/**
 * 移除一条最近模型项目记录。
 * @param config - 应用配置
 * @param projectPath - 项目路径
 */
export const removeRecentModelProject = (
	config: AilyAppConfig | null | undefined,
	projectPath: string
): AilyAppConfig => ({
	...(config ?? {}),
	recentModelProjects: getRecentModelProjects(config).filter(item => item.path !== projectPath)
})
