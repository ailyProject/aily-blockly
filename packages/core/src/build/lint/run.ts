import { parseJavaScriptError, parseJsonError } from './parsers'
import { getLintLanguage, shouldLint } from './rules'

import type { LintResult } from './types'

/**
 * lint JSON 内容
 * @param content - 文件内容
 * @param filePath - 文件路径
 */
export const lintJson = (content: string, filePath: string): LintResult => {
	const result: LintResult = {
		isValid: true,
		errors: [],
		language: 'json',
		filePath
	}

	if (!content || content.trim() === '') return result

	try {
		JSON.parse(content)
	} catch (error) {
		const info = parseJsonError((error as Error).message, content)
		result.isValid = false
		result.errors.push({
			line: info.line,
			column: info.column,
			message: info.message,
			severity: 'error'
		})
	}

	return result
}

/**
 * lint JavaScript 内容
 * @param content - 文件内容
 * @param filePath - 文件路径
 */
export const lintJavaScript = (content: string, filePath: string): LintResult => {
	const result: LintResult = {
		isValid: true,
		errors: [],
		language: 'javascript',
		filePath
	}

	if (!content || content.trim() === '') return result

	try {
		new Function(content)
	} catch (error) {
		const info = parseJavaScriptError(error as Error)
		result.isValid = false
		result.errors.push({
			line: info.line,
			column: info.column,
			message: info.message,
			severity: 'error'
		})
	}

	return result
}

/**
 * 对文件内容执行 lint
 * @param content - 文件内容
 * @param filePath - 文件路径
 */
export const lintContent = (content: string, filePath: string): LintResult | null => {
	if (!shouldLint(filePath)) return null

	const fileType = getLintLanguage(filePath)
	if (fileType === 'json') return lintJson(content, filePath)
	if (fileType === 'javascript') return lintJavaScript(content, filePath)
	return null
}

/**
 * 判断内容是否存在 lint 错误
 * @param content - 文件内容
 * @param filePath - 文件路径
 */
export const hasLintErrors = (content: string, filePath: string) => {
	const lintResult = lintContent(content, filePath)
	return lintResult ? !lintResult.isValid : false
}
