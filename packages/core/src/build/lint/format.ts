import { lintContent } from './run'

import type { LintResult, LintSummary } from './types'

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
 * 统计 lint 结果摘要
 * @param lintResult - lint 结果
 */
export const summarizeLintResult = (lintResult: LintResult): LintSummary => ({
	errorCount: lintResult.errors.filter(error => error.severity === 'error').length,
	warningCount: lintResult.errors.filter(error => error.severity === 'warning').length,
	total: lintResult.errors.length
})
