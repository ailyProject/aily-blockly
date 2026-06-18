import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { getChildToolFallback } from './fixtures'

import type { ChildToolDiscoveryOptions, ChildToolItem, ChildToolPackageJson } from './types'

const childToolIdByDir: Record<string, string> = {
	'ffs-manager': 'ffs-manager-child'
}

const humanizeDirName = (value: string) =>
	value
		.split('-')
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ')

/**
 * 发现子工具目录。
 * @param {ChildToolDiscoveryOptions} [options] - 子工具目录发现参数
 * @returns {Array<ChildToolItem>}
 */
export const discoverChildTools = (options: ChildToolDiscoveryOptions = {}): Array<ChildToolItem> => {
	if (!options.childPath) return getChildToolFallback()

	const toolsPath = join(options.childPath, 'tools')
	if (!existsSync(toolsPath)) return getChildToolFallback()

	const tools = readdirSync(toolsPath)
		.filter(name => !!name.trim())
		.filter(name => statSync(join(toolsPath, name)).isDirectory())
		.map(name => {
			const packagePath = join(toolsPath, name, 'package.json')
			if (!existsSync(packagePath)) return null

			const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as ChildToolPackageJson
			const id = childToolIdByDir[name] || name
			return {
				id,
				title: humanizeDirName(name),
				summary: packageJson.description || `${humanizeDirName(name)} child tool.`,
				launchPath: `/child-tool/${id}`
			} satisfies ChildToolItem
		})
		.filter((item): item is ChildToolItem => !!item)

	return tools.length > 0 ? tools : getChildToolFallback()
}

/**
 * 按标识获取单个子工具目录项。
 * @param {string} toolId - 子工具标识
 * @param {ChildToolDiscoveryOptions} [options] - 子工具目录发现参数
 * @returns {ChildToolItem | null}
 */
export const getChildTool = (toolId: string, options: ChildToolDiscoveryOptions = {}): ChildToolItem | null =>
	discoverChildTools(options).find(item => item.id === toolId) || null
