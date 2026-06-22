import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { ProjectPackageJson } from '../types'

/**
 * 读取项目根目录下的 package.json。
 * @param projectPath - 当前项目目录
 */
export const readProjectSourcePackageJson = async (projectPath: string): Promise<ProjectPackageJson | null> => {
	const packageJsonPath = path.join(projectPath, 'package.json')
	if (!existsSync(packageJsonPath)) return null

	try {
		return JSON.parse(await readFile(packageJsonPath, 'utf8')) as ProjectPackageJson
	} catch {
		return null
	}
}
