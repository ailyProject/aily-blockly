import { projectNewConfig } from '../../data'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { ProjectNewCloudTemplate, ProjectNewRecentItem } from '../../types'

/**
 * 创建空白项目并更新最近项目列表。
 * @param input - 创建所需的板卡、路径与运行时上下文
 */
export const createProjectNewBlank = async (input: {
	core: Core
	runtimeInfo: DesktopHostRuntimeInfo
	projectPath: string
	name: string
	boardName: string
	boardDisplayName: string
}): Promise<{
	projectPath: string
	importMessage: string
	recentProjects: Array<ProjectNewRecentItem>
}> => {
	const result = await input.core.project.createProject.mutate({
		appDataPath: input.runtimeInfo.appDataPath,
		projectPath: input.projectPath,
		name: input.name,
		nickname: input.name,
		boardName: input.boardName,
		boardDisplayName: input.boardDisplayName,
		boardVersion: 'latest',
		devmode: 'arduino'
	})
	const recentProjects = await input.core.project.addStoredRecentProject.mutate({
		appDataPath: input.runtimeInfo.appDataPath,
		project: {
			name: input.name,
			nickname: input.name,
			path: result.projectPath
		}
	})

	return {
		projectPath: result.projectPath,
		importMessage: result.usedBoardTemplate
			? `Created project from installed board template at ${result.projectPath}`
			: `Created minimal project skeleton at ${result.projectPath}`,
		recentProjects: recentProjects ?? []
	}
}

/**
 * 导入选中的云模板并更新最近项目列表。
 * @param input - 导入模板所需的上下文
 */
export const importProjectNewTemplate = async (input: {
	core: Core
	runtimeInfo: DesktopHostRuntimeInfo | null
	template: ProjectNewCloudTemplate
	projectPath: string
	projectName: string
}): Promise<{
	projectPath: string
	importMessage: string
	recentProjects: Array<ProjectNewRecentItem>
}> => {
	const result = await input.core.project.importCloudProject.mutate({
		projectId: input.template.id,
		targetPath: input.projectPath,
		name: input.projectName || input.template.name,
		nickname: input.template.nickname,
		description: input.template.description,
		cloudId: input.template.id,
		tags: input.template.tags
	})
	const recentProjects = input.runtimeInfo?.appDataPath
		? await input.core.project.addStoredRecentProject.mutate({
				appDataPath: input.runtimeInfo.appDataPath,
				project: {
					name: input.projectName || input.template.name,
					nickname: input.template.nickname,
					path: result.projectPath
				}
			})
		: (
				await input.core.project.addRecentProject.query({
					config: projectNewConfig,
					project: {
						name: input.projectName || input.template.name,
						nickname: input.template.nickname,
						path: result.projectPath
					}
				})
			).recentlyProjects

	return {
		projectPath: result.projectPath,
		importMessage: `Imported template into ${result.projectPath}`,
		recentProjects: recentProjects ?? []
	}
}
