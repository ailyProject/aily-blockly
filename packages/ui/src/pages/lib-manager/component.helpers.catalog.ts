import { libraryIndex } from '@/workspace'

import type { LibManagerCatalogLibraryView, LibManagerDeclaredLibraryView, LibManagerPageState } from './types'

const resolveLibraryCompatibility = (
	boardId: string | undefined,
	compatibleHardware: Array<string>
): Pick<LibManagerDeclaredLibraryView, 'compatibility' | 'compatibilityText'> => {
	if (!boardId) {
		return {
			compatibility: 'unknown-board',
			compatibilityText: 'board not resolved'
		}
	}

	const compatible = compatibleHardware.includes(boardId)
	return {
		compatibility: compatible ? 'compatible' : 'incompatible',
		compatibilityText: compatible ? 'board compatible' : `not listed for ${boardId}`
	}
}

/**
 * 按包名读取 catalog 中的库条目。
 * @param packageName - 库包名
 */
export const findCatalogLibraryByName = (packageName: string) =>
	libraryIndex.find(candidate => candidate.name === packageName)

/**
 * 解析已声明库的展示视图。
 * @param state - 当前 lib-manager 页面状态
 * @param item - 已声明库项
 */
export const resolveDeclaredLibraryView = (
	state: LibManagerPageState,
	item: LibManagerPageState['declaredLibraries'][number]
) => {
	const catalogItem = findCatalogLibraryByName(item.name)
	if (!catalogItem) {
		return {
			...item,
			displayName: undefined,
			localPath: item.localPath,
			compatibility: 'unknown-catalog',
			compatibilityText: 'catalog unavailable',
			tags: [],
			sourceLabel: item.localPath ? 'local file' : 'registry'
		} satisfies LibManagerDeclaredLibraryView
	}
	const compatibility = resolveLibraryCompatibility(state.boardId, catalogItem.compatibleHardware)
	return {
		...item,
		displayName: catalogItem.displayName,
		localPath: item.localPath,
		compatibility: compatibility.compatibility,
		compatibilityText: compatibility.compatibilityText,
		tags: catalogItem.tags,
		sourceLabel: item.localPath ? 'local file' : 'registry'
	} satisfies LibManagerDeclaredLibraryView
}

/**
 * 解析 catalog 库的展示视图。
 * @param state - 当前 lib-manager 页面状态
 * @param item - catalog 库项
 */
export const resolveCatalogLibraryView = (state: LibManagerPageState, item: (typeof libraryIndex)[number]) => {
	const compatibility = resolveLibraryCompatibility(state.boardId, item.compatibleHardware)
	return {
		name: item.name,
		displayName: item.displayName,
		description: item.description,
		tags: item.tags,
		compatibility: compatibility.compatibility,
		compatibilityText: compatibility.compatibilityText,
		catalogItem: item,
		sourceLabel: 'registry'
	} satisfies LibManagerCatalogLibraryView
}
