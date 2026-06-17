/**
 * 可支持的 lint 文件类型
 */
export type LintLanguage =
	/** JSON 文件 */
	| 'json'
	/** JavaScript 文件 */
	| 'javascript'
	/** 当前未支持或未知文件 */
	| 'unknown'

/**
 * lint 严重级别
 */
export type LintSeverity =
	/** 错误 */
	| 'error'
	/** 警告 */
	| 'warning'

/**
 * lint 错误项
 */
export interface LintError {
	/** 行号 */
	line: number
	/** 列号 */
	column: number
	/** 错误消息 */
	message: string
	/** 严重级别 */
	severity: LintSeverity
}

/**
 * lint 结果
 */
export interface LintResult {
	/** 是否通过检查 */
	isValid: boolean
	/** 错误列表 */
	errors: Array<LintError>
	/** 文件语言类型 */
	language: LintLanguage
	/** 文件路径 */
	filePath: string
}
