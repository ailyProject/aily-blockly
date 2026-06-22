import { readProjectPackageJson } from './readPackageJson'

import type { ProjectCloudBindingSummary } from './types'

/**
 * 读取当前本地项目与云项目的绑定摘要。
 * @param projectPath - 当前项目目录
 */
export const getProjectCloudBinding = async (projectPath: string): Promise<ProjectCloudBindingSummary> => {
	const packageJson = await readProjectPackageJson(projectPath)

	return {
		projectPath,
		...(packageJson?.cloudId?.trim() ? { cloudId: packageJson.cloudId.trim() } : {}),
		...(packageJson?.name?.trim() ? { name: packageJson.name.trim() } : {}),
		...(packageJson?.nickname?.trim() ? { nickname: packageJson.nickname.trim() } : {})
	}
}
