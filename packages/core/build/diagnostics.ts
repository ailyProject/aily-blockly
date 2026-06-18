import { formatCompileDiagnostics, summarizeCompileDiagnostics } from './compileErrors'
import { formatLintErrors, summarizeLintResult } from './lint'

import type { LintResult } from './lintTypes'
import type { CompileDiagnostic } from './types'

/**
 * 统一诊断来源
 */
export type ProjectDiagnosticSource =
	/** lint 诊断 */
	| 'lint'
	/** 编译诊断 */
	| 'build'
	/** ABS 诊断 */
	| 'abs'

/**
 * 统一诊断严重级别
 */
export type ProjectDiagnosticSeverity =
	/** 错误 */
	| 'error'
	/** 警告 */
	| 'warning'
	/** 备注 */
	| 'note'

/**
 * 统一项目诊断项
 */
export interface ProjectDiagnostic {
	/** 诊断来源 */
	source: ProjectDiagnosticSource
	/** 文件路径 */
	file?: string
	/** 行号 */
	line?: number
	/** 列号 */
	column?: number
	/** 严重级别 */
	severity: ProjectDiagnosticSeverity
	/** 诊断消息 */
	message: string
}

/**
 * 统一诊断摘要
 */
export interface ProjectDiagnosticSummary {
	/** 错误数量 */
	errorCount: number
	/** 警告数量 */
	warningCount: number
	/** 备注数量 */
	noteCount: number
	/** 诊断总数 */
	total: number
}

/**
 * 统一诊断报告
 */
export interface ProjectDiagnosticReport {
	/** 汇总文本 */
	summaryText: string
	/** 按来源分段的详情文本 */
	detailText: string
	/** 汇总统计 */
	summary: ProjectDiagnosticSummary
	/** 扁平诊断列表 */
	diagnostics: Array<ProjectDiagnostic>
}

/**
 * 将编译诊断转换为统一诊断
 * @param {CompileDiagnostic[]} diagnostics - 编译诊断
 * @returns {ProjectDiagnostic[]}
 */
export const fromCompileDiagnostics = (diagnostics: Array<CompileDiagnostic>): Array<ProjectDiagnostic> =>
	diagnostics.map(diagnostic => ({
		source: 'build',
		file: diagnostic.file,
		line: diagnostic.line,
		column: diagnostic.column,
		severity: diagnostic.severity,
		message: diagnostic.message
	}))

/**
 * 将 lint 结果转换为统一诊断
 * @param {LintResult} lintResult - lint 结果
 * @returns {ProjectDiagnostic[]}
 */
export const fromLintResult = (lintResult: LintResult): Array<ProjectDiagnostic> =>
	lintResult.errors.map(error => ({
		source: 'lint',
		file: lintResult.filePath,
		line: error.line,
		column: error.column,
		severity: error.severity,
		message: error.message
	}))

/**
 * 汇总统一诊断
 * @param {ProjectDiagnostic[]} diagnostics - 诊断列表
 * @returns {ProjectDiagnosticSummary}
 */
export const summarizeProjectDiagnostics = (diagnostics: Array<ProjectDiagnostic>): ProjectDiagnosticSummary => ({
	errorCount: diagnostics.filter(item => item.severity === 'error').length,
	warningCount: diagnostics.filter(item => item.severity === 'warning').length,
	noteCount: diagnostics.filter(item => item.severity === 'note').length,
	total: diagnostics.length
})

/**
 * 格式化统一诊断为分段文本
 * @param {ProjectDiagnostic[]} diagnostics - 诊断列表
 * @returns {string}
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
 * @param {ProjectDiagnostic[]} diagnostics - 诊断列表
 * @returns {ProjectDiagnosticReport}
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
