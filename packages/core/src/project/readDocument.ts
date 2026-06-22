import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { normalizeProjectDocument } from '../document'
import { resolveProjectDocumentPath, resolveProjectTempDocumentPath } from './documentPaths'

import type { ProjectDocumentSnapshot } from './types'

const readProjectDocumentFile = async (input: {
	filePath: string
	tempFilePath: string
	sourceFilePath: string
	recoveredFromTemp: boolean
}): Promise<ProjectDocumentSnapshot> => {
	try {
		const raw = await readFile(input.sourceFilePath, 'utf8')
		return {
			exists: true,
			filePath: input.filePath,
			tempFilePath: input.tempFilePath,
			sourceFilePath: input.sourceFilePath,
			recoveredFromTemp: input.recoveredFromTemp,
			document: normalizeProjectDocument(JSON.parse(raw))
		}
	} catch (error) {
		return {
			exists: true,
			filePath: input.filePath,
			tempFilePath: input.tempFilePath,
			sourceFilePath: input.sourceFilePath,
			recoveredFromTemp: input.recoveredFromTemp,
			parseError: error instanceof Error ? error.message : String(error),
			document: normalizeProjectDocument(undefined)
		}
	}
}

const tryReadTempFallback = async (input: {
	filePath: string
	tempFilePath: string
}): Promise<ProjectDocumentSnapshot | null> => {
	if (!existsSync(input.tempFilePath)) return null

	return readProjectDocumentFile({
		filePath: input.filePath,
		tempFilePath: input.tempFilePath,
		sourceFilePath: input.tempFilePath,
		recoveredFromTemp: true
	})
}

/**
 * 读取并归一化当前项目的 `project.abi` 文档。
 * @param projectPath - 当前项目目录
 */
export const readProjectDocument = async (projectPath: string): Promise<ProjectDocumentSnapshot> => {
	const filePath = resolveProjectDocumentPath(projectPath)
	const tempFilePath = resolveProjectTempDocumentPath(projectPath)
	if (!existsSync(filePath)) {
		const fallbackSnapshot = await tryReadTempFallback({
			filePath,
			tempFilePath
		})
		if (fallbackSnapshot) {
			return fallbackSnapshot
		}

		return {
			exists: false,
			filePath,
			tempFilePath,
			document: normalizeProjectDocument(undefined)
		}
	}

	const primarySnapshot = await readProjectDocumentFile({
		filePath,
		tempFilePath,
		sourceFilePath: filePath,
		recoveredFromTemp: false
	})
	if (!primarySnapshot.parseError) return primarySnapshot

	const fallbackSnapshot = await tryReadTempFallback({
		filePath,
		tempFilePath
	})
	return fallbackSnapshot ?? primarySnapshot
}
