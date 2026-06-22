import { resolveProjectBuildPlan } from '../resolve'
import { currentBuildCancelled, runProjectBuildCommand, setCurrentBuildCancelled } from './command'
import { persistProjectBuildRunMetadata } from './persist'
import { prepareProjectBuildRun } from './prepare'
import {
	createProjectBuildCancelledResult,
	createProjectBuildCompletedResult,
	createProjectBuildPreprocessFailureResult
} from './results'

import type { ProjectBuildInput, ProjectBuildResult } from '../types'

/**
 * 执行完整的项目预处理与编译流程。
 * @param input - 项目构建输入
 */
export const runProjectBuild = async (input: ProjectBuildInput): Promise<ProjectBuildResult> => {
	const startedAt = Date.now()
	setCurrentBuildCancelled(false)
	const plan = resolveProjectBuildPlan(input)
	const prepared = await prepareProjectBuildRun({
		buildInput: input,
		plan,
		startedAt
	})
	if (prepared.result) return prepared.result

	const { sourceCode } = prepared

	const preprocessLog = await runProjectBuildCommand(plan.preprocessCommand)
	if (currentBuildCancelled) {
		const result = createProjectBuildCancelledResult({
			startedAt,
			plan,
			logs: [preprocessLog],
			stdout: preprocessLog.stdout,
			stderr: preprocessLog.stderr
		})
		await persistProjectBuildRunMetadata({
			projectPath: input.projectPath,
			sourceCode,
			status: 'cancelled',
			durationMs: result.durationMs
		})
		return result
	}
	if (preprocessLog.exitCode !== 0) {
		const result = createProjectBuildPreprocessFailureResult({
			startedAt,
			plan,
			log: preprocessLog
		})
		await persistProjectBuildRunMetadata({
			projectPath: input.projectPath,
			sourceCode,
			status: 'failed',
			durationMs: result.durationMs
		})
		return result
	}

	const compileLog = await runProjectBuildCommand(plan.compileCommand)
	if (currentBuildCancelled) {
		const result = createProjectBuildCancelledResult({
			startedAt,
			plan,
			logs: [preprocessLog, compileLog],
			stdout: [preprocessLog.stdout, compileLog.stdout].filter(Boolean).join('\n'),
			stderr: [preprocessLog.stderr, compileLog.stderr].filter(Boolean).join('\n')
		})
		await persistProjectBuildRunMetadata({
			projectPath: input.projectPath,
			sourceCode,
			status: 'cancelled',
			durationMs: result.durationMs
		})
		return result
	}

	const result = createProjectBuildCompletedResult({
		startedAt,
		plan,
		preprocessLog,
		compileLog
	})
	await persistProjectBuildRunMetadata({
		projectPath: input.projectPath,
		sourceCode,
		status: result.success ? 'success' : 'failed',
		durationMs: result.durationMs
	})
	return result
}
