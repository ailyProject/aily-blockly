import { readFile, writeFile } from 'node:fs/promises'

import type { ProjectPackageJson } from '../types'
import type { ProjectImportCloudArchiveInput } from './types'

/**
 * 更新导入后项目的 package.json。
 * @param packageJsonPath - package.json 路径
 * @param input - 云项目导入输入
 */
export const updateImportedProjectPackageJson = async (
	packageJsonPath: string,
	input: ProjectImportCloudArchiveInput
) => {
	const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as ProjectPackageJson
	const nextPackageJson: ProjectPackageJson = {
		...packageJson,
		name: input.name?.trim() || packageJson.name,
		nickname: input.nickname?.trim() || packageJson.nickname,
		description: input.description?.trim() || packageJson.description,
		cloudId: input.cloudId ?? packageJson.cloudId
	}

	if (input.tags?.length) {
		nextPackageJson['keywords'] = input.tags
	}

	await writeFile(packageJsonPath, JSON.stringify(nextPackageJson, null, 2) + '\n', 'utf8')
}
