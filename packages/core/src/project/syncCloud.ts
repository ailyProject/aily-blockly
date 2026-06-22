import { syncCloudProject } from '../cloud'
import { withProjectMutationLock } from './lock'
import { cleanupProjectArchivePackage, packageProjectArchive } from './packageArchive'
import { readProjectPackageJson } from './readPackageJson'
import { writeProjectPackageJson } from './writePackageJson'

import type { ProjectSyncCloudInput, ProjectSyncCloudResult } from './types'

/**
 * 打包当前本地项目并同步到云端。
 * @param input - 当前项目路径与认证信息
 */
export const syncProjectToCloud = async (input: ProjectSyncCloudInput): Promise<ProjectSyncCloudResult> => {
	return withProjectMutationLock(input.projectPath, 'cloud-sync', async () => {
		const packageJson = await readProjectPackageJson(input.projectPath)
		if (!packageJson) {
			throw new Error(`未找到项目 package.json: ${input.projectPath}`)
		}

		const archive = await packageProjectArchive(input.projectPath)
		try {
			const result = await syncCloudProject({
				projectId: typeof packageJson.cloudId === 'string' ? packageJson.cloudId : undefined,
				projectData: packageJson as Record<string, unknown>,
				archivePath: archive.archivePath,
				authToken: input.authToken
			})

			const nextCloudId = result.projectId.trim()
			const shouldWriteCloudId = nextCloudId.length > 0 && packageJson.cloudId !== nextCloudId
			if (shouldWriteCloudId) {
				await writeProjectPackageJson(input.projectPath, {
					...packageJson,
					cloudId: nextCloudId
				})
			}

			return {
				...result,
				archiveSize: archive.size,
				cloudIdUpdated: shouldWriteCloudId
			}
		} finally {
			await cleanupProjectArchivePackage(archive.tempRoot)
		}
	})
}
