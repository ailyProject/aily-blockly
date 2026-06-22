import { createProjectNewBlank, importProjectNewTemplate, openProjectNewProject } from '../runtime'

import type { Core } from '@/utils/core'
import type { Router } from '@angular/router'
import type { ProjectNewSignals } from '../component.types'
import type { ProjectNewCloudTemplate } from '../types'

/**
 * 创建 Project New 页面项目动作。
 * @param input - 页面状态与外部依赖
 */
export const createProjectNewProjectActions = (input: {
	core: Core
	router: Router
	signals: ProjectNewSignals
	boardOptions: Array<{ name: string; displayName: string }>
	selectedTemplate: () => ProjectNewCloudTemplate | null
}) => ({
	async createBlankProject() {
		const targetPath = input.signals.resolvedProjectPath()
		const board = input.boardOptions.find(item => item.displayName === input.signals.selectedBoardName())
		const runtimeInfo = input.signals.runtimeInfo()
		if (!targetPath || !board || !runtimeInfo?.appDataPath || input.signals.nameValidationMessage()) return

		input.signals.importBusy.set(true)
		input.signals.importMessage.set(null)
		try {
			const result = await createProjectNewBlank({
				core: input.core,
				runtimeInfo,
				projectPath: targetPath,
				name: input.signals.projectName().trim(),
				boardName: board.name,
				boardDisplayName: board.displayName
			})
			input.signals.recentProjects.set(result.recentProjects)
			input.signals.pathConflict.set(true)
			input.signals.importMessage.set(result.importMessage)
			await openProjectNewProject(input.core, input.router, result.projectPath)
		} catch (error) {
			input.signals.importMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.importBusy.set(false)
		}
	},
	async importSelectedTemplate() {
		const template = input.selectedTemplate()
		const targetPath = input.signals.resolvedProjectPath()
		if (!template || !targetPath || input.signals.nameValidationMessage()) return

		input.signals.importBusy.set(true)
		input.signals.importMessage.set(null)
		try {
			const result = await importProjectNewTemplate({
				core: input.core,
				runtimeInfo: input.signals.runtimeInfo(),
				template,
				projectPath: targetPath,
				projectName: input.signals.projectName().trim()
			})
			input.signals.recentProjects.set(result.recentProjects)
			input.signals.pathConflict.set(true)
			input.signals.importMessage.set(result.importMessage)
			await openProjectNewProject(input.core, input.router, result.projectPath)
		} catch (error) {
			input.signals.importMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.importBusy.set(false)
		}
	}
})
