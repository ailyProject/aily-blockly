import type { Core } from '@/utils/core'
import type { GraphEditorState } from '../types'

/**
 * 读取当前依赖根路径下的库 / catalog 状态。
 * @param core - core 服务句柄
 * @param packagesBasePath - 依赖根路径
 */
export const loadGraphEditorLibraryState = async (core: Core, packagesBasePath: string) => {
	if (!packagesBasePath) {
		return {
			libraryCount: 0,
			catalogCount: 0,
			missingCatalogCount: 0,
			libraryNames: [] as Array<string>,
			missingCatalogNames: [] as Array<string>
		}
	}

	const [libraries, catalogs] = await Promise.all([
		core.connection.listLibraries.query({ packagesBasePath }),
		core.connection.listCatalogs.query({ packagesBasePath })
	])
	const missingCatalogNames = libraries
		.filter(library => library.catalogStatus === 'missing_catalog')
		.map(library => library.displayName)

	return {
		libraryCount: libraries.length,
		catalogCount: catalogs.length,
		missingCatalogCount: missingCatalogNames.length,
		libraryNames: libraries.map(library => library.displayName),
		missingCatalogNames
	}
}

/**
 * 读取当前依赖根路径下的 pinmap 目录状态。
 * @param core - core 服务句柄
 * @param packagesBasePath - 依赖根路径
 */
export const loadGraphEditorPinmapState = async (core: Core, packagesBasePath: string) => {
	if (!packagesBasePath) {
		return {
			availablePinmapIds: [] as Array<string>,
			sensorPickerGroups: [] as Array<GraphEditorState['sensorPickerGroups'][number]>
		}
	}

	const [availablePinmapIds, sensorPickerGroups] = await Promise.all([
		core.connection.listAvailablePinmapIds.query({
			packagesBasePath
		}),
		core.connection.getSensorPickerData.query({
			packagesBasePath
		})
	])

	return {
		availablePinmapIds,
		sensorPickerGroups
	}
}

/**
 * 读取 pinmap template JSON 预览。
 * @param core - core 服务句柄
 * @param protocol - 协议类型
 */
export const loadGraphEditorPinmapTemplate = async (core: Core, protocol: string) => {
	const template = await core.connection.getPinmapTemplate.query({
		protocol: protocol.trim() || undefined
	})

	return {
		pinmapTemplateProtocol: protocol,
		pinmapTemplateJson: JSON.stringify(template, null, 2)
	}
}

/**
 * 读取当前 pinmapId 对应的库信息。
 * @param core - core 服务句柄
 * @param pinmapId - 当前 pinmapId
 * @param packagesBasePath - 依赖根路径
 */
export const loadGraphEditorLibraryInfo = async (core: Core, pinmapId: string, packagesBasePath: string) => {
	if (!pinmapId.trim() || !packagesBasePath) {
		return {
			libraryInfo: {
				readme: '',
				exampleCode: '',
				existingPinmaps: []
			}
		}
	}

	const info = await core.connection.getLibraryInfo.query({
		pinmapId: pinmapId.trim(),
		packagesBasePath
	})

	return {
		libraryInfo: {
			readme: info.readme ?? '',
			exampleCode: info.exampleCode ?? '',
			existingPinmaps: info.existingPinmaps ?? []
		}
	}
}
