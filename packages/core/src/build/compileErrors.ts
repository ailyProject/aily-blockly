import type {
	CompileDiagnostic,
	CompileDiagnosticSeverity,
	CompileDiagnosticSummary,
	ExtractedCompileErrors
} from './types'

const ANSI_PATTERN = /\u001b\[\d+(;\d+)*m/g
const RAW_ANSI_PATTERN = /\[\d+(;\d+)*m/g

/**
 * 清除 ANSI 转义码和构建器标签
 * @param text - 原始输出文本
 */
export const stripBuildOutputDecorators = (text: string) =>
	text
		.replace(ANSI_PATTERN, '')
		.replace(RAW_ANSI_PATTERN, '')
		.replace(/\[ERROR\]\s*/gi, '')
		.replace(/\[WARNING\]\s*/gi, '')

/**
 * 将绝对路径缩短为 sketch 相对路径
 * @param line - 单行输出
 */
export const shortenBuildPath = (line: string) => line.replace(/[A-Za-z]:[\\/].*?[\\/]\.temp[\\/]sketch[\\/]/g, '')

/**
 * 从完整 stderr 中提取关键编译错误
 * @param fullStdErr - 编译 stderr
 * @param maxLength - 最大返回长度
 */
export const extractCompileErrors = (fullStdErr: string, maxLength = 3000): ExtractedCompileErrors => {
	if (!fullStdErr) {
		return {
			text: '',
			truncated: false
		}
	}

	const cleaned = stripBuildOutputDecorators(fullStdErr)
	const lines = cleaned.split('\n')
	const relevantLines: Array<string> = []

	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed) continue

		if (/:\s*(error|warning|note|fatal error):/i.test(trimmed)) {
			relevantLines.push(shortenBuildPath(trimmed))
			continue
		}

		if (trimmed.startsWith('FAILED:')) {
			const brief = trimmed.match(/^FAILED:\s*\[code=\d+\]\s*\S+/)
			relevantLines.push(brief ? brief[0] : trimmed.slice(0, 80))
			continue
		}

		if (/^Compilation\s+(failed|error)/i.test(trimmed)) {
			relevantLines.push(trimmed)
			continue
		}

		if (/undefined reference/i.test(trimmed)) {
			relevantLines.push(shortenBuildPath(trimmed))
		}
	}

	const joined = relevantLines.join('\n')
	if (joined.length <= maxLength) {
		return {
			text: joined,
			truncated: false
		}
	}

	return {
		text: joined.slice(0, maxLength) + '\n... (错误信息已截断)',
		truncated: true
	}
}

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

/**
 * 为旧编译错误快照补充“过期提醒”
 * @param diagnostics - 编译诊断列表
 * @param timestamp - 快照时间戳
 * @param staleMinutes - 视为过期的分钟数
 */
export const withCompileStalenessWarning = (
	diagnostics: Array<CompileDiagnostic>,
	timestamp: number,
	staleMinutes = 5
) => {
	const ageMinutes = (Date.now() - timestamp) / 60000
	if (!diagnostics.some(item => item.source === 'build') || ageMinutes <= staleMinutes) {
		return diagnostics
	}

	return [
		...diagnostics,
		{
			source: 'build',
			severity: 'warning',
			message: `注意: 编译错误数据来自 ${Math.round(ageMinutes)} 分钟前，代码可能已修改。建议重新编译确认。`
		} satisfies CompileDiagnostic
	]
}
