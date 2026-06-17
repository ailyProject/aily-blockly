import type { LintError, LintLanguage, LintResult } from './lintTypes'

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
 * 根据字符位置计算行号和列号
 * @param content - 文本内容
 * @param position - 字符位置
 * @returns}
 */
export const getLineAndColumn = (content: string, position: number) => {
	const lines = content.substring(0, position).split('\n')
	return {
		line: lines.length,
		column: (lines[lines.length - 1] || '').length + 1
	}
}

/**
 * 解析 JSON 错误
 * @param errorMessage - 错误消息
 * @param content - 文件内容
 * @returns}
 */
export const parseJsonError = (errorMessage: string, content: string) => {
	let line = 1
	let column = 1
	let message = errorMessage

	const positionMatch = errorMessage.match(/at position (\d+)/i)
	if (positionMatch) {
		const position = Number.parseInt(positionMatch[1], 10)
		const loc = getLineAndColumn(content, position)
		line = loc.line
		column = loc.column
	}

	if (errorMessage.includes('Unexpected end')) {
		const lines = content.split('\n')
		line = lines.length
		column = (lines[lines.length - 1] || '').length + 1
	}

	return { line, column, message }
}

/**
 * 解析 JavaScript 语法错误
 * @param error - 语法错误对象
 * @returns}
 */
export const parseJavaScriptError = (error: Error) => {
	let line = 1
	let column = 1
	const message = error.message || 'JavaScript syntax error'

	if (error.stack) {
		const stackMatch = error.stack.match(/<anonymous>:(\d+):(\d+)/)
		if (stackMatch) {
			line = Math.max(1, Number.parseInt(stackMatch[1], 10) - 2)
			column = Number.parseInt(stackMatch[2], 10)
		}
	}

	const lineMatch = message.match(/line (\d+)/i)
	if (lineMatch) {
		line = Number.parseInt(lineMatch[1], 10)
	}

	return { line, column, message }
}

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

	if (!content || content.trim() === '') {
		return result
	}

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

	if (!content || content.trim() === '') {
		return result
	}

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
 * 格式化 lint 错误
 * @param lintResult - lint 结果
 */
export const formatLintErrors = (lintResult: LintResult): string => {
	if (lintResult.isValid || lintResult.errors.length === 0) return ''

	const langName = lintResult.language === 'json' ? 'JSON' : 'JavaScript'
	const lines: Array<string> = [`\n⚠️ ${langName} Syntax Error Detected:`]

	lintResult.errors.forEach((error, index) => {
		const locationInfo =
			error.line > 0 ? `Line ${error.line}${error.column > 1 ? `, Column ${error.column}` : ''}` : 'Location unknown'

		lines.push(`  ${index + 1}. [${error.severity === 'error' ? 'Error' : 'Warning'}] ${locationInfo}`)
		lines.push(`     ${error.message}`)
	})

	lines.push('')
	lines.push('💡 Suggestion: Please fix the syntax errors above and try again.')

	return lines.join('\n')
}

/**
 * 执行 lint 并直接返回格式化错误
 * @param content - 文件内容
 * @param filePath - 文件路径
 */
export const lintAndFormat = (content: string, filePath: string) => {
	const lintResult = lintContent(content, filePath)
	if (!lintResult) return ''
	return formatLintErrors(lintResult)
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

/**
 * 统计 lint 结果摘要
 * @param lintResult - lint 结果
 * @returns}
 */
export const summarizeLintResult = (lintResult: LintResult) => ({
	errorCount: lintResult.errors.filter(error => error.severity === 'error').length,
	warningCount: lintResult.errors.filter(error => error.severity === 'warning').length,
	total: lintResult.errors.length
})

/**
 * 过滤项目根目录下需要 lint 的文件
 * @param entries - 项目根目录条目名称
 */
export const collectLintableProjectEntries = (entries: Array<string>) =>
	entries.filter(entry => shouldLint(entry)).slice(0, 30)
