import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { ProjectNewRecentItem } from '../../types'

/**
 * 预览当前项目名对应的目标路径与冲突状态。
 * @param input - preview 所需的项目名、路径与宿主信息
 */
export const previewProjectNewTarget = async (input: {
	core: Core
	name: string
	rootPath: string
	recentProjects: Array<ProjectNewRecentItem>
	runtimeInfo: DesktopHostRuntimeInfo | null
	separator: string
}): Promise<{
	nameValidationMessage: string | null
	resolvedProjectPath: string
	pathConflict: boolean | null
}> => {
	const validation = await input.core.project.validateName.query({
		name: input.name,
		platform: input.runtimeInfo?.platform
	})
	if (!validation.valid) {
		return {
			nameValidationMessage: validation.reason ?? '项目名称不可用',
			resolvedProjectPath: '',
			pathConflict: null
		}
	}

	const projectPath = await input.core.project.resolveProjectPath.query({
		basePath: input.rootPath,
		name: input.name.trim(),
		separator: input.runtimeInfo?.pathSeparator || input.separator
	})
	const [pathExists, recentPathExists] = await Promise.all([
		input.core.project.pathExists.query({
			projectPath
		}),
		Promise.resolve(input.recentProjects.some(item => item.path === projectPath))
	])

	return {
		nameValidationMessage: null,
		resolvedProjectPath: projectPath,
		pathConflict: pathExists || recentPathExists
	}
}
