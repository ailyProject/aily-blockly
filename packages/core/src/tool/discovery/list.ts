import { getChildToolFallback } from '../fixtures'
import {
	childToolIdByDir,
	getChildToolsPath,
	humanizeChildToolDirName,
	readChildToolPackageJson,
	scanChildToolDirectories
} from './shared'

import type { ChildToolDiscoveryOptions, ChildToolItem } from '../types'

/**
 * 发现子工具目录。
 * @param options - 子工具目录发现参数
 */
export const discoverChildTools = (options: ChildToolDiscoveryOptions = {}): Array<ChildToolItem> => {
	if (!options.childPath) return getChildToolFallback()

	const toolsPath = getChildToolsPath(options)
	if (!toolsPath) return getChildToolFallback()

	const tools = scanChildToolDirectories(options)
		.map(name => {
			const packageJson = readChildToolPackageJson(toolsPath, name)
			if (!packageJson) return null

			const id = childToolIdByDir[name] || name
			return {
				id,
				title: humanizeChildToolDirName(name),
				summary: packageJson.description || `${humanizeChildToolDirName(name)} child tool.`,
				launchPath: `/child-tool/${id}`
			} satisfies ChildToolItem
		})
		.filter((item): item is ChildToolItem => !!item)

	return tools.length > 0 ? tools : getChildToolFallback()
}

/**
 * 按标识获取单个子工具目录项。
 * @param toolId - 子工具标识
 * @param options - 子工具目录发现参数
 */
export const getChildTool = (toolId: string, options: ChildToolDiscoveryOptions = {}): ChildToolItem | null =>
	discoverChildTools(options).find(item => item.id === toolId) || null
