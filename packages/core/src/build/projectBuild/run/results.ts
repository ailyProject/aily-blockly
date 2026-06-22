import { extractCompileErrors } from '../../compileErrors'

import type { ProjectBuildLog, ProjectBuildPlan, ProjectBuildResult } from '../types'

/**
 * 构造构建失败结果。
 * @param input - 失败上下文
 */
export const createProjectBuildFailureResult = (input: {
	startedAt: number
	plan: ProjectBuildPlan
	exitCode: number
	stderr: string
	stdout?: string
	logs?: Array<ProjectBuildLog>
	errorText?: string
}): ProjectBuildResult => ({
	success: false,
	durationMs: Date.now() - input.startedAt,
	exitCode: input.exitCode,
	plan: input.plan,
	logs: input.logs ?? [],
	stdout: input.stdout ?? '',
	stderr: input.stderr,
	errorText: input.errorText ?? input.stderr
})

/**
 * 构造构建取消结果。
 * @param input - 取消上下文
 */
export const createProjectBuildCancelledResult = (input: {
	startedAt: number
	plan: ProjectBuildPlan
	logs: Array<ProjectBuildLog>
	stdout: string
	stderr: string
}): ProjectBuildResult => ({
	success: false,
	durationMs: Date.now() - input.startedAt,
	exitCode: 130,
	plan: input.plan,
	logs: input.logs,
	stdout: input.stdout,
	stderr: input.stderr,
	errorText: '构建已取消'
})

/**
 * 构造 preprocess 失败结果。
 * @param input - preprocess 日志上下文
 */
export const createProjectBuildPreprocessFailureResult = (input: {
	startedAt: number
	plan: ProjectBuildPlan
	log: ProjectBuildLog & { exitCode: number }
}) => {
	const stderr = input.log.stderr || input.log.stdout
	return createProjectBuildFailureResult({
		startedAt: input.startedAt,
		plan: input.plan,
		exitCode: input.log.exitCode,
		logs: [input.log],
		stdout: input.log.stdout,
		stderr,
		errorText: extractCompileErrors(stderr).text || stderr.trim() || '预处理失败'
	})
}

/**
 * 构造构建完成结果。
 * @param input - 构建完成上下文
 */
export const createProjectBuildCompletedResult = (input: {
	startedAt: number
	plan: ProjectBuildPlan
	preprocessLog: ProjectBuildLog
	compileLog: ProjectBuildLog & { exitCode: number }
}) => {
	const stdout = [input.preprocessLog.stdout, input.compileLog.stdout].filter(Boolean).join('\n')
	const stderr = [input.preprocessLog.stderr, input.compileLog.stderr].filter(Boolean).join('\n')
	const errorText = extractCompileErrors(stderr).text

	return {
		success: input.compileLog.exitCode === 0,
		durationMs: Date.now() - input.startedAt,
		exitCode: input.compileLog.exitCode,
		plan: input.plan,
		logs: [input.preprocessLog, input.compileLog],
		stdout,
		stderr,
		errorText: errorText || stderr.trim()
	} satisfies ProjectBuildResult
}
