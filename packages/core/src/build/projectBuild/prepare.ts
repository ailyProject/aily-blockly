import { resolveProjectSourceCode } from '../../project'
import { prepareProjectBuildFilesystem } from './filesystem'
import { resolveProjectBuildPlan } from './resolve'

import type { ProjectBuildInput, ProjectBuildPlan } from './types'

/**
 * 为项目构建准备 .temp 文件系统和命令计划，但不直接执行命令。
 * @param input - 项目构建输入
 */
export const prepareProjectBuild = async (input: ProjectBuildInput): Promise<ProjectBuildPlan> => {
	const plan = resolveProjectBuildPlan(input)
	const sourceCode = await resolveProjectSourceCode(input.projectPath, input.code)
	await prepareProjectBuildFilesystem(plan.paths, plan.libraries, sourceCode)
	return plan
}
