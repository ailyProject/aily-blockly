/**
 * Arduino lint 检测模式
 */
export type ArduinoLintMode =
	/** 快速检测 */
	| 'fast'
	/** 精确检测 */
	| 'accurate'
	/** 自动选择模式 */
	| 'auto'
	/** 使用 ast-grep 模式 */
	| 'ast-grep'

/**
 * Arduino lint 输出格式
 */
export type ArduinoLintFormat =
	/** 人类可读文本 */
	| 'human'
	/** VS Code 诊断格式 */
	| 'vscode'
	/** JSON 结构化格式 */
	| 'json'

/**
 * Arduino lint 错误
 */
export interface ArduinoLintError {
	/** 文件路径 */
	file: string
	/** 行号 */
	line: number
	/** 列号 */
	column: number
	/** 错误消息 */
	message: string
	/** 严重级别 */
	severity: 'error' | 'warning'
}

/**
 * Arduino lint 检查结果
 */
export interface ArduinoLintResult {
	/** 是否成功通过检查 */
	success: boolean
	/** 错误列表 */
	errors: Array<ArduinoLintError>
	/** 警告列表 */
	warnings: Array<ArduinoLintError>
	/** 执行耗时 */
	executionTime: number
	/** 实际使用的模式 */
	mode?: string
}
