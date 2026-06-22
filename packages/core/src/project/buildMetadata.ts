import { createHash } from 'node:crypto'

import { withProjectMutationLock } from './lock'
import { readProjectPackageJson } from './readPackageJson'
import { writeProjectPackageJson } from './writePackageJson'

import type { ProjectBuildInfo, ProjectBuildStatus, ProjectPackageJson } from './types'

const createProjectCodeHash = (sourceCode: string) => createHash('sha256').update(sourceCode).digest('hex')

const createProjectBuildInfo = (input: {
	status: ProjectBuildStatus
	durationMs: number
	codeHash: string
}): ProjectBuildInfo => ({
	lastBuildTime: new Date().toISOString(),
	lastBuildCode: input.codeHash,
	lastBuildStatus: input.status,
	lastBuildDuration: Number((input.durationMs / 1000).toFixed(2))
})

/**
 * 把最近一次构建结果写回到项目 package.json。
 * @param input - 项目路径、源码和构建状态
 */
export const saveProjectBuildMetadata = async (input: {
	projectPath: string
	sourceCode: string
	status: ProjectBuildStatus
	durationMs: number
}) =>
	withProjectMutationLock(input.projectPath, `save-build-metadata:${input.status}`, async () => {
		const packageJson = await readProjectPackageJson(input.projectPath)
		if (!packageJson) return null

		const codeHash = createProjectCodeHash(input.sourceCode)
		const buildInfo = createProjectBuildInfo({
			status: input.status,
			durationMs: input.durationMs,
			codeHash
		})
		const nextPackageJson: ProjectPackageJson = {
			...packageJson,
			buildInfo,
			lastBuildCode: buildInfo.lastBuildCode,
			lastBuildStatus: buildInfo.lastBuildStatus,
			lastBuildTime: buildInfo.lastBuildTime,
			lastBuildDuration: buildInfo.lastBuildDuration
		}

		if (input.status === 'success') {
			nextPackageJson.codeHash = codeHash
		}

		await writeProjectPackageJson(input.projectPath, nextPackageJson)
		return {
			codeHash,
			buildInfo
		}
	})
