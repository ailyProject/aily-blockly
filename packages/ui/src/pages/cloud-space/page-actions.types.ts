import type { Core } from '@/utils/core'
import type { Desktop, LoadDesktopHostRuntimeInfo, SelectDesktopDirectory } from '@/utils/desktop'
import type { WritableSignal } from '@angular/core'
import type { Router } from '@angular/router'
import type { CloudProjectScope } from 'shared'
import type {
	CloudSpaceCurrentProjectBinding,
	CloudSpaceEditorDraft,
	CloudSpacePageState,
	CloudSpaceSyncSummary
} from './types'

/**
 * Cloud Space 页面动作访问的 signals 视图。
 */
export interface CloudSpaceActionState {
	scope: WritableSignal<CloudProjectScope>
	query: WritableSignal<string>
	board: WritableSignal<string>
	authToken: WritableSignal<string>
	page: WritableSignal<number>
	pageSize: WritableSignal<number>
	rootPath: WritableSignal<string>
	pendingTargetPath: WritableSignal<string>
	targetPathConflict: WritableSignal<boolean>
	suggestedImportProjectId: WritableSignal<string>
	suggestedImportName: WritableSignal<string>
	importBusyId: WritableSignal<string | null>
	actionBusyKey: WritableSignal<string | null>
	syncBusy: WritableSignal<boolean>
	editorDraft: WritableSignal<CloudSpaceEditorDraft | null>
	editorBusy: WritableSignal<boolean>
	editorImageBusy: WritableSignal<boolean>
	editorError: WritableSignal<string | null>
	editorImageFile: WritableSignal<File | null>
	syncSummary: WritableSignal<CloudSpaceSyncSummary | null>
	syncHistory: WritableSignal<Array<CloudSpaceSyncSummary>>
	currentProjectBinding: WritableSignal<CloudSpaceCurrentProjectBinding | null>
	statusMessage: WritableSignal<string | null>
	runtimeInfo: WritableSignal<Awaited<ReturnType<LoadDesktopHostRuntimeInfo>> | null>
	state: WritableSignal<CloudSpacePageState | null>
	loading: WritableSignal<boolean>
	error: WritableSignal<string | null>
}

/**
 * Cloud Space 页面动作依赖。
 */
export interface CloudSpaceActionContext {
	core: Core
	desktop: NonNullable<Desktop> | null
	router: Router
	loadDesktopHostRuntimeInfo: LoadDesktopHostRuntimeInfo
	selectDesktopDirectory: SelectDesktopDirectory
	getState: () => CloudSpaceActionState
	refresh: () => Promise<void>
	resetImportSuggestion: () => void
}
