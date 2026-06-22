import { parseArduinoLintHuman } from './human'
import { parseArduinoLintJson } from './json'
import { parseArduinoLintVSCode } from './vscode'

import type { ArduinoLintFormat, ArduinoLintMode, ArduinoLintResult } from './types'

export * from './human'
export * from './json'
export * from './vscode'
export * from './types'

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
