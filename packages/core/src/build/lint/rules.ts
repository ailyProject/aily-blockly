import type { LintLanguage } from './types'

/**
 * 判断文件是否需要 lint
 * @param filePath - 文件路径
 */
export const shouldLint = (filePath: string): boolean => {
	if (!filePath) return false
	const ext = filePath.toLowerCase().split('.').pop()
	return ext === 'json' || ext === 'js'
}

/**
 * 获取文件类型
 * @param filePath - 文件路径
 */
export const getLintLanguage = (filePath: string): LintLanguage => {
	if (!filePath) return 'unknown'
	const ext = filePath.toLowerCase().split('.').pop()
	if (ext === 'json') return 'json'
	if (ext === 'js') return 'javascript'
	return 'unknown'
}

/**
 * 过滤项目根目录下需要 lint 的文件
 * @param entries - 项目根目录条目名称
 */
export const collectLintableProjectEntries = (entries: Array<string>) =>
	entries.filter(entry => shouldLint(entry)).slice(0, 30)
