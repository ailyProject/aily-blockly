import { loadBlocklyEditorState } from '../../runtime'
import { parseBlocklyWorkspaceDraft } from '../workspace-editor'

import type { Core } from '@/utils/core'
import type { BlocklyEditorSignals } from '../../types'

interface ApplyBlocklyEditorStateOptions {
	/** 是否保留当前未保存的 workspace JSON 草稿。 */
	preserveActiveWorkspaceDraft?: boolean
}

/**
 * 在保留本地草稿时，重新计算工作区预览统计。
 * @param signals - 页面信号集合
 */
const refreshPreservedWorkspacePreview = (signals: BlocklyEditorSignals) => {
	const draft = parseBlocklyWorkspaceDraft(signals.activeWorkspaceJson())
	signals.activeTopLevelBlockCount.set(draft.topLevelBlockCount)
	signals.activeTopLevelBlockTypes.set(draft.topLevelBlockTypes)
	signals.activeWorkspaceParseError.set(draft.error ?? null)
}

/**
 * 把 blockly editor 状态快照写回页面 signals。
 * @param signals - 页面信号集合
 * @param state - 已加载的页面状态
 * @param options - 写回选项
 */
export const applyBlocklyEditorState = (
	signals: BlocklyEditorSignals,
	state: Awaited<ReturnType<typeof loadBlocklyEditorState>>,
	options: ApplyBlocklyEditorStateOptions = {}
) => {
	signals.categories.set(state.categories)
	signals.boardValidation.set(state.boardValidation)
	signals.libraryValidation.set(state.libraryValidation)
	signals.toolbarCount.set(state.toolbarCount)
	signals.visibleToolbarCount.set(state.visibleToolbarCount)
	signals.language.set(state.language)
	signals.abiExists.set(state.abiExists)
	signals.abiFilePath.set(state.abiFilePath)
	signals.abiParseError.set(state.abiParseError)
	signals.abiSchemaVersion.set(state.abiSchemaVersion)
	signals.activePageId.set(state.activePageId ?? '')
	signals.activePageTitle.set(state.activePageTitle ?? '')
	signals.activeViewState.set(state.activeViewState ?? null)
	signals.activeViewScaleDraft.set(String(state.activeViewState?.scale ?? 1))
	signals.activeViewScrollXDraft.set(String(state.activeViewState?.scrollX ?? 0))
	signals.activeViewScrollYDraft.set(String(state.activeViewState?.scrollY ?? 0))
	signals.missingLibraries.set(state.missingLibraries)
	signals.missingLibraryActionMessage.set(null)
	signals.openedPageCount.set(state.openedPageCount)
	signals.pageCount.set(state.pageCount)
	signals.totalBlockCount.set(state.totalBlockCount)
	signals.sharedVariableCount.set(state.sharedVariableCount)
	signals.sharedProcedureCount.set(state.sharedProcedureCount)
	signals.pages.set(state.pages)
	signals.searchResultNames.set(state.searchResultNames)

	if (options.preserveActiveWorkspaceDraft) {
		refreshPreservedWorkspacePreview(signals)
		return
	}

	signals.activeTopLevelBlockCount.set(state.activeWorkspace.topLevelBlockCount)
	signals.activeTopLevelBlockTypes.set(state.activeWorkspace.topLevelBlockTypes)
	signals.activeWorkspaceJson.set(state.activeWorkspace.workspaceJson)
	signals.activeWorkspaceDirty.set(false)
	signals.activeWorkspaceParseError.set(null)
	signals.activeWorkspaceSaveMessage.set(null)
}

/**
 * 初始化 Blockly editor 页面。
 * @param core - core 句柄
 * @param projectPath - 当前项目路径
 * @param signals - 页面信号集合
 */
export const initializeBlocklyEditorPage = async (core: Core, projectPath: string, signals: BlocklyEditorSignals) => {
	const state = await loadBlocklyEditorState(core, projectPath)
	const sourceSnapshot = projectPath
		? await core.project.readSource.query({
				projectPath
			})
		: null
	const projectSession = await import('@/runtime/project-session')
	projectSession.setCurrentProjectPath(projectPath)
	projectSession.setCurrentProjectEditorRoute('blockly-editor')
	projectSession.setCurrentProjectSourceCode(sourceSnapshot?.sourceCode || '')
	signals.projectPath.set(projectPath)
	applyBlocklyEditorState(signals, state)
}

/**
 * 刷新 Blockly editor 当前项目的 ABI / workspace 状态。
 * @param core - core 句柄
 * @param projectPath - 当前项目路径
 * @param signals - 页面信号集合
 * @param options - 刷新选项
 */
export const refreshBlocklyEditorPage = async (
	core: Core,
	projectPath: string,
	signals: BlocklyEditorSignals,
	options: ApplyBlocklyEditorStateOptions = {}
) => {
	const state = await loadBlocklyEditorState(core, projectPath)
	applyBlocklyEditorState(signals, state, options)
}
