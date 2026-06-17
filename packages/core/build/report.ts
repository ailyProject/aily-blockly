import {
	formatCompileDiagnostics,
	parseCompileDiagnostics,
	summarizeCompileDiagnostics,
	withCompileStalenessWarning
} from './compileErrors'

import type { CompileDiagnosticReport, CompileErrorSnapshot } from './types'

/**
 * 从编译错误快照恢复诊断列表
 * @param snapshot - 编译错误快照
 */
export const diagnosticsFromCompileSnapshot = (snapshot: CompileErrorSnapshot) =>
	withCompileStalenessWarning(parseCompileDiagnostics(snapshot.errors), snapshot.timestamp)

/**
 * 生成编译诊断报告
 * @param snapshot - 编译错误快照
 */
export const buildCompileDiagnosticReport = (snapshot: CompileErrorSnapshot): CompileDiagnosticReport => {
	const diagnostics = diagnosticsFromCompileSnapshot(snapshot)
	const summary = summarizeCompileDiagnostics(diagnostics)

	return {
		summaryText: `发现 ${summary.errorCount} 个错误, ${summary.warningCount} 个警告`,
		detailText: formatCompileDiagnostics(diagnostics),
		summary,
		diagnostics
	}
}
