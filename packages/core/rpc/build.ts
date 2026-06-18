import { z } from 'zod'

import { parseArduinoLintResult } from '../build'
import { p, r } from './trpc'

const lintSchema = z.object({
	/** Arduino lint 原始输出 */
	output: z.string(),
	/** 检查开始时间戳 */
	startTime: z.number(),
	/** 检测模式 */
	mode: z.enum(['fast', 'accurate', 'auto', 'ast-grep']),
	/** 输出格式 */
	format: z.enum(['human', 'vscode', 'json'])
})

/**
 * 暴露构建诊断与 lint 解析能力
 */
export default r({
	parseArduinoLintResult: p
		.input(lintSchema)
		.query(({ input }) => parseArduinoLintResult(input.output, input.startTime, input.mode, input.format))
})
