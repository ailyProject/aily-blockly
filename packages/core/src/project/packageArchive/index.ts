import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runProjectArchiveCommand } from './command'
import { ensurePackagedArchiveFile } from './shared'

import type { ProjectArchivePackageResult } from '../types'

/**
 * 清理归档打包使用的临时目录。
 * @param tempRoot - 临时工作目录
 */
export const cleanupProjectArchivePackage = (tempRoot: string) =>
	rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)

/**
 * 把当前项目目录打包成云同步使用的 7z 归档。
 * @param projectPath - 当前项目目录
 */
export const packageProjectArchive = async (projectPath: string): Promise<ProjectArchivePackageResult> => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-project-archive-'))
	const archivePath = path.join(tempRoot, 'project.7z')

	try {
		await runProjectArchiveCommand(projectPath, archivePath)

		return {
			archivePath,
			tempRoot,
			size: await ensurePackagedArchiveFile(archivePath)
		}
	} catch (error) {
		await cleanupProjectArchivePackage(tempRoot)
		throw error
	}
}

export * from './command'
export * from './shared'
