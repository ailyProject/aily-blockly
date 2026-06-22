import { extractGraphEditorPinmapHints, loadGraphEditorPinmapTemplate } from '../runtime'

import type { Core } from '@/utils/core'
import type { GraphEditorSignals } from '../component.types'

/**
 * 创建 Graph Editor 草稿编辑动作。
 * @param input - 页面信号、外部依赖与刷新入口
 */
export const createGraphEditorDraftActions = (input: {
	core: Core
	signals: GraphEditorSignals
	refreshLibraryInfo: () => Promise<void>
}) => ({
	updateGraphJson(value: string) {
		input.signals.graphJson.set(value)
		const pinmapHints = extractGraphEditorPinmapHints(value)
		input.signals.pinmapHints.set(pinmapHints)
		if (!input.signals.pinmapId().trim() && pinmapHints[0]) {
			input.signals.pinmapId.set(pinmapHints[0])
		}
		input.signals.graphJsonDirty.set(true)
		input.signals.saveMessage.set(null)
		try {
			if (value.trim()) JSON.parse(value)
			input.signals.graphJsonError.set(null)
		} catch (error) {
			input.signals.graphJsonError.set(error instanceof Error ? error.message : String(error))
		}
	},
	updateAwsContent(value: string) {
		input.signals.awsContent.set(value)
		input.signals.awsDirty.set(true)
		input.signals.saveMessage.set(null)
	},
	updateCloudAuthToken(value: string) {
		input.signals.cloudAuthToken.set(value)
		input.signals.saveMessage.set(null)
	},
	updatePinmapId(value: string) {
		input.signals.pinmapId.set(value)
		input.signals.saveMessage.set(null)
		void input.refreshLibraryInfo()
	},
	usePinmapId(pinmapId: string) {
		input.signals.pinmapId.set(pinmapId)
		input.signals.saveMessage.set(null)
		void input.refreshLibraryInfo()
	},
	async usePinmapVariant(variant: { fullId: string; protocol?: string }) {
		input.signals.pinmapId.set(variant.fullId)
		input.signals.saveMessage.set(null)
		await input.refreshLibraryInfo()
		if (variant.protocol) {
			await this.updatePinmapTemplateProtocol(variant.protocol)
		}
	},
	updatePinmapJson(value: string) {
		input.signals.pinmapJson.set(value)
		input.signals.saveMessage.set(null)
		try {
			if (value.trim()) JSON.parse(value)
			input.signals.pinmapJsonError.set(null)
		} catch (error) {
			input.signals.pinmapJsonError.set(error instanceof Error ? error.message : String(error))
		}
	},
	async updatePinmapTemplateProtocol(value: string) {
		input.signals.pinmapTemplateProtocol.set(value)
		const templateState = await loadGraphEditorPinmapTemplate(input.core, value)
		input.signals.pinmapTemplateJson.set(templateState.pinmapTemplateJson)
		input.signals.pinmapJson.set(templateState.pinmapTemplateJson)
		input.signals.pinmapJsonError.set(null)
		input.signals.state.update(current => ({ ...current, ...templateState }))
	}
})
