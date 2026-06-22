import type { ConnectionPinmapCatalog, ConnectionPinmapConfig } from '../../types'

const createConnectionCatalog = (
	packageSlug: string,
	componentConfig?: ConnectionPinmapConfig
): ConnectionPinmapCatalog => ({
	version: '1.0.0',
	library: `@aily-project/${packageSlug}`,
	displayName: componentConfig?.name || `${packageSlug.replace('lib-', '').toUpperCase()} 系列`,
	type: 'library',
	models: []
})

/**
 * 在 catalog 中查找或创建目标型号节点。
 * @param input - catalog、型号 ID、包标识与可选 pinmap 配置
 */
export const ensureConnectionCatalogModel = (input: {
	catalog: ConnectionPinmapCatalog
	packageSlug: string
	modelId: string
	componentConfig?: ConnectionPinmapConfig
}) => {
	let model = input.catalog.models.find(item => item.id === input.modelId)
	if (!model) {
		model = {
			id: input.modelId,
			name: input.componentConfig?.name || input.modelId.toUpperCase(),
			variants: []
		}
		input.catalog.models.push(model)
	}

	return model
}

/**
 * 读取已有 catalog，或基于包标识创建新的 catalog。
 * @param input - 已有 catalog、包标识与可选 pinmap 配置
 */
export const ensureConnectionCatalogDocument = (input: {
	existingCatalog: ConnectionPinmapCatalog | null
	packageSlug: string
	componentConfig?: ConnectionPinmapConfig
}) => input.existingCatalog || createConnectionCatalog(input.packageSlug, input.componentConfig)
