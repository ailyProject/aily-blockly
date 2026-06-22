import { z } from 'zod'

export const parseArduinoLintResultSchema = z.object({
	/** Arduino lint 原始输出。 */
	output: z.string(),
	/** 检查开始时间戳。 */
	startTime: z.number(),
	/** 检测模式。 */
	mode: z.enum(['fast', 'accurate', 'auto', 'ast-grep']),
	/** 输出格式。 */
	format: z.enum(['human', 'vscode', 'json'])
})

export const projectBuildInputSchema = z.object({
	/** 要构建的项目目录。 */
	projectPath: z.string(),
	/** Electron userData 路径。 */
	appDataPath: z.string(),
	/** child 目录路径。 */
	childPath: z.string(),
	/** 本次构建要写入 sketch 的源码；缺失时回退到项目现有源码。 */
	code: z.string().optional()
})
