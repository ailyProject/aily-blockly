import path from 'node:path'

import { getDeclaredBlocklyLibraryDependencies, isBlocklyLibraryPackageName } from '../project'
import { collectBlockTypesFromProjectDocument } from './blockTypes'
import { normalizeUsedLibraryManifest } from './manifest'

import type { ProjectPackageJson } from '../project'
import type { BlocklyProjectDocument, BlocklyUsedLibraryManifestEntry, MissingBlocklyLibraryInfo } from './types'

/**
 * 对 Blockly 库名称进行稳定排序
 * @param {string} left - 左侧包名
 * @param {string} right - 右侧包名
 * @returns {number}
 */
export const compareBlocklyLibraryNames = (left: string, right: string) => {
	const leftIsCore = left.startsWith('@aily-project/lib-core-')
	const rightIsCore = right.startsWith('@aily-project/lib-core-')
	if (leftIsCore && !rightIsCore) return -1
	if (!leftIsCore && rightIsCore) return 1
	return left.localeCompare(right)
}

/**
 * 解析 manifest 中的本地路径
 * @param {string} projectPath - 项目路径
 * @param {BlocklyUsedLibraryManifestEntry} entry - manifest 条目
 * @returns {string}
 */
export const resolveManifestLocalPath = (projectPath: string, entry: BlocklyUsedLibraryManifestEntry): string => {
	if (entry.localPath) return entry.localPath
	if (!entry.version?.startsWith('file:')) return ''

	const filePath = entry.version.slice(5)
	if (!filePath) return ''
	if (path.isAbsolute(filePath)) return filePath

	return path.join(projectPath, filePath)
}

/**
 * 判断项目是否仍声明使用某个库
 * @param {BlocklyProjectDocument} document - 当前项目文档
 * @param {unknown} manifestValue - 原始 manifest 值
 * @param {string} packageName - 库包名
 * @returns {boolean}
 */
export const isProjectLibraryDeclaredAsUsed = (
	document: BlocklyProjectDocument,
	manifestValue: unknown,
	packageName: string
) => {
	const manifest = normalizeUsedLibraryManifest(manifestValue)
	const entry = manifest[packageName]
	if (!entry) return false
	if (entry.blockTypes.length === 0) return true

	const currentBlockTypes = new Set(collectBlockTypesFromProjectDocument(document))
	return entry.blockTypes.some(blockType => currentBlockTypes.has(blockType))
}

/**
 * 计算缺失的项目库
 * @param {string} projectPath - 项目路径
 * @param {ProjectPackageJson | null | undefined} packageJson - 项目 package.json
 * @param {unknown} manifestValue - 原始 used-library manifest
 * @param {BlocklyProjectDocument} projectDocument - 当前项目文档
 * @param {Iterable<string>} readyLibraryPackages - 已就绪的库包名集合
 * @returns {MissingBlocklyLibraryInfo[]}
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
