import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readConnectionPinmapCatalog } from '../pinmap'

import type { ConnectionLibraryCatalogEntry } from '../types'

/**
 * 扫描所有 `lib-*` 库并返回 catalog 摘要。
 * @param packagesBasePath - 包基础目录
 */
export const scanConnectionLibraries = (packagesBasePath: string) => {
	const results: Array<ConnectionLibraryCatalogEntry> = []

	const ailyProjectPath = join(packagesBasePath, '@aily-project')
	if (!existsSync(ailyProjectPath)) return results

	for (const packageName of readdirSync(ailyProjectPath)) {
		if (!packageName.startsWith('lib-')) continue

		const packagePath = join(ailyProjectPath, packageName)
		const packageJsonPath = join(packagePath, 'package.json')
		const catalog = readConnectionPinmapCatalog(packagePath)
		let displayName = packageName

		try {
			if (existsSync(packageJsonPath)) {
				const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
					displayName?: string
					name?: string
				}
				displayName = packageJson.displayName || packageJson.name || packageName
			}
		} catch {
			displayName = packageName
		}

		results.push({
			packageSlug: packageName,
			packagePath,
			displayName: catalog?.displayName || displayName,
			hasPinmapCatalog: !!catalog,
			catalogStatus: catalog ? 'available' : 'missing_catalog',
			...(catalog ? { catalog } : {})
		})
	}

	return results
}
