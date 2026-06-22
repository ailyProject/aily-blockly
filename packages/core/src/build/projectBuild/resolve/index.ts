import path from 'node:path'

import { getDeclaredBlocklyLibraryDependencies, getProjectConfig } from '../../../project'
import {
	extractProjectBuildBoardType,
	normalizeProjectBuildBoardOptions,
	normalizeProjectBuildMacros
} from '../helpers'
import { resolveProjectBuildBoardContext } from './board'
import {
	createProjectCompileCommand,
	createProjectPreprocessCommand,
	resolveProjectBuildLibraries,
	resolveProjectBuildPaths
} from './command'

import type { ProjectBuildInput, ProjectBuildPlan } from '../types'

/**
 * 解析项目构建计划，复刻 legacy preprocess/compile 的关键上下文。
 * @param input - 项目构建输入
 */
export const resolveProjectBuildPlan = (input: ProjectBuildInput): ProjectBuildPlan => {
	const { projectPackageJson, boardPackageName, boardDefinition, compilerParam, toolVersions, compilerPath, sdkPath } =
		resolveProjectBuildBoardContext(input)
	const paths = resolveProjectBuildPaths(input, compilerPath, sdkPath)
	const libraries = resolveProjectBuildLibraries(input, projectPackageJson, getDeclaredBlocklyLibraryDependencies)

	const boardType = extractProjectBuildBoardType(compilerParam)
	const boardOptions = normalizeProjectBuildBoardOptions(getProjectConfig(projectPackageJson))
	const macros = normalizeProjectBuildMacros(projectPackageJson.MACROS)
	const builderEntryPath = path.join(paths.ailyBuilderPath, 'index.js')

	return {
		projectPath: input.projectPath,
		boardPackageName,
		boardType,
		coreName: boardDefinition.core,
		boardOptions,
		macros,
		toolVersions,
		libraries,
		paths,
		preprocessCommand: createProjectPreprocessCommand({
			builderEntryPath,
			boardType,
			boardOptions,
			macros,
			toolVersions,
			paths,
			projectPath: input.projectPath
		}),
		compileCommand: createProjectCompileCommand({
			builderEntryPath,
			boardType,
			paths,
			projectPath: input.projectPath
		})
	}
}
