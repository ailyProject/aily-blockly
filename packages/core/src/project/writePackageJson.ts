import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ProjectPackageJson } from './types'

/**
 * 将 package.json 写回到项目目录。
 * @param projectPath - 当前项目目录
 * @param packageJson - 需要写回的 package.json
 */
export const writeProjectPackageJson = async (projectPath: string, packageJson: ProjectPackageJson) => {
	const packageJsonPath = path.join(projectPath, 'package.json')
	await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8')
	return packageJsonPath
}
