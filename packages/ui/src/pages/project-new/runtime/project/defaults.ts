import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { ProjectNewRecentItem } from '../../types'

/**
 * 读取项目新建页默认根目录与最近项目。
 * @param core - Core tRPC 句柄
 * @param options - 页面初始化上下文
 */
export const loadProjectNewDefaults = async (
	core: Core,
	options: { userDocuments: string; separator: string; config: unknown; runtimeInfo?: DesktopHostRuntimeInfo | null }
): Promise<{ rootPath: string; recentProjects: Array<ProjectNewRecentItem> }> => {
	const rootPathPromise = core.project.getDefaultProjectRootPath.query({
		userDocuments: options.userDocuments,
		separator: options.separator
	})
	const recentProjectsPromise = options.runtimeInfo?.appDataPath
		? core.project.getStoredRecentProjects.query({ appDataPath: options.runtimeInfo.appDataPath })
		: core.project.getRecentProjects.query({ config: options.config as never })

	const [rootPath, recentProjects] = await Promise.all([rootPathPromise, recentProjectsPromise])

	return {
		rootPath,
		recentProjects
	}
}
