import { formatCompileDiagnostics } from '../compileErrors'
import { formatLintErrors } from '../lint'

import type { CompileDiagnostic } from '../compileErrors'
import type { LintResult } from '../lint'
import type { ProjectDiagnostic, ProjectDiagnosticReport, ProjectDiagnosticSummary } from './types'

/**
 * 汇总统一诊断
 * @param diagnostics - 诊断列表
 */
export const summarizeProjectDiagnostics = (diagnostics: Array<ProjectDiagnostic>): ProjectDiagnosticSummary => ({
	errorCount: diagnostics.filter(item => item.severity === 'error').length,
	warningCount: diagnostics.filter(item => item.severity === 'warning').length,
	noteCount: diagnostics.filter(item => item.severity === 'note').length,
	total: diagnostics.length
})

/**
 * 格式化统一诊断为分段文本
 * @param diagnostics - 诊断列表
 */
export const formatProjectDiagnostics = (diagnostics: Array<ProjectDiagnostic>) => {
	const grouped = diagnostics.reduce<Record<string, Array<ProjectDiagnostic>>>((result, diagnostic) => {
		;(result[diagnostic.source] ??= []).push(diagnostic)
		return result
	}, {})

	const sections: Array<string> = []

	if (grouped['lint']?.length) {
		const lintResult: LintResult = {
			isValid: grouped['lint'].length === 0,
			errors: grouped['lint'].map(diagnostic => ({
				line: diagnostic.line ?? 0,
				column: diagnostic.column ?? 0,
				message: diagnostic.message,
				severity: diagnostic.severity === 'warning' ? 'warning' : 'error'
			})),
			language: 'unknown',
			filePath: grouped['lint'][0]?.file || ''
		}
		sections.push(`## Lint 错误 (${grouped['lint'].length})\n${formatLintErrors(lintResult)}`)
	}

	if (grouped['build']?.length) {
		const compileDiagnostics: Array<CompileDiagnostic> = grouped['build'].map(diagnostic => ({
			source: 'build',
			file: diagnostic.file,
			line: diagnostic.line,
			column: diagnostic.column,
			severity: diagnostic.severity === 'warning' || diagnostic.severity === 'note' ? diagnostic.severity : 'error',
			message: diagnostic.message
		}))
		sections.push(`## 编译错误 (${grouped['build'].length})\n${formatCompileDiagnostics(compileDiagnostics)}`)
	}

	if (grouped['abs']?.length) {
		const lines = grouped['abs'].map(diagnostic => {
			const prefix = diagnostic.severity === 'error' ? '❌' : diagnostic.severity === 'warning' ? '⚠️' : 'ℹ️'
			const location = diagnostic.line ? `Line ${diagnostic.line}` : ''
			return location ? `- ${prefix} ${location}: ${diagnostic.message}` : `- ${prefix} ${diagnostic.message}`
		})
		sections.push(`## ABS 错误 (${grouped['abs'].length})\n${lines.join('\n')}`)
	}

	return sections.join('\n\n')
}

/**
 * 生成统一诊断报告
 * @param diagnostics - 诊断列表
 */
export const buildProjectDiagnosticReport = (diagnostics: Array<ProjectDiagnostic>): ProjectDiagnosticReport => {
	const summary = summarizeProjectDiagnostics(diagnostics)
	return {
		summaryText: `发现 ${summary.errorCount} 个错误, ${summary.warningCount} 个警告`,
		detailText: formatProjectDiagnostics(diagnostics),
		summary,
		diagnostics
	}
}
