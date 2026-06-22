import { join } from 'node:path'

import {
	findPeripheralConfigPaths,
	loadPinmapConfigById,
	parsePinmapId,
	readBoardPinmapConfig,
	readConnectionComponentConfig,
	readConnectionPinmapCatalog
} from './pinmap'

import type { ConnectionGraphData, ConnectionPinmapConfig } from './types'

const inferPackagesBasePath = (boardPackagePath: string) => {
	const index = boardPackagePath.indexOf('@aily-project')
	return index === -1 ? null : boardPackagePath.slice(0, index)
}

const buildSimilarComponentsFromCatalog = (packagePath: string, currentFullId: string) => {
	const catalog = readConnectionPinmapCatalog(packagePath)
	if (!catalog?.models?.length) return []

	const { packageSlug, modelId } = parsePinmapId(currentFullId)
	const model = catalog.models.find(item => item.id === modelId)
	if (!model?.variants?.length) return []

	return model.variants.map(variant => {
		let pinmapFile = variant.pinmapFile
		if (!pinmapFile && variant.pinmapRef && catalog.sharedPinmaps?.[variant.pinmapRef]) {
			pinmapFile = catalog.sharedPinmaps[variant.pinmapRef].file
		}

		return {
			fullId: variant.fullId || `${packageSlug}:${model.id}:${variant.id}`,
			modelId: model.id,
			variantId: variant.id,
			name: variant.name,
			modelName: model.name,
			pinmapFile: pinmapFile || undefined,
			data: pinmapFile ? readConnectionComponentConfig(join(packagePath, pinmapFile)) || undefined : undefined
		}
	})
}

/**
 * 收集连线图所需的组件配置映射。
 * @param boardPackagePath - 开发板包路径
 * @param connectionData - 连线图数据
 * @param packagesBasePath - 包基础目录
 */
export const collectConnectionComponentConfigs = (
	boardPackagePath: string,
	connectionData: ConnectionGraphData,
	packagesBasePath?: string
): Record<string, ConnectionPinmapConfig> => {
	const configs: Record<string, ConnectionPinmapConfig> = {}
	const inferredBasePath = packagesBasePath || inferPackagesBasePath(boardPackagePath)
	const boardConfig = readBoardPinmapConfig(boardPackagePath)
	const boardComponent = connectionData.components[0]

	if (boardConfig && boardComponent) {
		configs[boardComponent.refId] = boardConfig
	}

	for (const component of connectionData.components) {
		if (configs[component.refId]) continue

		if (component.pinmapId && inferredBasePath) {
			const config = loadPinmapConfigById(component.pinmapId, inferredBasePath)
			if (config) {
				const { packageSlug } = parsePinmapId(component.pinmapId)
				const packagePath = join(inferredBasePath, '@aily-project', packageSlug)
				const similarComponents = buildSimilarComponentsFromCatalog(packagePath, component.pinmapId)
				configs[component.refId] = similarComponents.length > 0 ? { ...config, similarComponents } : config
				continue
			}
		}

		if (component.configFile) {
			const config = readConnectionComponentConfig(join(boardPackagePath, component.configFile))
			if (config) {
				configs[component.refId] = config
				continue
			}
		}

		for (const configPath of findPeripheralConfigPaths(boardPackagePath)) {
			const config = readConnectionComponentConfig(configPath)
			if (config?.id === component.componentId) {
				configs[component.refId] = config
				break
			}
		}
	}

	return configs
}
