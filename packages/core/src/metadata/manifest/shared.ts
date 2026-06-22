import { getDeclaredDependencies } from '../../project'

import type { ProjectPackageJson } from '../../project'
import type { BlocklyUsedLibraryManifestEntry } from '../types'

/**
 * 读取 package.json 中声明的依赖版本。
 * @param packageJson - 项目 package.json
 * @param packageName - 目标依赖名
 */
export const getPackageDependencySpec = (packageJson: ProjectPackageJson | null | undefined, packageName: string) =>
	getDeclaredDependencies(packageJson ?? {}).all[packageName] ?? ''

/**
 * 归一化并去重 block type 列表。
 * @param blockTypes - 原始 block type 集合
 */
export const normalizeManifestBlockTypes = (blockTypes: Array<string>) => Array.from(new Set(blockTypes)).sort()

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
