import type { ArduinoLintMode, ArduinoLintResult } from './types'

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
