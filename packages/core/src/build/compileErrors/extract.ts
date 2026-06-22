import { shortenBuildPath, stripBuildOutputDecorators } from './clean'

import type { ExtractedCompileErrors } from './types'

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
