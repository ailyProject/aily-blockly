import { AILY_PINMAP_COMPONENTS_PATH } from 'shared'

import { saveConnectionPinmapConfig } from '../../persistence'
import { parsePinmapId } from '../../pinmap'
import { resolveRemotePinmapConfigFromApiItem } from '../fetch'
import { buildPinmapIdFromApiItem, extractCloudPinmapItemVersion } from '../normalize'
import { shouldSkipCloudVariant } from '../shared'

const createRemotePinmapSearchParams = (library: string, page: number) =>
	new URLSearchParams({
		q: library,
		status: 'approved',
		page: String(page),
		pageSize: '50',
		sort: 'updated_at'
	})

/**
 * 同步单个库对应的云端 pinmap 数据。
 * @param input - API、headers、本地包集合与目标库上下文
 */
export const syncRemotePinmapsForLibrary = async (input: {
	apiBase: string
	library: string
	localHeaders: Record<string, string>
	localPackageSet: Set<string>
	ailyRoot: string
	packagesBasePath: string
}) => {
	let page = 1
	let seenCount = 0
	let synced = 0

	while (page <= 40) {
		const response = await fetch(
			`${input.apiBase.replace(/\/$/, '')}${AILY_PINMAP_COMPONENTS_PATH}?${createRemotePinmapSearchParams(input.library, page).toString()}`,
			{ headers: input.localHeaders }
		)
		if (!response.ok) break

		const payload = (await response.json()) as {
			data?: { items?: Array<Record<string, unknown>>; total?: number; count?: number }
		}
		const data = payload.data ?? (payload as never)
		const items = Array.isArray(data.items) ? data.items : []
		const total = typeof data.total === 'number' ? data.total : typeof data.count === 'number' ? data.count : null
		if (items.length === 0) break

		seenCount += items.length
		for (const item of items) {
			const pinmapId = buildPinmapIdFromApiItem(item)
			if (!pinmapId) continue

			const { packageSlug } = parsePinmapId(pinmapId)
			if (!input.localPackageSet.has(packageSlug)) continue

			const cloudVersion = extractCloudPinmapItemVersion(item)
			if (shouldSkipCloudVariant({ ailyRoot: input.ailyRoot, pinmapId, cloudVersion })) continue

			const config = await resolveRemotePinmapConfigFromApiItem(item, input.apiBase, input.localHeaders)
			if (!config) continue

			const save = saveConnectionPinmapConfig(pinmapId, config, input.packagesBasePath, cloudVersion)
			if (save.success) synced++
		}

		page++
		if (total !== null && seenCount >= total) break
	}

	return synced
}
