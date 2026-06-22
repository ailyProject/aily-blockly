import { isBlocklyLibraryPackageName } from '../../../packageRules'
import {
	compareProjectBlocklyRegistryVersion,
	humanizeProjectBlocklyLibraryName,
	parseProjectBlocklyRegistryPackageVersion
} from '../shared'
import { getProjectBlocklyRegistryPackageVersionList } from '../versionList'

import type { ProjectBlocklyLibraryRegistrySearchItem } from '../../../types'

/**
 * 基于 `vc-package-versions.json` 生成 registry 搜索结果。
 * @param registry - 当前 registry 地址
 * @param query - 用户搜索词
 */
export const collectProjectBlocklyRegistryItemsFromVersionList = async (registry: string, query: string) => {
	const items: Array<ProjectBlocklyLibraryRegistrySearchItem> = []
	const versionList = await getProjectBlocklyRegistryPackageVersionList(registry)
	const packageVersions = new Map<string, Array<string>>()
	for (const entry of versionList) {
		const parsed = parseProjectBlocklyRegistryPackageVersion(entry)
		if (!parsed || !isBlocklyLibraryPackageName(parsed.name)) continue

		const searchableText = `${parsed.name} ${humanizeProjectBlocklyLibraryName(parsed.name)}`.toLowerCase()
		if (!searchableText.includes(query.toLowerCase())) continue

		const versions = packageVersions.get(parsed.name) ?? []
		versions.push(parsed.version)
		packageVersions.set(parsed.name, versions)
	}

	for (const [packageName, versions] of packageVersions) {
		versions.sort(compareProjectBlocklyRegistryVersion)
		items.push({
			name: packageName,
			displayName: humanizeProjectBlocklyLibraryName(packageName),
			latestVersion: versions[0]
		})
	}

	return items
}
