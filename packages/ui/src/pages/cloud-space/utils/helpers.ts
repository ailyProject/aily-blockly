import { computed } from '@angular/core'

import type { CloudSpaceEditorDraft, CloudSpacePageState } from '../types'
import type { createCloudSpacePageState } from './state'

/**
 * 为 Cloud Space 页面动作构造 signal 视图。
 * @param state - 页面本地状态
 */
export const createCloudSpaceActionState = (state: ReturnType<typeof createCloudSpacePageState>) => ({
	scope: state.scope,
	query: state.query,
	board: state.board,
	authToken: state.authToken,
	page: state.page,
	pageSize: state.pageSize,
	rootPath: state.rootPath,
	pendingTargetPath: state.pendingTargetPath,
	targetPathConflict: state.targetPathConflict,
	suggestedImportProjectId: state.suggestedImportProjectId,
	suggestedImportName: state.suggestedImportName,
	importBusyId: state.importBusyId,
	actionBusyKey: state.actionBusyKey,
	syncBusy: state.syncBusy,
	editorDraft: state.editorDraft,
	editorBusy: state.editorBusy,
	editorImageBusy: state.editorImageBusy,
	editorError: state.editorError,
	editorImageFile: state.editorImageFile,
	syncSummary: state.syncSummary,
	syncHistory: state.syncHistory,
	currentProjectBinding: state.currentProjectBinding,
	statusMessage: state.statusMessage,
	runtimeInfo: state.runtimeInfo,
	state: state.state,
	loading: state.loading,
	error: state.error
})

/**
 * 派生当前正在编辑的云项目。
 * @param state - 项目列表状态
 * @param draft - 当前编辑草稿
 */
export const createEditingCloudSpaceProject = (
	state: { state: () => CloudSpacePageState | null },
	draft: { (): CloudSpaceEditorDraft | null }
) =>
	computed(() => {
		const currentDraft = draft()
		return currentDraft ? (state.state()?.items.find(item => item.id === currentDraft.projectId) ?? null) : null
	})
