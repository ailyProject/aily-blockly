import type { ArduinoLintError, ArduinoLintMode, ArduinoLintResult } from './types'

/**
 * 解析 Arduino lint VS Code 输出
 * @param output - 原始输出
 * @param executionTime - 执行耗时
 * @param mode - 检测模式
 */
export const parseArduinoLintVSCode = (
	output: string,
	executionTime: number,
	mode: ArduinoLintMode
): ArduinoLintResult => {
	const errors: Array<ArduinoLintError> = []
	const warnings: Array<ArduinoLintError> = []

	if (!output || output.trim().length === 0) {
		return { success: true, errors, warnings, executionTime, mode }
	}

	for (const line of output.split('\n')) {
		const trimmedLine = line.trim()
		if (!trimmedLine) continue

		const match = trimmedLine.match(/^(.+)\((\d+),(\d+)\):\s+(error|warning|info):\s+(.+)$/)
		if (!match) continue

		const [, file, lineStr, columnStr, severity, message] = match
		const lintError: ArduinoLintError = {
			file: file.trim(),
			line: Number.parseInt(lineStr, 10),
			column: Number.parseInt(columnStr, 10),
			message: message.trim(),
			severity: severity.toLowerCase() === 'error' ? 'error' : 'warning'
		}

		if (lintError.severity === 'error') {
			errors.push(lintError)
		} else {
			warnings.push(lintError)
		}
	}

	return {
		success: errors.length === 0,
		errors,
		warnings,
		executionTime,
		mode
	}
}
