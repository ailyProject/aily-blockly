/**
 * 编译诊断严重级别
 */
export type CompileDiagnosticSeverity =
	/** 编译错误 */
	| 'error'
	/** 编译警告 */
	| 'warning'
	/** 编译备注 */
	| 'note'

/**
 * 编译诊断项
 */
export interface CompileDiagnostic {
	/** 诊断来源 */
	source: 'build'
	/** 文件路径 */
	file?: string
	/** 行号 */
	line?: number
	/** 列号 */
	column?: number
	/** 严重级别 */
	severity: CompileDiagnosticSeverity
	/** 诊断消息 */
	message: string
}

/**
 * 编译错误提取结果
 */
export interface ExtractedCompileErrors {
	/** 提取后的文本 */
	text: string
	/** 是否发生截断 */
	truncated: boolean
}
