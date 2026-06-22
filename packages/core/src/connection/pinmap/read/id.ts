import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { extractConnectionPinSummary } from '../extract'
import { parsePinmapId } from '../id'
import { readConnectionComponentConfig, readConnectionPinmapCatalog } from './catalog'

/**
 * 解析 pinmap 文件路径。
 * @param fullId - pinmapId
 * @param packagesBasePath - 包基础目录
 */
export const resolvePinmapPath = (fullId: string, packagesBasePath: string) => {
	const { packageSlug, modelId, variantId } = parsePinmapId(fullId)
	const packagePath = join(packagesBasePath, '@aily-project', packageSlug)
	if (!existsSync(packagePath)) return null

	const catalog = readConnectionPinmapCatalog(packagePath)
	if (!catalog) {
		const legacyPath = join(packagePath, 'pinmap.json')
		return existsSync(legacyPath) ? legacyPath : null
	}

	const model = catalog.models.find(item => item.id === modelId)
	const variant = model?.variants.find(item => item.id === variantId)
	if (!variant) return null
	if (variant.pinmapFile) return join(packagePath, variant.pinmapFile)
	if (variant.pinmapRef && catalog.sharedPinmaps?.[variant.pinmapRef]) {
		return join(packagePath, catalog.sharedPinmaps[variant.pinmapRef].file)
	}

	const legacyPath = join(packagePath, 'pinmap.json')
	return existsSync(legacyPath) ? legacyPath : null
}

/**
 * 通过 pinmapId 读取组件配置。
 * @param fullId - pinmapId
 * @param packagesBasePath - 包基础目录
 */
export const loadPinmapConfigById = (fullId: string, packagesBasePath: string) => {
	const configPath = resolvePinmapPath(fullId, packagesBasePath)
	return configPath ? readConnectionComponentConfig(configPath) : null
}

/**
 * 通过 pinmapId 读取引脚摘要。
 * @param fullId - pinmapId
 * @param packagesBasePath - 包基础目录
 */
export const loadPinSummaryById = (fullId: string, packagesBasePath: string) => {
	const config = loadPinmapConfigById(fullId, packagesBasePath)
	return config ? extractConnectionPinSummary(config) : null
}
