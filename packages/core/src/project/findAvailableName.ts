import { existsSync } from 'node:fs'

import { buildProjectDirectoryPath } from './appPaths'

/**
 * 查找当前根目录下可用的项目名。
 * @param basePath - 项目根目录
 * @param inputName - 当前希望使用的项目名
 * @param separator - 路径分隔符
 */
export const findAvailableProjectName = (basePath: string, inputName: string, separator: string) => {
	const trimmedName = String(inputName || '').trim()
	if (!trimmedName) return ''

	const buildPath = (name: string) => buildProjectDirectoryPath(basePath, name, separator)
	if (!existsSync(buildPath(trimmedName))) {
		return trimmedName
	}

	for (let charCode = 97; charCode <= 122; charCode += 1) {
		const nextName = `${trimmedName}_${String.fromCharCode(charCode)}`
		if (!existsSync(buildPath(nextName))) {
			return nextName
		}
	}

	for (let index = 0; index <= 1000; index += 1) {
		const nextName = `${trimmedName}_a${index}`
		if (!existsSync(buildPath(nextName))) {
			return nextName
		}
	}

	return `${trimmedName}_${Date.now()}`
}
