import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { createProjectSourceCandidates, hasProjectSourceCode } from './readSource/candidates'

/**
 * 项目源码读取结果。
 */
export interface ProjectSourceSnapshot {
	/** 当前命中的源码文件路径。 */
	filePath: string
	/** 文件内容。 */
	sourceCode: string
	/** 来源标签；用于区分是构建缓存还是工程入口文件。 */
	sourceKind: 'build-cache' | 'arduino-entry' | 'cpp-entry' | 'python-entry'
}

/**
 * 读取当前项目中最可能可用于构建/上传的源码文件。
 * @param projectPath - 当前项目目录
 */
export const readProjectSource = async (projectPath: string): Promise<ProjectSourceSnapshot | null> => {
	const candidates = await createProjectSourceCandidates(projectPath)

	for (const candidate of candidates) {
		if (!existsSync(candidate.filePath)) continue

		try {
			const sourceCode = await readFile(candidate.filePath, 'utf8')
			if (!sourceCode.trim()) continue

			return {
				filePath: candidate.filePath,
				sourceCode,
				sourceKind: candidate.sourceKind
			}
		} catch {
			continue
		}
	}

	return null
}

/**
 * 解析当前项目可用于构建/上传的源码文本。
 * @param projectPath - 当前项目目录
 * @param sourceCode - 上层显式传入的源码
 */
export const resolveProjectSourceCode = async (projectPath: string, sourceCode?: string | null) => {
	if (hasProjectSourceCode(sourceCode)) {
		return sourceCode!.trimEnd() + '\n'
	}

	const snapshot = await readProjectSource(projectPath)
	if (snapshot?.sourceCode.trim()) {
		return snapshot.sourceCode
	}

	throw new Error(`未找到可用于构建的项目源码: ${projectPath}`)
}
