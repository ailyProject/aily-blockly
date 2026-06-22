import type { CloudProjectSummary } from 'shared'
import type { RemoteCloudProjectItem } from './types'

const CLOUD_ASSET_PREFIX = '/files/'

const normalizeCloudTags = (tags: RemoteCloudProjectItem['tags']) => {
	if (Array.isArray(tags)) {
		return tags
			.filter(tag => typeof tag === 'string')
			.map(tag => tag.trim())
			.filter(Boolean)
	}

	if (typeof tags === 'string' && tags.trim()) {
		try {
			const parsed = JSON.parse(tags)
			return Array.isArray(parsed)
				? parsed
						.filter(tag => typeof tag === 'string')
						.map(tag => tag.trim())
						.filter(Boolean)
				: []
		} catch {
			return tags
				.split(',')
				.map(tag => tag.trim())
				.filter(Boolean)
		}
	}

	return []
}

const resolveCloudAssetUrl = (apiBase: string, assetPath: string | undefined) => {
	if (!assetPath?.trim()) return undefined
	if (/^https?:\/\//i.test(assetPath)) return assetPath
	if (assetPath.startsWith(CLOUD_ASSET_PREFIX)) {
		return `${apiBase}/api/v1/cloud${assetPath}`
	}
	return `${apiBase}${assetPath.startsWith('/') ? assetPath : `/${assetPath}`}`
}

/**
 * 归一化云项目条目。
 * @param item - 云端原始项目条目
 * @param apiBase - 当前 API 根地址
 */
export const normalizeCloudProjectSummary = (item: RemoteCloudProjectItem, apiBase: string): CloudProjectSummary => ({
	id: String(item.id ?? ''),
	name: item.name?.trim() || 'cloud-project',
	nickname: item.nickname?.trim() || undefined,
	description: item.description?.trim() || undefined,
	docUrl: item.doc_url?.trim() || undefined,
	imageUrl: resolveCloudAssetUrl(apiBase, item.image_url),
	archiveUrl: resolveCloudAssetUrl(apiBase, item.archive_url),
	board: item.board?.trim() || undefined,
	tags: normalizeCloudTags(item.tags),
	isTemplate: item.is_template === true,
	isPublished: item.is_published === true
})
