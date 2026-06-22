import { computed, signal } from '@angular/core'

import { createBlocklyEditorSignals } from './signals'

import type { MissingBlocklyLibraryInfo } from 'shared'
import type { BlocklyEditorSignals } from '../types'

/**
 * 创建 Blockly Editor 页面本地状态。
 */
export const createBlocklyEditorPageState = () => {
	const projectPath = signal('')
	const categories = signal<Array<{ name: string; count: number }>>([])
	const boardValidation = signal('pending')
	const libraryValidation = signal('pending')
	const toolbarCount = signal(0)
	const visibleToolbarCount = signal(0)
	const language = signal('unknown')
	const abiExists = signal(false)
	const abiFilePath = signal('')
	const abiParseError = signal<string | undefined>(undefined)
	const abiSchemaVersion = signal<number | undefined>(undefined)
	const activePageId = signal('')
	const activePageTitle = signal('')
	const activeViewState = signal<{ scale: number; scrollX: number; scrollY: number } | null>(null)
	const activeViewScaleDraft = signal('1')
	const activeViewScrollXDraft = signal('0')
	const activeViewScrollYDraft = signal('0')
	const activeTopLevelBlockCount = signal(0)
	const activeTopLevelBlockTypes = signal<Array<string>>([])
	const activeWorkspaceJson = signal('{}')
	const activeWorkspaceDirty = signal(false)
	const activeWorkspaceParseError = signal<string | null>(null)
	const activeWorkspaceSaveBusy = signal(false)
	const activeWorkspaceSaveMessage = signal<string | null>(null)
	const projectReloadBusy = signal(false)
	const projectReloadMessage = signal<string | null>(null)
	const missingLibraries = signal<Array<MissingBlocklyLibraryInfo>>([])
	const missingLibraryActionBusyKey = signal<string | null>(null)
	const missingLibraryActionMessage = signal<string | null>(null)
	const hasBlockingMissingLibraries = computed(() => missingLibraries().length > 0)
	const renamingPageId = signal('')
	const renamingPageTitle = signal('')
	const openedPageCount = signal(0)
	const pageCount = signal(0)
	const totalBlockCount = signal(0)
	const sharedVariableCount = signal(0)
	const sharedProcedureCount = signal(0)
	const pages = signal<Array<{ id: string; title: string; blockCount: number; opened: boolean; active: boolean }>>([])
	const searchQuery = signal('esp32')
	const searchResultNames = signal<Array<string>>([])
	const openedPages = computed(() => pages().filter(page => page.opened))
	const closedPages = computed(() => pages().filter(page => !page.opened))
	const canSaveActiveWorkspace = computed(
		() => activeWorkspaceDirty() && !activeWorkspaceSaveBusy() && !activeWorkspaceParseError()
	)
	const canSaveActiveViewState = computed(
		() =>
			projectPath().trim().length > 0 &&
			!Number.isNaN(Number(activeViewScaleDraft())) &&
			!Number.isNaN(Number(activeViewScrollXDraft())) &&
			!Number.isNaN(Number(activeViewScrollYDraft()))
	)
	const signals: BlocklyEditorSignals = createBlocklyEditorSignals({
		projectPath,
		categories,
		boardValidation,
		libraryValidation,
		toolbarCount,
		visibleToolbarCount,
		language,
		abiExists,
		abiFilePath,
		abiParseError,
		abiSchemaVersion,
		activePageId,
		activePageTitle,
		activeViewState,
		activeViewScaleDraft,
		activeViewScrollXDraft,
		activeViewScrollYDraft,
		activeTopLevelBlockCount,
		activeTopLevelBlockTypes,
		activeWorkspaceJson,
		activeWorkspaceDirty,
		activeWorkspaceParseError,
		activeWorkspaceSaveBusy,
		activeWorkspaceSaveMessage,
		projectReloadBusy,
		projectReloadMessage,
		missingLibraries,
		missingLibraryActionBusyKey,
		missingLibraryActionMessage,
		renamingPageId,
		renamingPageTitle,
		openedPageCount,
		pageCount,
		totalBlockCount,
		sharedVariableCount,
		sharedProcedureCount,
		pages,
		searchQuery,
		searchResultNames
	})

	return {
		projectPath,
		categories,
		boardValidation,
		libraryValidation,
		toolbarCount,
		visibleToolbarCount,
		language,
		abiExists,
		abiFilePath,
		abiParseError,
		abiSchemaVersion,
		activePageId,
		activePageTitle,
		activeViewState,
		activeViewScaleDraft,
		activeViewScrollXDraft,
		activeViewScrollYDraft,
		activeTopLevelBlockCount,
		activeTopLevelBlockTypes,
		activeWorkspaceJson,
		activeWorkspaceDirty,
		activeWorkspaceParseError,
		activeWorkspaceSaveBusy,
		activeWorkspaceSaveMessage,
		projectReloadBusy,
		projectReloadMessage,
		missingLibraries,
		missingLibraryActionBusyKey,
		missingLibraryActionMessage,
		hasBlockingMissingLibraries,
		renamingPageId,
		renamingPageTitle,
		openedPageCount,
		pageCount,
		totalBlockCount,
		sharedVariableCount,
		sharedProcedureCount,
		pages,
		searchQuery,
		searchResultNames,
		openedPages,
		closedPages,
		canSaveActiveWorkspace,
		canSaveActiveViewState,
		signals
	}
}
