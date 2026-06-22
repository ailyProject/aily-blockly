import { projectNewConfig, projectNewSeparator } from '../../project-new/data'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { CloudProjectSummary } from 'shared'
import type { CloudSpaceImportResult } from '../types'

/**
 * 执行云项目导入并在需要时回写最近项目。
 * @param input - 导入所需的项目、路径和运行时上下文
 */
export const importCloudSpaceProject = async (input: {
	core: Core
	project: CloudProjectSummary
	rootPath: string
	targetName: string
	runtimeInfo: DesktopHostRuntimeInfo | null
}): Promise<CloudSpaceImportResult> => {
	const targetPath = await input.core.project.resolveProjectPath.query({
		basePath: input.rootPath,
		name: input.targetName,
		separator: input.runtimeInfo?.pathSeparator || projectNewSeparator
	})
	const targetExists = await input.core.project.pathExists.query({
		projectPath: targetPath
	})
	if (targetExists) {
		const suggestedImportName = await input.core.project.findAvailableName.query({
			basePath: input.rootPath,
			name: input.targetName,
			separator: input.runtimeInfo?.pathSeparator || projectNewSeparator
		})
		return {
			success: false,
			message: `目标目录已存在，可改用建议名称：${suggestedImportName}`,
			pendingTargetPath: targetPath,
			targetPathConflict: true,
			suggestedImportName
		}
	}

	const result = await input.core.project.importCloudProject.mutate({
		projectId: input.project.id,
		targetPath,
		name: input.project.name,
		nickname: input.project.nickname,
		description: input.project.description,
		cloudId: input.project.id,
		tags: input.project.tags
	})
	if (input.runtimeInfo?.appDataPath) {
		await input.core.project.addStoredRecentProject.mutate({
			appDataPath: input.runtimeInfo.appDataPath,
			project: {
				name: input.project.name,
				nickname: input.project.nickname,
				path: result.projectPath
			}
		})
	} else {
		await input.core.project.addRecentProject.query({
			config: projectNewConfig,
			project: {
				name: input.project.name,
				nickname: input.project.nickname,
				path: result.projectPath
			}
		})
	}

	return {
		success: true,
		message: `Imported ${input.project.nickname || input.project.name} into ${result.projectPath}`,
		projectPath: result.projectPath,
		pendingTargetPath: '',
		targetPathConflict: false
	}
}
