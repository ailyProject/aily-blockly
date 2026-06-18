import type { ArduinoLintError, ArduinoLintFormat, ArduinoLintMode, ArduinoLintResult } from './arduinoLint.types'

/**
 * 解析 Arduino lint JSON 输出
 * @param output - 原始输出
 * @param executionTime - 执行耗时
 * @param mode - 检测模式
 */
export const parseArduinoLintJson = (
	output: string,
	executionTime: number,
	mode: ArduinoLintMode
): ArduinoLintResult => {
	let jsonText = output
	const jsonStart = output.indexOf('{')

	if (jsonStart !== -1) {
		jsonText = output.substring(jsonStart)

		let braceCount = 0
		let jsonEnd = -1
		for (let index = 0; index < jsonText.length; index += 1) {
			if (jsonText[index] === '{') braceCount += 1
			if (jsonText[index] === '}') {
				braceCount -= 1
				if (braceCount === 0) {
					jsonEnd = index + 1
					break
				}
			}
		}

		if (jsonEnd !== -1) {
			jsonText = jsonText.substring(0, jsonEnd)
		}
	}

	if (!jsonText.trim()) {
		throw new Error('提取的 JSON 文本为空')
	}

	const jsonResult = JSON.parse(jsonText)
	return {
		success: jsonResult.success || false,
		errors: jsonResult.errors || [],
		warnings: jsonResult.warnings || [],
		executionTime: jsonResult.executionTime || executionTime,
		mode: jsonResult.mode || mode
	}
}

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

/**
 * 解析 Arduino lint 人类可读输出
 * @param output - 原始输出
 * @param executionTime - 执行耗时
 * @param mode - 检测模式
 */
export const parseArduinoLintHuman = (
	output: string,
	executionTime: number,
	mode: ArduinoLintMode
): ArduinoLintResult => {
	const errors: Array<ArduinoLintError> = []
	const warnings: Array<ArduinoLintError> = []

	if (!output || output.trim().length === 0) {
		return { success: true, errors, warnings, executionTime, mode }
	}

	if (output.includes('✅ Syntax check passed!')) {
		return { success: true, errors, warnings, executionTime, mode }
	}

	if (output.includes('❌ Syntax check failed!')) {
		for (const line of output.split('\n')) {
			const trimmedLine = line.trim()
			if (!trimmedLine) continue

			const match = trimmedLine.match(/^(.+):(\d+):(\d+)\s+(.+)$/)
			if (!match) continue

			const [, file, lineStr, columnStr, message] = match
			errors.push({
				file: file.trim(),
				line: Number.parseInt(lineStr, 10),
				column: Number.parseInt(columnStr, 10),
				message: message.trim(),
				severity: 'error'
			})
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

/**
 * 统一解析 Arduino lint 输出
 * @param output - 原始输出
 * @param startTime - 开始时间戳
 * @param mode - 检测模式
 * @param format - 输出格式
 */
export const parseArduinoLintResult = (
	output: string,
	startTime: number,
	mode: ArduinoLintMode,
	format: ArduinoLintFormat
): ArduinoLintResult => {
	const executionTime = Date.now() - startTime

	try {
		if (format === 'json') {
			return parseArduinoLintJson(output, executionTime, mode)
		}

		if (format === 'vscode') {
			return parseArduinoLintVSCode(output, executionTime, mode)
		}

		return parseArduinoLintHuman(output, executionTime, mode)
	} catch (error) {
		return {
			success: false,
			errors: [
				{
					file: 'sketch.ino',
					line: 1,
					column: 1,
					message: `结果解析失败: ${(error as Error).message}`,
					severity: 'error'
				}
			],
			warnings: [],
			executionTime,
			mode
		}
	}
}
