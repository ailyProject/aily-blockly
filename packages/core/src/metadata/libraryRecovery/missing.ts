import { getDeclaredBlocklyLibraryDependencies, isBlocklyLibraryPackageName } from '../../project'
import { collectBlockTypesFromProjectDocument } from '../blockTypes'
import { normalizeUsedLibraryManifest } from '../manifest'
import { compareBlocklyLibraryNames, resolveManifestLocalPath } from './shared'

import type { ProjectPackageJson } from '../../project'
import type { BlocklyProjectDocument, MissingBlocklyLibraryInfo } from '../types'

/**
 * 计算缺失的项目库
 * @param projectPath - 项目路径
 * @param packageJson - 项目 package.json
 * @param manifestValue - 原始 used-library manifest
 * @param projectDocument - 当前项目文档
 * @param readyLibraryPackages - 已就绪的库包名集合
 */
export const getMissingProjectLibraries = (
	projectPath: string,
	packageJson: ProjectPackageJson | null | undefined,
	manifestValue: unknown,
	projectDocument: BlocklyProjectDocument,
	readyLibraryPackages: Iterable<string>
): Array<MissingBlocklyLibraryInfo> => {
	const manifest = normalizeUsedLibraryManifest(manifestValue)
	const projectBlockTypes = new Set(collectBlockTypesFromProjectDocument(projectDocument))
	const declaredLibraryDependencies = getDeclaredBlocklyLibraryDependencies(packageJson)
	const readySet = new Set(readyLibraryPackages)
	const missingLibraries: Array<MissingBlocklyLibraryInfo> = []

	for (const [packageName, entry] of Object.entries(manifest)) {
		if (!isBlocklyLibraryPackageName(packageName)) continue

		const usedBlockType = entry.blockTypes.find(blockType => projectBlockTypes.has(blockType))
		if (entry.blockTypes.length > 0 && !usedBlockType) {
			continue
		}

		const declaredVersion = declaredLibraryDependencies.get(packageName) || ''
		if (declaredVersion && readySet.has(packageName)) {
			continue
		}

		missingLibraries.push({
			blockType: usedBlockType || entry.blockTypes[0] || '',
			name: packageName,
			version: declaredVersion || entry.version || '',
			localPath: resolveManifestLocalPath(projectPath, entry)
		})
	}

	return missingLibraries.sort((left, right) => compareBlocklyLibraryNames(left.name, right.name))
}
