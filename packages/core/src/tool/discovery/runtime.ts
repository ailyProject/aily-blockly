import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
	childToolIdByDir,
	getChildToolsPath,
	humanizeChildToolDirName,
	readChildToolPackageJson,
	scanChildToolDirectories
} from './shared'

import type { ChildToolDiscoveryOptions, ChildToolRuntimeConfig } from '../types'

/**
 * 解析子工具运行时配置。
 * @param toolId - 子工具标识
 * @param options - 子工具目录发现参数
 */
export const resolveChildToolRuntimeConfig = (
	toolId: string,
	options: ChildToolDiscoveryOptions = {}
): ChildToolRuntimeConfig | null => {
	if (!options.childPath) return null

	const toolsPath = getChildToolsPath(options)
	if (!toolsPath || !existsSync(toolsPath)) return null

	for (const dirName of scanChildToolDirectories(options)) {
		const projectPath = join(toolsPath, dirName)
		if (!statSync(projectPath).isDirectory()) continue

		const packageJson = readChildToolPackageJson(toolsPath, dirName)
		if (!packageJson) continue

		const id = childToolIdByDir[dirName] || dirName
		if (id !== toolId) continue

		const entry = typeof packageJson.main === 'string' && packageJson.main.trim() ? packageJson.main.trim() : 'index.js'
		const uiIndex = join('ui', 'index.html')
		const scriptPath = join(projectPath, entry)
		const uiPath = join(projectPath, uiIndex)
		if (!existsSync(scriptPath) || !existsSync(uiPath)) return null

		return {
			id,
			title: humanizeChildToolDirName(dirName),
			summary: packageJson.description || `${humanizeChildToolDirName(dirName)} child tool.`,
			launchPath: `/child-tool/${id}`,
			dirName,
			entry,
			uiIndex,
			projectPath,
			scriptPath,
			uiPath,
			startupTimeoutMs: dirName === 'ffs-manager' ? 10000 : undefined
		}
	}

	return null
}
