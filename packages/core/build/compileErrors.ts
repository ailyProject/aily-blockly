import type { CompileDiagnostic, CompileDiagnosticSeverity, ExtractedCompileErrors } from './types'

const ANSI_PATTERN = /\u001b\[\d+(;\d+)*m/g
const RAW_ANSI_PATTERN = /\[\d+(;\d+)*m/g

/**
 * 清除 ANSI 转义码和构建器标签
 * @param {string} text - 原始输出文本
 * @returns {string}
 */
export const stripBuildOutputDecorators = (text: string) =>
	text
		.replace(ANSI_PATTERN, '')
		.replace(RAW_ANSI_PATTERN, '')
		.replace(/\[ERROR\]\s*/gi, '')
		.replace(/\[WARNING\]\s*/gi, '')

/**
 * 将绝对路径缩短为 sketch 相对路径
 * @param {string} line - 单行输出
 * @returns {string}
 */
export const shortenBuildPath = (line: string) => line.replace(/[A-Za-z]:[\\/].*?[\\/]\.temp[\\/]sketch[\\/]/g, '')

/**
 * 从完整 stderr 中提取关键编译错误
 * @param {string} fullStdErr - 编译 stderr
 * @param {number} maxLength - 最大返回长度
 * @returns {ExtractedCompileErrors}
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
 * @param {string} stderr - 编译 stderr
 * @returns {CompileDiagnostic[]}
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
