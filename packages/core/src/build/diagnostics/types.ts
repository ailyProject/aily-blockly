/**
 * 统一诊断来源
 */
export type ProjectDiagnosticSource =
	/** lint 诊断 */
	| 'lint'
	/** 编译诊断 */
	| 'build'
	/** ABS 诊断 */
	| 'abs'

/**
 * 统一项目诊断严重级别
 */
export type ProjectDiagnosticSeverity =
	/** 错误 */
	| 'error'
	/** 警告 */
	| 'warning'
	/** 备注 */
	| 'note'

/**
 * 统一项目诊断项
 */
export interface ProjectDiagnostic {
	/** 诊断来源 */
	source: ProjectDiagnosticSource
	/** 文件路径 */
	file?: string
	/** 行号 */
	line?: number
	/** 列号 */
	column?: number
	/** 严重级别 */
	severity: ProjectDiagnosticSeverity
	/** 诊断消息 */
	message: string
}

/**
 * 统一诊断摘要
 */
export interface ProjectDiagnosticSummary {
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
 * 统一诊断报告
 */
export interface ProjectDiagnosticReport {
	/** 汇总文本 */
	summaryText: string
	/** 按来源分段的详情文本 */
	detailText: string
	/** 汇总统计 */
	summary: ProjectDiagnosticSummary
	/** 扁平诊断列表 */
	diagnostics: Array<ProjectDiagnostic>
}
