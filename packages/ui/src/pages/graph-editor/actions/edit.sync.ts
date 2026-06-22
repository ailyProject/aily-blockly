import { loadGraphEditorLibraryInfo, loadGraphEditorLibraryState, loadGraphEditorPinmapState } from '../runtime'

import type { Core } from '@/utils/core'
import type { GraphEditorSignals } from '../component.types'

/**
 * 创建 Graph Editor 云同步动作。
 * @param input - 页面信号与外部依赖
 */
export const createGraphEditorSyncActions = (input: { core: Core; signals: GraphEditorSignals }) => ({
	async syncCloudPinmaps() {
		if (!input.signals.state().packagesBasePath || !input.signals.cloudAuthToken().trim()) return
		input.signals.syncBusy.set(true)
		try {
			const synced = await input.core.connection.syncCloudPinmaps.mutate({
				packagesBasePath: input.signals.state().packagesBasePath,
				pinmapIdHints: input.signals.pinmapHints(),
				authToken: input.signals.cloudAuthToken().trim()
			})
			input.signals.saveMessage.set(`Synced ${synced} cloud pinmap item(s)`)
			const libraryState = await loadGraphEditorLibraryState(input.core, input.signals.state().packagesBasePath)
			const pinmapState = await loadGraphEditorPinmapState(input.core, input.signals.state().packagesBasePath)
			const libraryInfo = await loadGraphEditorLibraryInfo(
				input.core,
				input.signals.pinmapId(),
				input.signals.state().packagesBasePath
			)
			input.signals.state.update(current => ({ ...current, ...libraryState, ...pinmapState, ...libraryInfo }))
		} catch (error) {
			input.signals.saveMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.syncBusy.set(false)
		}
	}
})
