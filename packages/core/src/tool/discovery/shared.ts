import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { ChildToolDiscoveryOptions, ChildToolPackageJson } from '../types'

export const childToolIdByDir: Record<string, string> = {
	'ffs-manager': 'ffs-manager-child'
}

export const humanizeChildToolDirName = (value: string) =>
	value
		.split('-')
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ')

export const getChildToolsPath = (options: ChildToolDiscoveryOptions) =>
	options.childPath ? join(options.childPath, 'tools') : ''

/**
 * 读取当前 child/tools 下的候选目录名列表。
 * @param options - 子工具目录发现参数
 */
export const scanChildToolDirectories = (options: ChildToolDiscoveryOptions) => {
	const toolsPath = getChildToolsPath(options)
	if (!toolsPath || !existsSync(toolsPath)) return []

	return readdirSync(toolsPath)
		.filter(name => !!name.trim())
		.filter(name => statSync(join(toolsPath, name)).isDirectory())
}

/**
 * 读取子工具 package.json。
 * @param toolsPath - child/tools 目录
 * @param dirName - 子工具目录名
 */
export const readChildToolPackageJson = (toolsPath: string, dirName: string): ChildToolPackageJson | null => {
	const packagePath = join(toolsPath, dirName, 'package.json')
	if (!existsSync(packagePath)) return null

	return JSON.parse(readFileSync(packagePath, 'utf8')) as ChildToolPackageJson
}
