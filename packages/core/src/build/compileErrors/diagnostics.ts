import type { CompileDiagnostic, CompileDiagnosticSeverity, CompileDiagnosticSummary } from './types'

const toSeverity = (value: string): CompileDiagnosticSeverity => {
	const normalized = value.toLowerCase()
	if (normalized.includes('warning')) return 'warning'
	if (normalized.includes('note')) return 'note'
	return 'error'
}

/**
 * 解析编译器诊断
 * @param stderr - 编译 stderr
 */
export const parseCompileDiagnostics = (stderr: string): Array<CompileDiagnostic> => {
	const diagnostics: Array<CompileDiagnostic> = []

	for (const line of stderr.split('\n').filter(item => item.trim())) {
		const gccMatch = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning|note|fatal error):\s*(.+)/i)
		if (gccMatch) {
			diagnostics.push({
				source: 'build',
				file: gccMatch[1],
				line: Number.parseInt(gccMatch[2], 10),
				column: Number.parseInt(gccMatch[3], 10),
				severity: toSeverity(gccMatch[4]),
				message: gccMatch[5]
			})
			continue
		}

		if (line.includes('undefined reference') || line.includes('error:') || line.includes('FAILED')) {
			diagnostics.push({
				source: 'build',
				severity: 'error',
				message: line.trim()
			})
		}
	}

	return diagnostics
}

/**
 * 统计编译诊断摘要
 * @param diagnostics - 编译诊断列表
 */
export const summarizeCompileDiagnostics = (diagnostics: Array<CompileDiagnostic>): CompileDiagnosticSummary => ({
	errorCount: diagnostics.filter(item => item.severity === 'error').length,
	warningCount: diagnostics.filter(item => item.severity === 'warning').length,
	noteCount: diagnostics.filter(item => item.severity === 'note').length,
	total: diagnostics.length
})

/**
 * 格式化编译诊断为文本
 * @param diagnostics - 编译诊断列表
 */
export const formatCompileDiagnostics = (diagnostics: Array<CompileDiagnostic>) =>
	diagnostics
		.map(diagnostic => {
			const location = diagnostic.file
				? `${diagnostic.file.split(/[/\\]/).pop()}${diagnostic.line ? `:${diagnostic.line}` : ''}${diagnostic.column ? `:${diagnostic.column}` : ''}`
				: ''
			const prefix = diagnostic.severity === 'error' ? '❌' : diagnostic.severity === 'warning' ? '⚠️' : 'ℹ️'
			return location ? `- ${prefix} ${location}: ${diagnostic.message}` : `- ${prefix} ${diagnostic.message}`
		})
		.join('\n')
