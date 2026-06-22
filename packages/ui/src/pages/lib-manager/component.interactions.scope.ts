import type { LibManagerLibraryScope } from './types'

/**
 * 切换当前页面的库筛选 scope。
 * @param setScope - scope 写入口
 * @param scope - 目标 scope
 */
export const selectLibManagerLibraryScope = (
	setScope: (scope: LibManagerLibraryScope) => void,
	scope: LibManagerLibraryScope
) => {
	setScope(scope)
}

/**
 * 快速聚焦 core library 搜索。
 * @param setScope - scope 写入口
 * @param setQuery - 搜索词写入口
 */
export const focusLibManagerCoreLibraries = (
	setScope: (scope: LibManagerLibraryScope) => void,
	setQuery: (query: string) => void
) => {
	setScope('all')
	setQuery('lib-core')
}
