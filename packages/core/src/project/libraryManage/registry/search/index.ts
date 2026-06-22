import { normalizeProjectBlocklyRegistryUrl } from '../shared'
import { collectProjectBlocklyRegistryItemsFromSearchApi } from './api'
import { collectProjectBlocklyRegistryItemsFromVersionList } from './version'

import type { ProjectBlocklyLibraryRegistrySearchItem, ProjectBlocklyLibraryRegistrySearchResult } from '../../../types'

const LIBRARY_REGISTRY_SEARCH_CACHE_TTL_MS = 60 * 1000

const libraryRegistrySearchCache = new Map<
	string,
	{ value: ProjectBlocklyLibraryRegistrySearchResult; expiresAt: number }
>()
const libraryRegistrySearchInflight = new Map<string, Promise<ProjectBlocklyLibraryRegistrySearchResult>>()

const createProjectBlocklyRegistrySearchResult = (input: {
	registry: string
	query: string
	items: Array<ProjectBlocklyLibraryRegistrySearchItem>
	limit: number
}) =>
	({
		registry: input.registry,
		query: input.query,
		items: input.items.slice(0, input.limit)
	}) satisfies ProjectBlocklyLibraryRegistrySearchResult

/**
 * 在 npm registry 中搜索 Blockly 库。
 * @param input - 搜索词、registry 与数量限制
 */
export const searchProjectBlocklyLibraryRegistry = async (input: {
	query: string
	registry?: string
	limit?: number
}): Promise<ProjectBlocklyLibraryRegistrySearchResult> => {
	const query = input.query.trim()
	const registry = normalizeProjectBlocklyRegistryUrl(input.registry)
	if (!query) {
		return {
			registry,
			query,
			items: []
		}
	}

	const limit = Math.max(1, Math.min(50, input.limit ?? 12))
	const cacheKey = `${registry}::${query}::${limit}`
	const now = Date.now()
	const cached = libraryRegistrySearchCache.get(cacheKey)
	if (cached && cached.expiresAt > now) {
		return cached.value
	}

	const inflight = libraryRegistrySearchInflight.get(cacheKey)
	if (inflight) {
		return inflight
	}

	const searchText = query.includes('@aily-project/lib-') ? query : `@aily-project/lib- ${query}`
	const request = (async () => {
		let items: Array<ProjectBlocklyLibraryRegistrySearchItem> = []

		try {
			items = await collectProjectBlocklyRegistryItemsFromVersionList(registry, query)
		} catch {
			// fall through to registry search API below
		}

		if (items.length === 0) {
			items = await collectProjectBlocklyRegistryItemsFromSearchApi({
				registry,
				searchText,
				limit
			})
		}

		const value = createProjectBlocklyRegistrySearchResult({
			registry,
			query,
			items,
			limit
		})
		libraryRegistrySearchCache.set(cacheKey, {
			value,
			expiresAt: Date.now() + LIBRARY_REGISTRY_SEARCH_CACHE_TTL_MS
		})
		return value
	})()

	libraryRegistrySearchInflight.set(cacheKey, request)
	try {
		return await request
	} finally {
		libraryRegistrySearchInflight.delete(cacheKey)
	}
}
