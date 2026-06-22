import { collectBlockTypesFromProjectDocument } from '../blockTypes'
import { getPackageDependencySpec, isSameUsedLibraryManifestEntry, normalizeManifestBlockTypes } from './shared'

import type { ProjectPackageJson } from '../../project'
import type { BlockLibraryBinding, BlocklyProjectDocument, BlocklyUsedLibraryManifest } from '../types'

/**
 * 根据 block type 到库的映射生成项目 used-library manifest
 * @param document - 项目文档
 * @param blockTypeBindings - block type 到库的映射
 * @param packageJson - 当前 package.json
 * @param previousManifest - 之前的 manifest
 */
export const buildUsedLibraryManifest = (
	document: BlocklyProjectDocument,
	blockTypeBindings: Record<string, BlockLibraryBinding>,
	packageJson?: ProjectPackageJson | null,
	previousManifest: BlocklyUsedLibraryManifest = {}
): BlocklyUsedLibraryManifest => {
	const usedBlockTypes = collectBlockTypesFromProjectDocument(document)
	const manifest: BlocklyUsedLibraryManifest = {}
	const updatedAt = Date.now()

	for (const blockType of usedBlockTypes) {
		const libInfo = blockTypeBindings[blockType]
		if (!libInfo?.name) continue

		const dependencySpec = getPackageDependencySpec(packageJson, libInfo.name)
		const entry = manifest[libInfo.name] || {
			version: dependencySpec || libInfo.version || '',
			localPath: libInfo.localPath,
			blockTypes: [],
			updatedAt
		}

		if (!entry.version && (dependencySpec || libInfo.version)) {
			entry.version = dependencySpec || libInfo.version || ''
		}
		if (!entry.localPath && libInfo.localPath) {
			entry.localPath = libInfo.localPath
		}

		entry.blockTypes.push(blockType)
		entry.updatedAt = updatedAt
		manifest[libInfo.name] = entry
	}

	return Object.keys(manifest)
		.sort((left, right) => left.localeCompare(right))
		.reduce<BlocklyUsedLibraryManifest>((result, packageName) => {
			const entry = manifest[packageName]
			const nextEntry = {
				...entry,
				blockTypes: normalizeManifestBlockTypes(entry.blockTypes)
			}
			const previousEntry = previousManifest[packageName]
			if (isSameUsedLibraryManifestEntry(previousEntry, nextEntry)) {
				nextEntry.updatedAt = typeof previousEntry.updatedAt === 'number' ? previousEntry.updatedAt : updatedAt
			}
			result[packageName] = {
				...nextEntry
			}
			return result
		}, {})
}
