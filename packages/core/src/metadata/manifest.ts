import { getDeclaredDependencies } from '../project'
import { collectBlockTypesFromProjectDocument } from './blockTypes'

import type { ProjectPackageJson } from '../project'
import type {
	BlockLibraryBinding,
	BlocklyProjectDocument,
	BlocklyUsedLibraryManifest,
	BlocklyUsedLibraryManifestEntry
} from './types'

const getPackageDependencySpec = (packageJson: ProjectPackageJson | null | undefined, packageName: string) =>
	getDeclaredDependencies(packageJson ?? {}).all[packageName] ?? ''

/**
 * 判断两份 used-library manifest entry 是否等价
 * @param previousEntry - 旧 entry
 * @param nextEntry - 新 entry
 */
export const isSameUsedLibraryManifestEntry = (
	previousEntry: unknown,
	nextEntry: BlocklyUsedLibraryManifestEntry
): boolean => {
	if (!previousEntry || typeof previousEntry !== 'object') {
		return false
	}

	const previous = previousEntry as Partial<BlocklyUsedLibraryManifestEntry>
	const previousBlockTypes = Array.isArray(previous.blockTypes)
		? previous.blockTypes.filter((blockType: unknown): blockType is string => typeof blockType === 'string').sort()
		: []

	return (
		String(previous.version || '') === nextEntry.version &&
		String(previous.localPath || '') === String(nextEntry.localPath || '') &&
		JSON.stringify(previousBlockTypes) === JSON.stringify(nextEntry.blockTypes)
	)
}

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
			blockTypes: Array.from(new Set(blockTypes)).sort(),
			updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
		}
	}

	return manifest
}

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
				blockTypes: Array.from(new Set(entry.blockTypes)).sort()
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
