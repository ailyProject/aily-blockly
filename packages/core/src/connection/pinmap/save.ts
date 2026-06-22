import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { updateConnectionCatalogVariant } from './catalog'
import { parsePinmapId } from './id'
import { readConnectionPinmapCatalog } from './read'

import type { ConnectionPinmapConfig, ConnectionPinmapSaveResult } from '../types'

const resolvePinmapPackagePath = (pinmapId: string, packagesBasePath: string) => {
	const ref = parsePinmapId(pinmapId)
	const ailyProjectPath = join(packagesBasePath, '@aily-project')
	let packagePath = join(ailyProjectPath, ref.packageSlug)

	if (!existsSync(packagePath) && existsSync(ailyProjectPath)) {
		for (const packageName of readdirSync(ailyProjectPath)) {
			if (!packageName.startsWith(`${ref.packageSlug}-`) && packageName !== ref.packageSlug) continue
			const candidatePath = join(ailyProjectPath, packageName)
			const catalog = readConnectionPinmapCatalog(candidatePath)
			if (catalog?.models.some(model => model.id === ref.modelId) || !catalog) {
				packagePath = candidatePath
				break
			}
		}
	}

	return {
		ref,
		packagePath
	}
}

/**
 * 保存 pinmap 配置并回写 catalog 状态。
 * @param pinmapId - 完整 pinmapId
 * @param config - pinmap 配置
 * @param packagesBasePath - 包基础目录
 * @param catalogVersion - catalog 版本号
 */
export const saveConnectionPinmapConfig = (
	pinmapId: string,
	config: ConnectionPinmapConfig,
	packagesBasePath: string,
	catalogVersion?: string | number
): ConnectionPinmapSaveResult => {
	try {
		const { ref, packagePath } = resolvePinmapPackagePath(pinmapId, packagesBasePath)
		if (!existsSync(packagePath)) {
			mkdirSync(packagePath, { recursive: true })
		}

		const pinmapsDir = join(packagePath, 'pinmaps')
		if (!existsSync(pinmapsDir)) {
			mkdirSync(pinmapsDir, { recursive: true })
		}

		const fileName = `${ref.modelId}_${ref.variantId}.json`
		const filePath = join(pinmapsDir, fileName)
		writeFileSync(filePath, JSON.stringify(config, null, 2))

		const catalogPath = updateConnectionCatalogVariant({
			pinmapId,
			status: 'available',
			pinmapFile: `pinmaps/${fileName}`,
			packagePath,
			componentConfig: config,
			catalogVersion
		})

		return {
			success: true,
			filePath,
			catalogPath,
			resolvedPackagePath: packagePath
		}
	} catch (error) {
		return {
			success: false,
			error: (error as Error).message
		}
	}
}
