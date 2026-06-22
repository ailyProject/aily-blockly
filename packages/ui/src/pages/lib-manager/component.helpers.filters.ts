import { computed } from '@angular/core'

import { libraryIndex } from '@/workspace'

import { resolveCatalogLibraryView, resolveDeclaredLibraryView } from './component.helpers.catalog'

import type { LibManagerDeclaredLibraryView, LibManagerLibraryScope, LibManagerPageState } from './types'

const toSearchableText = (parts: Array<string | undefined>) =>
	parts
		.filter(part => typeof part === 'string' && part.trim().length > 0)
		.join(' ')
		.toLowerCase()

const matchesLibraryQuery = (query: string, parts: Array<string | undefined>) => {
	const normalizedQuery = query.trim().toLowerCase()
	if (!normalizedQuery) return true
	return toSearchableText(parts).includes(normalizedQuery)
}

/**
 * 创建已声明库的展示视图列表。
 * @param stateSignal - 当前 lib-manager 页面状态
 */
export const createDeclaredLibraryViews = (stateSignal: { (): LibManagerPageState | null }) =>
	computed(() => {
		const state = stateSignal()
		if (!state) return []
		return state.declaredLibraries.map(item => resolveDeclaredLibraryView(state, item))
	})

/**
 * 创建按当前筛选条件过滤后的已声明库列表。
 * @param viewsSignal - 已声明库展示视图
 * @param querySignal - 搜索词
 * @param scopeSignal - 当前视图筛选
 */
export const createFilteredDeclaredLibraryViews = (
	viewsSignal: { (): Array<LibManagerDeclaredLibraryView> },
	querySignal: { (): string },
	scopeSignal: { (): LibManagerLibraryScope }
) =>
	computed(() => {
		const scope = scopeSignal()
		if (scope === 'missing' || scope === 'catalog') return []

		return viewsSignal().filter(item => {
			if (scope === 'installed' && !item.ready) return false
			return matchesLibraryQuery(querySignal(), [
				item.name,
				item.displayName,
				item.version,
				item.compatibilityText,
				...(item.tags || [])
			])
		})
	})

/**
 * 创建按当前筛选条件过滤后的缺失库列表。
 * @param stateSignal - 当前 lib-manager 页面状态
 * @param querySignal - 搜索词
 * @param scopeSignal - 当前视图筛选
 */
export const createFilteredMissingLibraries = (
	stateSignal: { (): LibManagerPageState | null },
	querySignal: { (): string },
	scopeSignal: { (): LibManagerLibraryScope }
) =>
	computed(() => {
		const state = stateSignal()
		if (!state) return []
		const scope = scopeSignal()
		if (scope === 'installed' || scope === 'catalog') return []

		return state.missingLibraries.filter(item =>
			matchesLibraryQuery(querySignal(), [item.name, item.version, item.blockType, item.localPath])
		)
	})

/**
 * 创建当前开发板可搜索的 catalog 候选库列表。
 * @param stateSignal - 当前 lib-manager 页面状态
 * @param querySignal - 搜索词
 * @param scopeSignal - 当前视图筛选
 */
export const createCatalogLibraryViews = (
	stateSignal: { (): LibManagerPageState | null },
	querySignal: { (): string },
	scopeSignal: { (): LibManagerLibraryScope }
) =>
	computed(() => {
		const state = stateSignal()
		if (!state) return []
		const scope = scopeSignal()
		if (scope === 'installed' || scope === 'missing') return []
		const declaredNames = new Set(state.declaredLibraries.map(item => item.name))

		return libraryIndex
			.filter(item => !declaredNames.has(item.name))
			.map(item => resolveCatalogLibraryView(state, item))
			.filter(item =>
				matchesLibraryQuery(querySignal(), [
					item.name,
					item.displayName,
					item.description,
					item.compatibilityText,
					...(item.tags || []),
					...(item.catalogItem.keywords || [])
				])
			)
			.sort((left, right) => {
				const compatibilityOrder = ['compatible', 'unknown-board', 'incompatible', 'unknown-catalog']
				const compatibilityDelta =
					compatibilityOrder.indexOf(left.compatibility) - compatibilityOrder.indexOf(right.compatibility)
				return compatibilityDelta !== 0 ? compatibilityDelta : left.displayName.localeCompare(right.displayName)
			})
	})
