import {
	extractGraphEditorPinmapHints,
	loadGraphEditorLibraryInfo,
	loadGraphEditorLibraryState,
	loadGraphEditorPinmapState
} from '../../runtime'

import type { Core } from '@/utils/core'
import type { GraphEditorSignals } from '../../types'

/**
 * 创建 Graph Editor 保存动作。
 * @param input - 页面信号、外部依赖与刷新入口
 */
export const createGraphEditorPersistenceActions = (input: {
	core: Core
	signals: GraphEditorSignals
	reload: () => Promise<void>
}) => ({
	async saveGraph() {
		if (!input.signals.state().projectPath || input.signals.graphJsonError()) return
		const parsed = input.signals.graphJson().trim()
			? JSON.parse(input.signals.graphJson())
			: { version: '1.0.0', description: '', components: [], connections: [] }
		const result = await input.core.connection.saveGraph.mutate({
			projectPath: input.signals.state().projectPath,
			data: parsed
		})
		input.signals.graphJsonDirty.set(false)
		input.signals.saveMessage.set(
			result.success ? `Saved graph to ${result.filePath}` : 'error' in result ? result.error : 'Failed to save graph'
		)
		const pinmapHints = extractGraphEditorPinmapHints(input.signals.graphJson())
		input.signals.pinmapHints.set(pinmapHints)
		if (!input.signals.pinmapId().trim() && pinmapHints[0]) {
			input.signals.pinmapId.set(pinmapHints[0])
		}
		await input.reload()
	},
	async saveAws() {
		if (!input.signals.state().projectPath) return
		const result = await input.core.connection.saveAws.mutate({
			projectPath: input.signals.state().projectPath,
			content: input.signals.awsContent()
		})
		input.signals.awsDirty.set(false)
		input.signals.saveMessage.set(
			result.success ? `Saved aws to ${result.filePath}` : 'error' in result ? result.error : 'Failed to save aws'
		)
		await input.reload()
	},
	async savePinmap() {
		if (
			!input.signals.state().packagesBasePath ||
			!input.signals.pinmapId().trim() ||
			input.signals.pinmapJsonError()
		) {
			return
		}

		input.signals.pinmapSaveBusy.set(true)
		try {
			const result = await input.core.connection.savePinmap.mutate({
				pinmapId: input.signals.pinmapId().trim(),
				packagesBasePath: input.signals.state().packagesBasePath,
				config: JSON.parse(input.signals.pinmapJson())
			})
			input.signals.saveMessage.set(
				result.success ? `Saved pinmap to ${result.filePath}` : (result.error ?? 'Failed to save pinmap')
			)
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
			input.signals.pinmapSaveBusy.set(false)
		}
	}
})
