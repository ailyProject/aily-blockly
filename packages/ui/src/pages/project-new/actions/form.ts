import { loadProjectBoardCloudState, loadProjectNewRuntimeInfo, previewProjectNewTarget } from '../runtime'

import type { Core } from '@/utils/core'
import type { Desktop, SelectDesktopDirectory } from '@/utils/desktop'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { ProjectNewSignals, ProjectNewTemplateSourceMode } from '../types'

/**
 * 创建 Project New 页面表单动作。
 * @param input - 页面状态与外部依赖
 */
export const createProjectNewFormActions = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	signals: ProjectNewSignals
	boardOptions: Array<{ name: string; displayName: string }>
	projectNewSeparator: string
	loadDesktopHostRuntimeInfo: (desktop: NonNullable<Desktop>) => Promise<DesktopHostRuntimeInfo>
	selectDesktopDirectory: SelectDesktopDirectory
}) => {
	const refreshTemplates = async () => {
		const board = input.boardOptions.find(item => item.displayName === input.signals.selectedBoardName())
		const useMine = input.signals.templateSourceMode() === 'mine'
		const authToken = input.signals.authToken().trim()
		const state = await loadProjectBoardCloudState(input.core, {
			boardName: board?.name,
			mode: input.signals.templateSourceMode(),
			authToken: useMine ? authToken : undefined
		})
		input.signals.templates.set(state.templates)
		input.signals.hasExamples.set(state.hasExamples)
		input.signals.selectedTemplateId.set(null)
		if (useMine && !authToken) {
			input.signals.importMessage.set('Mine templates mode requires a bearer token.')
		}
	}

	const preview = async () => {
		if (!input.signals.rootPath().trim() || !input.signals.projectName().trim()) return
		const previewState = await previewProjectNewTarget({
			core: input.core,
			name: input.signals.projectName(),
			rootPath: input.signals.rootPath(),
			recentProjects: input.signals.recentProjects(),
			runtimeInfo: input.signals.runtimeInfo(),
			separator: input.projectNewSeparator
		})
		input.signals.nameValidationMessage.set(previewState.nameValidationMessage)
		input.signals.resolvedProjectPath.set(previewState.resolvedProjectPath)
		input.signals.pathConflict.set(previewState.pathConflict)
	}

	return {
		refreshTemplates,
		preview,
		updateProjectName(event: Event) {
			input.signals.projectName.set((event.target as HTMLInputElement).value)
			void preview()
		},
		updateProjectNameValue(value: string) {
			input.signals.projectName.set(value)
			void preview()
		},
		updateAuthToken(event: Event) {
			input.signals.importMessage.set(null)
			input.signals.authToken.set((event.target as HTMLInputElement).value)
			void refreshTemplates()
		},
		updateAuthTokenValue(value: string) {
			input.signals.importMessage.set(null)
			input.signals.authToken.set(value)
			void refreshTemplates()
		},
		selectTemplateSourceMode(mode: ProjectNewTemplateSourceMode) {
			if (input.signals.templateSourceMode() === mode) return
			input.signals.templateSourceMode.set(mode)
			input.signals.importMessage.set(null)
			void refreshTemplates()
		},
		chooseBoard(boardName: string) {
			input.signals.selectedBoardName.set(boardName)
			void refreshTemplates()
		},
		async chooseRootPath() {
			if (!input.desktop) return
			try {
				input.signals.importMessage.set(null)
				const nextRootPath = await input.selectDesktopDirectory(input.desktop, input.signals.rootPath())
				if (!nextRootPath) return
				input.signals.rootPath.set(nextRootPath)
				await preview()
			} catch (error) {
				input.signals.importMessage.set(error instanceof Error ? error.message : String(error))
			}
		},
		useRecentProject(project: { name: string; nickname?: string; path: string }) {
			input.signals.projectName.set(project.nickname || project.name)
			input.signals.resolvedProjectPath.set(project.path)
			input.signals.pathConflict.set(true)
		},
		chooseTemplate(templateId: string) {
			input.signals.importMessage.set(null)
			input.signals.selectedTemplateId.set(templateId)
		},
		async suggestAvailableName() {
			if (!input.signals.rootPath().trim()) return
			const nextName = await input.core.project.findAvailableName.query({
				basePath: input.signals.rootPath(),
				name: input.signals.projectName(),
				separator: input.signals.runtimeInfo()?.pathSeparator || input.projectNewSeparator
			})
			if (!nextName) return
			input.signals.projectName.set(nextName)
			await preview()
		},
		async loadRuntimeInfo() {
			input.signals.runtimeInfo.set(await loadProjectNewRuntimeInfo(input.desktop, input.loadDesktopHostRuntimeInfo))
		}
	}
}
