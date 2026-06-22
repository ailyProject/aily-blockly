import { normalizeManifestBlockTypes } from './shared'

import type { BlocklyUsedLibraryManifest, BlocklyUsedLibraryManifestEntry } from '../types'

/**
 * 规范化 used-library manifest
 * @param value - 原始 manifest 值
 */
export const normalizeUsedLibraryManifest = (value: unknown): BlocklyUsedLibraryManifest => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {}
	}

	const manifest: BlocklyUsedLibraryManifest = {}
	for (const [packageName, rawEntry] of Object.entries(value)) {
		if (!rawEntry || typeof rawEntry !== 'object') {
			continue
		}

		const entry = rawEntry as Partial<BlocklyUsedLibraryManifestEntry>
		const blockTypes = Array.isArray(entry.blockTypes)
			? entry.blockTypes.filter(
					(blockType: unknown): blockType is string => typeof blockType === 'string' && blockType.length > 0
				)
			: []
		const localPath = typeof entry.localPath === 'string' && entry.localPath.length > 0 ? entry.localPath : undefined

		manifest[packageName] = {
			version: typeof entry.version === 'string' ? entry.version : String(entry.version || ''),
			localPath,
			blockTypes: normalizeManifestBlockTypes(blockTypes),
			updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
		}
	}

	return manifest
}
