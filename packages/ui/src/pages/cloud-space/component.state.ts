import { signal } from '@angular/core'

import type { LoadDesktopHostRuntimeInfo } from '@/utils/desktop'
import type { CloudProjectScope } from 'shared'
import type {
	CloudSpaceCurrentProjectBinding,
	CloudSpaceEditorDraft,
	CloudSpacePageState,
	CloudSpaceSyncSummary
} from './types'

const CLOUD_SPACE_SYNC_HISTORY_STORAGE_KEY = 'aily.cloudSpace.syncHistory'

const readStoredCloudSpaceSyncHistory = () => {
	if (typeof localStorage === 'undefined') return []
	try {
		const raw = localStorage.getItem(CLOUD_SPACE_SYNC_HISTORY_STORAGE_KEY)
		if (!raw) return []

		const parsed = JSON.parse(raw) as Array<CloudSpaceSyncSummary>
		return Array.isArray(parsed)
			? parsed.filter(
					item =>
						typeof item?.projectPath === 'string' &&
						typeof item?.projectId === 'string' &&
						typeof item?.archiveSize === 'number' &&
						typeof item?.cloudIdUpdated === 'boolean' &&
						typeof item?.syncedAt === 'string'
				)
			: []
	} catch {
		return []
	}
}

export const writeStoredCloudSpaceSyncHistory = (history: Array<CloudSpaceSyncSummary>) => {
	if (typeof localStorage === 'undefined') return
	try {
		if (!history.length) {
			localStorage.removeItem(CLOUD_SPACE_SYNC_HISTORY_STORAGE_KEY)
			return
		}
		localStorage.setItem(CLOUD_SPACE_SYNC_HISTORY_STORAGE_KEY, JSON.stringify(history))
	} catch {
		return
	}
}

/**
 * 创建 Cloud Space 页面本地状态。
 */
export const createCloudSpacePageState = () => {
	const initialSyncHistory = readStoredCloudSpaceSyncHistory()

	return {
		state: signal<CloudSpacePageState | null>(null),
		scope: signal<CloudProjectScope>('public'),
		query: signal(''),
		board: signal(''),
		authToken: signal(''),
		page: signal(1),
		pageSize: signal(20),
		rootPath: signal(''),
		pendingTargetPath: signal(''),
		targetPathConflict: signal(false),
		suggestedImportProjectId: signal(''),
		suggestedImportName: signal(''),
		importBusyId: signal<string | null>(null),
		actionBusyKey: signal<string | null>(null),
		syncBusy: signal(false),
		editorDraft: signal<CloudSpaceEditorDraft | null>(null),
		editorBusy: signal(false),
		editorImageBusy: signal(false),
		editorError: signal<string | null>(null),
		editorImageFile: signal<File | null>(null),
		syncSummary: signal<CloudSpaceSyncSummary | null>(initialSyncHistory[0] ?? null),
		syncHistory: signal<Array<CloudSpaceSyncSummary>>(initialSyncHistory),
		currentProjectBinding: signal<CloudSpaceCurrentProjectBinding | null>(null),
		statusMessage: signal<string | null>(null),
		runtimeInfo: signal<Awaited<ReturnType<LoadDesktopHostRuntimeInfo>> | null>(null),
		loading: signal(true),
		error: signal<string | null>(null)
	}
}
