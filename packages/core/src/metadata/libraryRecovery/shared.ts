import path from 'node:path'

import { collectBlockTypesFromProjectDocument } from '../blockTypes'
import { normalizeUsedLibraryManifest } from '../manifest'

import type { BlocklyProjectDocument, BlocklyUsedLibraryManifestEntry } from '../types'

/**
 * 对 Blockly 库名称进行稳定排序
 * @param left - 左侧包名
 * @param right - 右侧包名
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
 * @param projectPath - 项目路径
 * @param entry - manifest 条目
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
 * @param document - 当前项目文档
 * @param manifestValue - 原始 manifest 值
 * @param packageName - 库包名
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
