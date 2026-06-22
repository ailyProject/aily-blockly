import type { ConnectionPinmapConfig } from '../../types'

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

/**
 * 从云端单项载荷中提取 pinmap 配置。
 * @param raw - 云端原始配置字段
 * @param item - 当前云端条目
 */
export const normalizeRemotePinmapConfigFromApiItem = (
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
