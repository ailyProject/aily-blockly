import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readConnectionPinmapCatalog } from './pinmap'

/**
 * 扫描所有可读取的 pinmap catalog。
 * @param {string} packagesBasePath - 包基础目录
 * @returns {Array<import('./types').ConnectionPinmapCatalog>}
 */
export const scanConnectionPinmapCatalogs = (packagesBasePath: string) => {
	const catalogs: Array<import('./types').ConnectionPinmapCatalog> = []
	const ailyProjectPath = join(packagesBasePath, '@aily-project')
	if (!existsSync(ailyProjectPath)) return catalogs

	for (const packageName of readdirSync(ailyProjectPath)) {
		const packagePath = join(ailyProjectPath, packageName)
		const catalog = readConnectionPinmapCatalog(packagePath)
		if (catalog) catalogs.push(catalog)
	}

	return catalogs
}

/**
 * 扫描所有 lib-* 库。
 * @param {string} packagesBasePath - 包基础目录
 * @returns {Array<{packageSlug: string, packagePath: string, displayName: string, hasPinmapCatalog: boolean, catalogStatus: 'available' | 'missing_catalog', catalog?: import('./types').ConnectionPinmapCatalog}>}
 */
export const scanConnectionLibraries = (packagesBasePath: string) => {
	const results: Array<{
		packageSlug: string
		packagePath: string
		displayName: string
		hasPinmapCatalog: boolean
		catalogStatus: 'available' | 'missing_catalog'
		catalog?: import('./types').ConnectionPinmapCatalog
	}> = []

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

/**
 * 获取全部可用 pinmapId。
 * @param {string} packagesBasePath - 包基础目录
 * @param {{status?: 'available' | 'needs_generation', type?: 'library' | 'board' | 'software', protocol?: string}} [filter] - 过滤条件
 * @returns {Array<string>}
 */
export const getAvailableConnectionPinmapIds = (
	packagesBasePath: string,
	filter?: { status?: 'available' | 'needs_generation'; type?: 'library' | 'board' | 'software'; protocol?: string }
) => {
	const ids: Array<string> = []

	for (const catalog of scanConnectionPinmapCatalogs(packagesBasePath)) {
		if (filter?.type && catalog.type !== filter.type) continue

		for (const model of catalog.models) {
			for (const variant of model.variants) {
				if (filter?.status && variant.status !== filter.status) continue
				if (filter?.protocol && variant.protocol !== filter.protocol) continue
				ids.push(variant.fullId)
			}
		}
	}

	return ids
}

/**
 * 获取传感器选择器数据。
 * @param {string} packagesBasePath - 包基础目录
 * @returns {Array<{library: string, displayName: string, icon?: string, models: Array<{id: string, name: string, variants: Array<{fullId: string, name: string, protocol?: string, status: string, isDefault?: boolean}>}>}>}
 */
export const getConnectionSensorPickerData = (packagesBasePath: string) =>
	scanConnectionPinmapCatalogs(packagesBasePath)
		.filter(catalog => catalog.type !== 'board')
		.map(catalog => ({
			library: catalog.library,
			displayName: catalog.displayName,
			icon: catalog.icon,
			models: catalog.models.map(model => ({
				id: model.id,
				name: model.name,
				variants: model.variants.map(variant => ({
					fullId: variant.fullId,
					name: variant.name,
					protocol: variant.protocol,
					status: variant.status,
					isDefault: variant.isDefault
				}))
			}))
		}))
