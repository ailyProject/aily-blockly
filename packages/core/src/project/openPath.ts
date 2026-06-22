import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * 把用户选中的文件或目录路径解析成项目根目录。
 * @param inputPath - 原始输入路径
 */
export const resolveProjectOpenPath = (inputPath: string) => {
	const normalizedPath = String(inputPath || '').trim()
	if (!normalizedPath || !existsSync(normalizedPath)) return ''

	try {
		const stat = statSync(normalizedPath)
		if (stat.isDirectory()) return normalizedPath
		return path.dirname(normalizedPath)
	} catch {
		return ''
	}
}
