import { AILY_API_SERVER, AILY_PINMAP_COMPONENTS_PATH, DEFAULT_REGION_KEY } from 'shared'

import { getCurrentApiServer } from '../project'
import { saveConnectionPinmapConfig } from './persistence'
import { parsePinmapId, readConnectionPinmapCatalog } from './pinmap'

import type { AilyAppConfig } from 'shared'
import type { ConnectionPinmapConfig } from './types'

const normalizePackageSlugFromApi = (value: unknown) => {
	if (typeof value !== 'string') return ''
	let normalized = value.trim()
	const slashIndex = normalized.lastIndexOf('/')
	if (slashIndex >= 0) normalized = normalized.slice(slashIndex + 1)
	if (normalized.startsWith('@aily-project/')) normalized = normalized.slice('@aily-project/'.length)
	return normalized
}

const resolveDownloadUrl = (apiBase: string, value: unknown) => {
	if (typeof value !== 'string' || value.length === 0) return null
	if (/^https?:\/\//i.test(value)) return value
	return value.startsWith('/') ? `${apiBase.replace(/\/$/, '')}${value}` : null
}

const normalizeRemotePinmapConfig = (raw: unknown): ConnectionPinmapConfig | null => {
	if (!raw || typeof raw !== 'object') return null
	const value = raw as Record<string, unknown>
	if (typeof value['id'] !== 'string' || !Array.isArray(value['pins'])) return null

	return {
		...(value as Record<string, never>),
		id: value['id'],
		name: typeof value['name'] === 'string' ? value['name'] : value['id'],
		width: typeof value['width'] === 'number' ? value['width'] : 200,
		height: typeof value['height'] === 'number' ? value['height'] : 200,
		images: Array.isArray(value['images']) ? (value['images'] as Array<never>) : [],
		functionTypes: Array.isArray(value['functionTypes']) ? (value['functionTypes'] as Array<never>) : [],
		pins: value['pins'] as Array<never>
	} as ConnectionPinmapConfig
}

const normalizeRemotePinmapConfigFromApiItem = (
	raw: unknown,
	item: Record<string, unknown>
): ConnectionPinmapConfig | null => {
	const direct = normalizeRemotePinmapConfig(raw)
	if (direct) return direct
	if (!raw || typeof raw !== 'object') return null

	const value = raw as Record<string, unknown>
	const pins = Array.isArray(value['pins'])
		? value['pins']
		: Array.isArray(value['pin_list'])
			? value['pin_list']
			: Array.isArray(value['pinList'])
				? value['pinList']
				: null
	if (!pins) return null

	let id = typeof value['id'] === 'string' ? value['id'] : undefined
	if (!id && item['model_id'] != null && String(item['model_id']).length > 0) id = String(item['model_id'])
	if (!id && typeof item['full_id'] === 'string' && item['full_id'].includes(':')) {
		id = item['full_id'].split(':')[1]
	}
	if (!id && typeof item['slug'] === 'string') id = item['slug']
	if (!id) return null

	return normalizeRemotePinmapConfig({
		...value,
		id,
		pins,
		name: typeof value['name'] === 'string' ? value['name'] : id,
		width: typeof value['width'] === 'number' ? value['width'] : 200,
		height: typeof value['height'] === 'number' ? value['height'] : 200,
		images: Array.isArray(value['images']) ? value['images'] : [],
		functionTypes: Array.isArray(value['functionTypes'])
			? value['functionTypes']
			: Array.isArray(value['function_types'])
				? value['function_types']
				: []
	})
}

const buildPinmapIdFromApiItem = (item: Record<string, unknown>) => {
	for (const key of ['pinmapId', 'fullId', 'full_id', 'pin_map_id'] as const) {
		const value = item[key]
		if (typeof value === 'string' && value.includes(':')) return value
	}

	const library = normalizePackageSlugFromApi(
		item['library'] ?? item['librarySlug'] ?? item['packageSlug'] ?? item['package']
	)
	const model =
		(typeof item['modelId'] === 'string' && item['modelId']) ||
		(item['model'] && typeof (item['model'] as { id?: unknown }).id === 'string'
			? (item['model'] as { id: string }).id
			: null) ||
		(typeof item['slug'] === 'string' ? item['slug'] : null)
	const variant =
		(typeof item['variantId'] === 'string' && item['variantId']) ||
		(item['variant'] && typeof (item['variant'] as { id?: unknown }).id === 'string'
			? (item['variant'] as { id: string }).id
			: null) ||
		'default'

	return library && model ? `${library}:${model}:${variant}` : null
}

const extractCloudPinmapItemVersion = (item: Record<string, unknown>) => {
	const version = item['version'] ?? item['itemVersion']
	return typeof version === 'string' || typeof version === 'number' ? version : undefined
}

const resolveRemotePinmapConfigFromApiItem = async (
	item: Record<string, unknown>,
	apiBase: string,
	headers: Record<string, string>
) => {
	let raw =
		item['pinmapConfig'] ??
		item['config'] ??
		item['pinmap'] ??
		item['componentConfig'] ??
		item['component'] ??
		item['pinmap_config'] ??
		item['config_json'] ??
		item['pinmap_json']

	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			return null
		}
	}

	const normalized = normalizeRemotePinmapConfigFromApiItem(raw, item)
	if (normalized) return normalized

	const url =
		resolveDownloadUrl(apiBase, item['pinmapUrl']) ||
		resolveDownloadUrl(apiBase, item['downloadUrl']) ||
		resolveDownloadUrl(apiBase, item['configUrl']) ||
		resolveDownloadUrl(apiBase, item['assetUrl']) ||
		resolveDownloadUrl(apiBase, item['pinmap_url']) ||
		resolveDownloadUrl(apiBase, item['download_url']) ||
		resolveDownloadUrl(apiBase, item['config_url']) ||
		resolveDownloadUrl(apiBase, item['asset_url'])
	if (!url) return null

	try {
		const response = await fetch(url, { headers })
		if (!response.ok) return null
		return normalizeRemotePinmapConfigFromApiItem(await response.json(), item)
	} catch {
		return null
	}
}

