import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { readConnectionPinmapCatalog } from '../pinmap'

import type { ConnectionPinmapCatalog } from '../types'

/**
 * 扫描所有可读取的 pinmap catalog。
 * @param packagesBasePath - 包基础目录
 */
export const scanConnectionPinmapCatalogs = (packagesBasePath: string) => {
	const catalogs: Array<ConnectionPinmapCatalog> = []
	const ailyProjectPath = join(packagesBasePath, '@aily-project')
	if (!existsSync(ailyProjectPath)) return catalogs

	for (const packageName of readdirSync(ailyProjectPath)) {
		const packagePath = join(ailyProjectPath, packageName)
		const catalog = readConnectionPinmapCatalog(packagePath)
		if (catalog) catalogs.push(catalog)
	}

	return catalogs
}
