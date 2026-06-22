import type { ProjectNewSignals } from './component.types'

/**
 * 聚合 Project New 页面使用的 signals。
 * @param input - 页面持有的各个 signal
 */
export const createProjectNewSignals = (input: ProjectNewSignals): ProjectNewSignals => ({
	loading: input.loading,
	error: input.error,
	authToken: input.authToken,
	projectName: input.projectName,
	selectedBoardName: input.selectedBoardName,
	rootPath: input.rootPath,
	resolvedProjectPath: input.resolvedProjectPath,
	recentProjects: input.recentProjects,
	templates: input.templates,
	hasExamples: input.hasExamples,
	selectedTemplateId: input.selectedTemplateId,
	pathConflict: input.pathConflict,
	nameValidationMessage: input.nameValidationMessage,
	importBusy: input.importBusy,
	importMessage: input.importMessage,
	templateSourceMode: input.templateSourceMode,
	runtimeInfo: input.runtimeInfo
})
