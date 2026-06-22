import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { withProjectMutationLock } from './lock'

import type { ProjectPackageJson } from './types'

const stripGeneratedMetadata = (packageJson: ProjectPackageJson): ProjectPackageJson => {
	const nextPackageJson: ProjectPackageJson = {
		...packageJson
	}

	delete nextPackageJson['codeHash']
	delete nextPackageJson['buildInfo']
	delete nextPackageJson['lastBuildCode']
	delete nextPackageJson['lastBuildStatus']
	delete nextPackageJson['lastBuildTime']
	delete nextPackageJson['lastBuildDuration']

	return nextPackageJson
}

/**
 * 失效当前项目的生成态缓存，避免 workspace 变更后继续误用旧 sketch / 旧 build 元数据。
 * @param projectPath - 当前项目目录
 */
export const invalidateProjectGeneratedState = async (projectPath: string) => {
	await withProjectMutationLock(projectPath, 'invalidate-generated-state', async () => {
		await rm(path.join(projectPath, '.temp'), { recursive: true, force: true }).catch(() => undefined)

		const packageJsonPath = path.join(projectPath, 'package.json')
		if (!existsSync(packageJsonPath)) return

		try {
			const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as ProjectPackageJson
			const nextPackageJson = stripGeneratedMetadata(packageJson)
			await writeFile(packageJsonPath, JSON.stringify(nextPackageJson, null, 2) + '\n', 'utf8')
		} catch {
			// ignore package.json cleanup failures; stale build metadata is less critical than ABI persistence
		}
	}).catch(() => undefined)
}
