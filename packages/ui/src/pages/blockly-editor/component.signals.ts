import type { BlocklyEditorPageSummary, BlocklyEditorSignals } from './types'

/**
 * 创建 Blockly Editor 页面需要的 signals 聚合对象。
 * @param input - 页面持有的 signal 成员
 */
export const createBlocklyEditorSignals = (input: {
	projectPath: BlocklyEditorSignals['projectPath']
	categories: BlocklyEditorSignals['categories']
	boardValidation: BlocklyEditorSignals['boardValidation']
	libraryValidation: BlocklyEditorSignals['libraryValidation']
	toolbarCount: BlocklyEditorSignals['toolbarCount']
	visibleToolbarCount: BlocklyEditorSignals['visibleToolbarCount']
	language: BlocklyEditorSignals['language']
	abiExists: BlocklyEditorSignals['abiExists']
	abiFilePath: BlocklyEditorSignals['abiFilePath']
	abiParseError: BlocklyEditorSignals['abiParseError']
	abiSchemaVersion: BlocklyEditorSignals['abiSchemaVersion']
	activePageId: BlocklyEditorSignals['activePageId']
	activePageTitle: BlocklyEditorSignals['activePageTitle']
	activeViewState: BlocklyEditorSignals['activeViewState']
	activeViewScaleDraft: BlocklyEditorSignals['activeViewScaleDraft']
	activeViewScrollXDraft: BlocklyEditorSignals['activeViewScrollXDraft']
	activeViewScrollYDraft: BlocklyEditorSignals['activeViewScrollYDraft']
	activeTopLevelBlockCount: BlocklyEditorSignals['activeTopLevelBlockCount']
	activeTopLevelBlockTypes: BlocklyEditorSignals['activeTopLevelBlockTypes']
	activeWorkspaceJson: BlocklyEditorSignals['activeWorkspaceJson']
	activeWorkspaceDirty: BlocklyEditorSignals['activeWorkspaceDirty']
	activeWorkspaceParseError: BlocklyEditorSignals['activeWorkspaceParseError']
	activeWorkspaceSaveBusy: BlocklyEditorSignals['activeWorkspaceSaveBusy']
	activeWorkspaceSaveMessage: BlocklyEditorSignals['activeWorkspaceSaveMessage']
	projectReloadBusy: BlocklyEditorSignals['projectReloadBusy']
	projectReloadMessage: BlocklyEditorSignals['projectReloadMessage']
	missingLibraries: BlocklyEditorSignals['missingLibraries']
	missingLibraryActionBusyKey: BlocklyEditorSignals['missingLibraryActionBusyKey']
	missingLibraryActionMessage: BlocklyEditorSignals['missingLibraryActionMessage']
	renamingPageId: BlocklyEditorSignals['renamingPageId']
	renamingPageTitle: BlocklyEditorSignals['renamingPageTitle']
	openedPageCount: BlocklyEditorSignals['openedPageCount']
	pageCount: BlocklyEditorSignals['pageCount']
	totalBlockCount: BlocklyEditorSignals['totalBlockCount']
	sharedVariableCount: BlocklyEditorSignals['sharedVariableCount']
	sharedProcedureCount: BlocklyEditorSignals['sharedProcedureCount']
	pages: BlocklyEditorSignals['pages']
	searchQuery: BlocklyEditorSignals['searchQuery']
	searchResultNames: BlocklyEditorSignals['searchResultNames']
}): BlocklyEditorSignals => ({
	projectPath: input.projectPath,
	categories: input.categories,
	boardValidation: input.boardValidation,
	libraryValidation: input.libraryValidation,
	toolbarCount: input.toolbarCount,
	visibleToolbarCount: input.visibleToolbarCount,
	language: input.language,
	abiExists: input.abiExists,
	abiFilePath: input.abiFilePath,
	abiParseError: input.abiParseError,
	abiSchemaVersion: input.abiSchemaVersion,
	activePageId: input.activePageId,
	activePageTitle: input.activePageTitle,
	activeViewState: input.activeViewState,
	activeViewScaleDraft: input.activeViewScaleDraft,
	activeViewScrollXDraft: input.activeViewScrollXDraft,
	activeViewScrollYDraft: input.activeViewScrollYDraft,
	activeTopLevelBlockCount: input.activeTopLevelBlockCount,
	activeTopLevelBlockTypes: input.activeTopLevelBlockTypes,
	activeWorkspaceJson: input.activeWorkspaceJson,
	activeWorkspaceDirty: input.activeWorkspaceDirty,
	activeWorkspaceParseError: input.activeWorkspaceParseError,
	activeWorkspaceSaveBusy: input.activeWorkspaceSaveBusy,
	activeWorkspaceSaveMessage: input.activeWorkspaceSaveMessage,
	projectReloadBusy: input.projectReloadBusy,
	projectReloadMessage: input.projectReloadMessage,
	missingLibraries: input.missingLibraries,
	missingLibraryActionBusyKey: input.missingLibraryActionBusyKey,
	missingLibraryActionMessage: input.missingLibraryActionMessage,
	renamingPageId: input.renamingPageId,
	renamingPageTitle: input.renamingPageTitle,
	openedPageCount: input.openedPageCount,
	pageCount: input.pageCount,
	totalBlockCount: input.totalBlockCount,
	sharedVariableCount: input.sharedVariableCount,
	sharedProcedureCount: input.sharedProcedureCount,
	pages: input.pages,
	searchQuery: input.searchQuery,
	searchResultNames: input.searchResultNames
})

/**
 * 连续 signal 中的页面列表项类型。
 */
export type BlocklyEditorPageSignalItem = BlocklyEditorPageSummary

/**
 * 连续 signal 中的分类项类型。
 */
export type BlocklyEditorCategorySignalItem = { name: string; count: number }
