import { isBlocklyLibraryPackageName } from '../../../packageRules'
import { humanizeProjectBlocklyLibraryName } from '../shared'

import type { ProjectBlocklyLibraryRegistrySearchItem } from '../../../types'

type RemoteRegistrySearchResponse = {
	objects?: Array<{
		package?: {
			name?: string
			version?: string
			description?: string
			keywords?: Array<string>
		}
	}>
}

/**
 * 通过 npm registry 的 `/-/v1/search` 接口回退搜索 Blockly 库。
 * @param input - registry 地址、搜索词和数量限制
 */
export const collectProjectBlocklyRegistryItemsFromSearchApi = async (input: {
	registry: string
	searchText: string
	limit: number
}) => {
	const response = await fetch(
		`${input.registry}/-/v1/search?text=${encodeURIComponent(input.searchText)}&size=${input.limit}&from=0`
	)
	if (!response.ok) {
		throw new Error(`Registry search failed: ${response.status}`)
	}

	const payload = (await response.json()) as RemoteRegistrySearchResponse
	const items: Array<ProjectBlocklyLibraryRegistrySearchItem> = []
	for (const entry of payload.objects || []) {
		const packageName = entry.package?.name?.trim()
		if (!packageName || !isBlocklyLibraryPackageName(packageName)) continue

		items.push({
			name: packageName,
			displayName: humanizeProjectBlocklyLibraryName(packageName),
			latestVersion: entry.package?.version?.trim() || undefined,
			description: entry.package?.description?.trim() || undefined,
			keywords: entry.package?.keywords?.filter(keyword => typeof keyword === 'string' && keyword.trim().length > 0)
		})
	}

	return items
}
