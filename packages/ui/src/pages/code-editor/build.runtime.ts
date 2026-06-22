import { config } from '@/workspace/config'

import { codeEditorSourceSeed } from './data'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { CodeEditorBuildPlanSummary, CodeEditorBuildResultView, CodeEditorState } from './types'

/**
 * 读取指定项目的源码快照。
 * @param core - core 服务句柄
 * @param projectPath - 项目路径
 */
export const loadCodeEditorProjectSource = async (core: Core, projectPath: string) => {
	if (!projectPath.trim()) return null
	return core.project.readSource.query({
		projectPath
	})
}

/**
 * 加载代码编辑器页的最近项目与默认源码。
 */
export const loadCodeEditorState = async (core: Core): Promise<CodeEditorState> => {
	const [recentProjects, configSummary] = await Promise.all([
		core.project.getRecentProjects.query({ config }),
		core.config.get.query({ config })
	])
	const defaultProjectPath = recentProjects[0]?.path ?? ''
	const sourceSnapshot = await loadCodeEditorProjectSource(core, defaultProjectPath)

	return {
		recentProjects,
		defaultProjectPath,
		sourceCode: sourceSnapshot?.sourceCode || codeEditorSourceSeed,
		sourceFilePath: sourceSnapshot?.filePath,
		sourceKind: sourceSnapshot?.sourceKind,
		defaultSerialPort: configSummary.serialMonitor.port || ''
	}
}

/**
 * 读取当前项目的构建计划摘要。
 */
export const loadCodeEditorBuildPlan = async (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	code: string
): Promise<CodeEditorBuildPlanSummary> => {
	const plan = await core.build.planProjectBuild.query({
		projectPath,
		appDataPath: runtimeInfo.appDataPath,
		childPath: runtimeInfo.childPath ?? '',
		code
	})

	return {
		boardPackageName: plan.boardPackageName,
		boardType: plan.boardType,
		libraryCount: plan.libraries.length,
		toolVersionCount: plan.toolVersions.length,
		macroCount: plan.macros.length
	}
}

/**
 * 执行当前项目构建。
 */
export const runCodeEditorBuild = async (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	code: string
): Promise<CodeEditorBuildResultView> => {
	const result = await core.build.runProjectBuild.mutate({
		projectPath,
		appDataPath: runtimeInfo.appDataPath,
		childPath: runtimeInfo.childPath ?? '',
		code
	})

	return {
		success: result.success,
		durationMs: result.durationMs,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		errorText: result.errorText,
		logs: result.logs
	}
}
