import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parsePinmapId } from '../id'
import { readConnectionPinmapCatalog } from '../read'
import { ensureConnectionCatalogDocument, ensureConnectionCatalogModel } from './document'
import { enrichConnectionCatalogVariantFromConfig } from './variant'

import type { ConnectionPinmapConfig } from '../../types'

/**
 * 回写 pinmap catalog 中的变体状态。
 * @param input - 目录、版本与配置输入
 */
export const updateConnectionCatalogVariant = (input: {
	pinmapId: string
	status: 'available' | 'needs_generation'
	pinmapFile: string
	packagePath: string
	componentConfig?: ConnectionPinmapConfig
	catalogVersion?: string | number
}) => {
	const ref = parsePinmapId(input.pinmapId)
	const catalogPath = join(input.packagePath, 'pinmaps', 'pinmap_catalog.json')
	const existingCatalog = readConnectionPinmapCatalog(input.packagePath)
	const catalog = ensureConnectionCatalogDocument({
		existingCatalog,
		packageSlug: ref.packageSlug,
		componentConfig: input.componentConfig
	})
	const model = ensureConnectionCatalogModel({
		catalog,
		packageSlug: ref.packageSlug,
		modelId: ref.modelId,
		componentConfig: input.componentConfig
	})

	let variant = model.variants.find(item => item.id === ref.variantId)
	if (!variant) {
		variant = {
			id: ref.variantId,
			name: ref.variantId === 'default' ? '默认版本' : ref.variantId,
			fullId: input.pinmapId,
			status: input.status,
			pinmapFile: input.pinmapFile,
			isDefault: model.variants.length === 0
		}
		model.variants.push(variant)
	}

	variant.status = input.status
	variant.pinmapFile = input.pinmapFile
	enrichConnectionCatalogVariantFromConfig(variant, input.componentConfig)
	if (input.catalogVersion !== undefined) {
		Object.assign(variant, { version: input.catalogVersion })
	}

	writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))
	return catalogPath
}

export * from './document'
export * from './variant'
