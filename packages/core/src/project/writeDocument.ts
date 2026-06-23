import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { buildProjectAbiPayload } from '../abi'
import { resolveProjectTempDocumentPathFromPrimary } from './documentPaths'
import { syncProjectUsedLibraryManifest } from './syncUsedLibraryManifest'

import type { BlocklyProjectDocument } from '../document'

/**
 * 将归一化后的项目文档写回 `project.abi`。
 * @param filePath - `project.abi` 文件路径
 * @param document - 归一化后的项目文档
 */
export const writeProjectDocument = async (filePath: string, document: BlocklyProjectDocument) => {
	const payload = buildProjectAbiPayload(document)
	const text = JSON.stringify(payload, null, 2) + '\n'
	await writeFile(filePath, text, 'utf8')
	await writeFile(resolveProjectTempDocumentPathFromPrimary(filePath), text, 'utf8')
	await syncProjectUsedLibraryManifest(path.dirname(filePath), document)
}