/**
 * 从云端同步 pinmap 到本地包目录。
 * @param {{
 * config?: AilyAppConfig,
 * packagesBasePath: string,
 * pinmapIdHints?: string[],
 * authToken?: string,
 * headers?: Record<string, string>
 * }} input - 云端同步输入
 * @returns {Promise<number>}
 */
export const syncConnectionPinmapComponentsFromApi = async (input: {
	config?: AilyAppConfig
	packagesBasePath: string
	pinmapIdHints?: Array<string>
	authToken?: string
	headers?: Record<string, string>
}): Promise<number> => {
	try {
		const apiBase =
			getCurrentApiServer(input.config?.regions, input.config?.region, DEFAULT_REGION_KEY) || AILY_API_SERVER
		const localHeaders: Record<string, string> = {
			Accept: 'application/json',
			...(input.headers || {})
		}
		if (input.authToken && !localHeaders['Authorization'] && !localHeaders['authorization']) {
			localHeaders['Authorization'] = `Bearer ${input.authToken}`
		}
		if (!localHeaders['Authorization'] && !localHeaders['authorization']) return 0

		const ailyRoot = `${input.packagesBasePath}/@aily-project`
		const fs = await import('node:fs')
		if (!fs.existsSync(ailyRoot)) return 0

		const packageDirs = fs
			.readdirSync(ailyRoot)
			.filter(
				name =>
					(name.startsWith('lib-') || name.startsWith('board-')) && fs.statSync(`${ailyRoot}/${name}`).isDirectory()
			)
		if (packageDirs.length === 0) return 0

		const hinted = new Set<string>()
		for (const id of input.pinmapIdHints || []) {
			const { packageSlug } = parsePinmapId(id)
			if (packageSlug) hinted.add(packageSlug)
		}

		const allLibs = packageDirs.filter(name => name.startsWith('lib-'))
		const allBoards = packageDirs.filter(name => name.startsWith('board-'))
		const targetLibraries =
			hinted.size > 0
				? Array.from(new Set([...allLibs.filter(name => hinted.has(name)), ...allBoards]))
				: [...allLibs, ...allBoards]

		const localPackageSet = new Set(packageDirs)
		let synced = 0

		for (const library of targetLibraries) {
			let page = 1
			let seenCount = 0

			while (page <= 40) {
				const params = new URLSearchParams({
					q: library,
					status: 'approved',
					page: String(page),
					pageSize: '50',
					sort: 'updated_at'
				})
				const response = await fetch(
					`${apiBase.replace(/\/$/, '')}${AILY_PINMAP_COMPONENTS_PATH}?${params.toString()}`,
					{
						headers: localHeaders
					}
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
					if (!localPackageSet.has(packageSlug)) continue

					const config = await resolveRemotePinmapConfigFromApiItem(item, apiBase, localHeaders)
					if (!config) continue

					const cloudVersion = extractCloudPinmapItemVersion(item)
					if (cloudVersion !== undefined) {
						const catalog = readConnectionPinmapCatalog(`${ailyRoot}/${packageSlug}`)
						const ref = parsePinmapId(pinmapId)
						const existingVariant = catalog?.models
							.find(model => model.id === ref.modelId)
							?.variants.find(variant => variant.id === ref.variantId) as { version?: string | number } | undefined
						if (
							existingVariant?.version !== undefined &&
							String(existingVariant.version).trim() === String(cloudVersion).trim()
						) {
							continue
						}
					}

					const save = saveConnectionPinmapConfig(pinmapId, config, input.packagesBasePath, cloudVersion)
					if (save.success) synced++
				}

				page++
				if (total !== null && seenCount >= total) break
			}
		}

		return synced
	} catch {
		return 0
	}
}
