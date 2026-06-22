import { getCurrentProjectPath } from '@/runtime/project-session'

import {
	createBlocklyEditorPage,
	refreshBlocklyEditorPage,
	renameBlocklyEditorPage,
	saveBlocklyEditorViewStateDraft,
	saveBlocklyEditorWorkspaceDraft,
	switchBlocklyEditorPage,
	toggleBlocklyEditorPage,
	updateBlocklyEditorSearch,
	updateBlocklyEditorViewStateDraft,
	updateBlocklyEditorWorkspaceDraft
} from './component.runtime'

import type { Core } from '@/utils/core'
import type { MissingBlocklyLibraryInfo } from 'shared'
import type { BlocklyEditorPageSummary, BlocklyEditorSignals } from './types'

/**
 * 创建 Blockly Editor 页面级交互动作。
 * @param input - core 句柄与页面 signals
 */
export const createBlocklyEditorPageActions = (input: { core: Core; signals: BlocklyEditorSignals }) => ({
	async createPage(projectPath: string) {
		if (!projectPath.trim()) return
		await createBlocklyEditorPage(input.core, projectPath, input.signals)
	},
	async switchPage(projectPath: string, pageId: string) {
		if (!projectPath.trim()) return
		const targetPage = input.signals.pages().find(page => page.id === pageId)
		if (!targetPage) return
		await switchBlocklyEditorPage(input.core, projectPath, targetPage, input.signals)
	},
	async togglePageOpen(projectPath: string, pageId: string, opened: boolean) {
		if (!projectPath.trim()) return
		await toggleBlocklyEditorPage(input.core, projectPath, pageId, opened, input.signals)
	},
	beginRenamePage(page: { id: string; title: string }) {
		input.signals.renamingPageId.set(page.id)
		input.signals.renamingPageTitle.set(page.title)
	},
	cancelRenamePage() {
		input.signals.renamingPageId.set('')
		input.signals.renamingPageTitle.set('')
	},
	updateRenamingPageTitle(title: string) {
		input.signals.renamingPageTitle.set(title)
	},
	async confirmRenamePage(projectPath: string, page: BlocklyEditorPageSummary) {
		if (!projectPath.trim()) return
		const title = input.signals.renamingPageTitle().trim()
		if (!title || title === page.title) {
			input.signals.renamingPageId.set('')
			input.signals.renamingPageTitle.set('')
			return
		}
		input.signals.renamingPageId.set('')
		input.signals.renamingPageTitle.set('')
		await renameBlocklyEditorPage(input.core, projectPath, page.id, title, input.signals)
	},
	async updateSearchQuery(event: Event) {
		const nextQuery = (event.target as HTMLInputElement).value
		await updateBlocklyEditorSearch(input.core, nextQuery, input.signals)
	},
	async updateSearchQueryValue(value: string) {
		await updateBlocklyEditorSearch(input.core, value, input.signals)
	},
	updateActiveWorkspaceJson(value: string) {
		updateBlocklyEditorWorkspaceDraft(value, input.signals)
	},
	updateActiveViewStateDraft(field: 'scale' | 'scrollX' | 'scrollY', value: string) {
		updateBlocklyEditorViewStateDraft(field, value, input.signals)
	},
	async saveActiveViewState(projectPath: string) {
		if (!projectPath.trim()) return
		await saveBlocklyEditorViewStateDraft(input.core, projectPath, input.signals)
	},
	resetActiveWorkspaceJson(projectPath: string) {
		void refreshBlocklyEditorPage(input.core, projectPath, input.signals)
	},
	async saveActiveWorkspaceJson(projectPath: string) {
		if (!projectPath.trim()) return
		await saveBlocklyEditorWorkspaceDraft(input.core, projectPath, input.signals)
	},
	async reloadProjectState(projectPath: string) {
		if (!projectPath.trim()) return

		input.signals.projectReloadBusy.set(true)
		input.signals.projectReloadMessage.set(null)
		try {
			await refreshBlocklyEditorPage(input.core, projectPath, input.signals)
			const lifecycle = await input.core.project.getLifecycleStatus.query({ projectPath })
			const sourceSnapshot = await input.core.project.readSource.query({ projectPath }).catch(() => null)
			const projectSession = await import('@/runtime/project-session')
			projectSession.setCurrentProjectPath(getCurrentProjectPath() || projectPath)
			projectSession.setCurrentProjectSourceCode(sourceSnapshot?.sourceCode || '')
			input.signals.projectReloadMessage.set(
				`Reloaded ${lifecycle.editorRoute}${lifecycle.recoveredFromTemp ? ' (temp recovered)' : ''}`
			)
		} catch (error) {
			input.signals.projectReloadMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.projectReloadBusy.set(false)
		}
	},
	async restoreMissingLibrary(projectPath: string, library: MissingBlocklyLibraryInfo) {
		if (!projectPath.trim()) return
		input.signals.missingLibraryActionBusyKey.set(library.name)
		input.signals.missingLibraryActionMessage.set(null)
		try {
			const result = await input.core.project.installBlocklyLibrary.mutate({
				projectPath,
				packageName: library.name,
				version: library.version || undefined,
				localPath: library.localPath?.trim() ? library.localPath : undefined
			})
			input.signals.missingLibraryActionMessage.set(result.message)
			if (result.success) {
				await refreshBlocklyEditorPage(input.core, projectPath, input.signals)
			}
		} catch (error) {
			input.signals.missingLibraryActionMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.missingLibraryActionBusyKey.set(null)
		}
	},
	async restoreAllMissingLibraries(projectPath: string) {
		if (!projectPath.trim()) return
		const libraries = input.signals.missingLibraries()
		if (!libraries.length) return
		input.signals.missingLibraryActionBusyKey.set('__all__')
		input.signals.missingLibraryActionMessage.set(null)
		try {
			for (const library of libraries) {
				const result = await input.core.project.installBlocklyLibrary.mutate({
					projectPath,
					packageName: library.name,
					version: library.version || undefined,
					localPath: library.localPath?.trim() ? library.localPath : undefined
				})
				if (!result.success) {
					input.signals.missingLibraryActionMessage.set(result.message)
					return
				}
			}
			await refreshBlocklyEditorPage(input.core, projectPath, input.signals)
			input.signals.missingLibraryActionMessage.set(`Restored ${libraries.length} missing Blockly libraries.`)
		} catch (error) {
			input.signals.missingLibraryActionMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.missingLibraryActionBusyKey.set(null)
		}
	}
})
