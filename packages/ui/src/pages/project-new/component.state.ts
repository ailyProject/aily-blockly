import { computed, signal } from '@angular/core'

import { createProjectNewSignals } from './component.signals'
import { projectNewBoardOptions, projectNewInitialName } from './data'

import type { DesktopHostRuntimeInfo } from '@desktop'
import type { ProjectNewSignals } from './component.types'
import type { ProjectNewCloudTemplate, ProjectNewRecentItem, ProjectNewTemplateSourceMode } from './types'

/**
 * 创建 Project New 页面本地状态。
 */
export const createProjectNewPageState = () => {
	const loading = signal(true)
	const error = signal<string | null>(null)
	const authToken = signal('')
	const projectName = signal(projectNewInitialName)
	const selectedBoardName = signal(projectNewBoardOptions[0]?.displayName ?? 'XIAO ESP32S3')
	const rootPath = signal('')
	const resolvedProjectPath = signal('')
	const recentProjects = signal<Array<ProjectNewRecentItem>>([])
	const templates = signal<Array<ProjectNewCloudTemplate>>([])
	const hasExamples = signal(false)
	const selectedTemplateId = signal<string | null>(null)
	const pathConflict = signal<boolean | null>(null)
	const nameValidationMessage = signal<string | null>(null)
	const importBusy = signal(false)
	const importMessage = signal<string | null>(null)
	const templateSourceMode = signal<ProjectNewTemplateSourceMode>('public')
	const runtimeInfo = signal<DesktopHostRuntimeInfo | null>(null)
	const selectedTemplate = computed(() => templates().find(item => item.id === selectedTemplateId()) ?? null)
	const signals: ProjectNewSignals = createProjectNewSignals({
		loading,
		error,
		authToken,
		projectName,
		selectedBoardName,
		rootPath,
		resolvedProjectPath,
		recentProjects,
		templates,
		hasExamples,
		selectedTemplateId,
		pathConflict,
		nameValidationMessage,
		importBusy,
		importMessage,
		templateSourceMode,
		runtimeInfo
	})

	return {
		loading,
		error,
		authToken,
		projectName,
		selectedBoardName,
		rootPath,
		resolvedProjectPath,
		recentProjects,
		templates,
		hasExamples,
		selectedTemplateId,
		pathConflict,
		nameValidationMessage,
		importBusy,
		importMessage,
		templateSourceMode,
		runtimeInfo,
		selectedTemplate,
		signals,
		boardOptions: projectNewBoardOptions
	}
}
