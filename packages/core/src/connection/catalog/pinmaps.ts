import { scanConnectionPinmapCatalogs } from './scan'

/**
 * 获取全部可用 pinmapId。
 * @param packagesBasePath - 包基础目录
 * @param filter - 过滤条件
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
 * @param packagesBasePath - 包基础目录
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
