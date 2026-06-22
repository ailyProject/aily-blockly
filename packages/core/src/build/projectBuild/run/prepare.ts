import { resolveProjectSourceCode } from '../../../project'
import { prepareProjectBuildFilesystem } from '../filesystem'
import { createProjectBuildFailureResult } from './results'

import type { ProjectBuildInput, ProjectBuildPlan, ProjectBuildResult } from '../types'

/**
 * 为完整构建链准备源码和临时文件系统。
 * @param input - 项目构建输入
 * @param plan - 已解析的构建计划
 * @param startedAt - 本次构建开始时间
 */
export const prepareProjectBuildRun = async (input: {
	buildInput: ProjectBuildInput
	plan: ProjectBuildPlan
	startedAt: number
}): Promise<{ sourceCode: string; result?: ProjectBuildResult }> => {
	let sourceCode = ''

	try {
		sourceCode = await resolveProjectSourceCode(input.buildInput.projectPath, input.buildInput.code)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return {
			sourceCode: '',
			result: createProjectBuildFailureResult({
				startedAt: input.startedAt,
				plan: input.plan,
				exitCode: 1,
				stderr: message
			})
		}
	}

	try {
		await prepareProjectBuildFilesystem(input.plan.paths, input.plan.libraries, sourceCode)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return {
			sourceCode,
			result: createProjectBuildFailureResult({
				startedAt: input.startedAt,
				plan: input.plan,
				exitCode: 1,
				stderr: message
			})
		}
	}

	return { sourceCode }
}
