import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { withProjectDirectoryMutationLock } from '../lock'
import { downloadCloudArchiveResponse, parseArchiveFilename } from './download'
import { extractCloudArchivePayload } from './extract'
import { updateImportedProjectPackageJson } from './package'

import type { ProjectImportCloudArchiveInput, ProjectImportCloudArchiveResult } from './types'

/**
 * 下载并导入云项目归档。
 * @param input - 云项目导入输入
 */
export const importCloudProjectArchive = async (
	input: ProjectImportCloudArchiveInput
): Promise<ProjectImportCloudArchiveResult> => {
	const targetDirName = path.basename(input.targetPath)
	return withProjectDirectoryMutationLock(
		path.dirname(input.targetPath),
		`import-${targetDirName}`,
		'import-cloud-project',
		async () => {
			const { archiveUrl, response } = await downloadCloudArchiveResponse(input)
			const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-cloud-project-'))
			try {
				const archiveFilename = parseArchiveFilename(response)
				const archiveBuffer = Buffer.from(await response.arrayBuffer())
				const extractedProjectRoot = await extractCloudArchivePayload({
					tempRoot,
					archiveFilename,
					archiveBuffer
				})

				const packageJsonPath = path.join(extractedProjectRoot, 'package.json')
				await stat(packageJsonPath).catch(() => {
					throw new Error('归档中未找到项目 package.json')
				})
				await mkdir(path.dirname(input.targetPath), { recursive: true })
				await stat(input.targetPath)
					.then(() => {
						throw new Error(`目标项目目录已存在: ${input.targetPath}`)
					})
					.catch(error => {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
					})

				try {
					await cp(extractedProjectRoot, input.targetPath, { recursive: true, force: false, errorOnExist: true })
					const targetPackageJsonPath = path.join(input.targetPath, 'package.json')
					await updateImportedProjectPackageJson(targetPackageJsonPath, input)

					return {
						projectPath: input.targetPath,
						packageJsonPath: targetPackageJsonPath,
						archiveUrl
					}
				} catch (error) {
					await rm(input.targetPath, { recursive: true, force: true }).catch(() => undefined)
					throw error
				}
			} finally {
				await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
			}
		}
	)
}
