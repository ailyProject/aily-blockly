import { normalizeRemotePinmapConfigFromApiItem, resolveRemoteDownloadUrl } from './normalize'

/**
 * 为单个云端条目解析本地可保存的 pinmap 配置。
 * @param item - 云端条目
 * @param apiBase - API 基地址
 * @param headers - 请求头
 */
export const resolveRemotePinmapConfigFromApiItem = async (
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
		resolveRemoteDownloadUrl(apiBase, item['pinmapUrl']) ||
		resolveRemoteDownloadUrl(apiBase, item['downloadUrl']) ||
		resolveRemoteDownloadUrl(apiBase, item['configUrl']) ||
		resolveRemoteDownloadUrl(apiBase, item['assetUrl']) ||
		resolveRemoteDownloadUrl(apiBase, item['pinmap_url']) ||
		resolveRemoteDownloadUrl(apiBase, item['download_url']) ||
		resolveRemoteDownloadUrl(apiBase, item['config_url']) ||
		resolveRemoteDownloadUrl(apiBase, item['asset_url'])
	if (!url) return null

	try {
		const response = await fetch(url, { headers })
		if (!response.ok) return null
		return normalizeRemotePinmapConfigFromApiItem(await response.json(), item)
	} catch {
		return null
	}
}
