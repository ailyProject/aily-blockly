import type { CompileDiagnostic } from './types'

/**
 * 为旧编译错误快照补充“过期提醒”
 * @param diagnostics - 编译诊断列表
 * @param timestamp - 快照时间戳
 * @param staleMinutes - 视为过期的分钟数
 */
export const withCompileStalenessWarning = (
	diagnostics: Array<CompileDiagnostic>,
	timestamp: number,
	staleMinutes = 5
) => {
	const ageMinutes = (Date.now() - timestamp) / 60000
	if (!diagnostics.some(item => item.source === 'build') || ageMinutes <= staleMinutes) {
		return diagnostics
	}

	return [
		...diagnostics,
		{
			source: 'build',
			severity: 'warning',
			message: `注意: 编译错误数据来自 ${Math.round(ageMinutes)} 分钟前，代码可能已修改。建议重新编译确认。`
		} satisfies CompileDiagnostic
	]
}
