import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ConnectionPinmapCatalog, ConnectionPinmapConfig } from '../../types'

/**
 * 读取组件配置文件。
 * @param configPath - 配置文件路径
 */
export const readConnectionComponentConfig = (configPath: string): ConnectionPinmapConfig | null => {
	if (!existsSync(configPath)) return null

	try {
		return JSON.parse(readFileSync(configPath, 'utf8')) as ConnectionPinmapConfig
	} catch {
		return null
	}
}

/**
 * 解析 pinmap catalog 路径。
 * @param packagePath - 包路径
 */
export const resolveConnectionCatalogPath = (packagePath: string) => {
	const nestedPath = join(packagePath, 'pinmaps', 'pinmap_catalog.json')
	if (existsSync(nestedPath)) return nestedPath

	const legacyPath = join(packagePath, 'pinmap_catalog.json')
	return existsSync(legacyPath) ? legacyPath : null
}

/**
 * 读取 pinmap catalog。
 * @param packagePath - 包路径
 */
export const readConnectionPinmapCatalog = (packagePath: string): ConnectionPinmapCatalog | null => {
	const catalogPath = resolveConnectionCatalogPath(packagePath)
	if (!catalogPath) return null

	try {
		return JSON.parse(readFileSync(catalogPath, 'utf8')) as ConnectionPinmapCatalog
	} catch {
		return null
	}
}
