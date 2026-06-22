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
 * 编译诊断摘要
 */
export interface CompileDiagnosticSummary {
	/** 错误数量 */
	errorCount: number
	/** 警告数量 */
	warningCount: number
	/** 备注数量 */
	noteCount: number
	/** 诊断总数 */
	total: number
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

/**
 * 编译错误快照
 */
export interface CompileErrorSnapshot {
	/** 提取后的错误文本 */
	errors: string
	/** 记录时间戳 */
	timestamp: number
}

/**
 * 编译诊断报告
 */
export interface CompileDiagnosticReport {
	/** 汇总文本 */
	summaryText: string
	/** 明细文本 */
	detailText: string
	/** 汇总统计 */
	summary: CompileDiagnosticSummary
	/** 诊断列表 */
	diagnostics: Array<CompileDiagnostic>
}
