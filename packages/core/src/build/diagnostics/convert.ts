import type { CompileDiagnostic } from '../compileErrors'
import type { LintResult } from '../lint'
import type { ProjectDiagnostic } from './types'

/**
 * 将编译诊断转换为统一诊断
 * @param diagnostics - 编译诊断
 */
export const fromCompileDiagnostics = (diagnostics: Array<CompileDiagnostic>): Array<ProjectDiagnostic> =>
	diagnostics.map(diagnostic => ({
		source: 'build',
		file: diagnostic.file,
		line: diagnostic.line,
		column: diagnostic.column,
		severity: diagnostic.severity,
		message: diagnostic.message
	}))

/**
 * 将 lint 结果转换为统一诊断
 * @param lintResult - lint 结果
 */
export const fromLintResult = (lintResult: LintResult): Array<ProjectDiagnostic> =>
	lintResult.errors.map(error => ({
		source: 'lint',
		file: lintResult.filePath,
		line: error.line,
		column: error.column,
		severity: error.severity,
		message: error.message
	}))
