import { deleteFfsPreviewEntry, exportFfsPreviewImage, readFfsTextPreview } from '../actions'

import type { FfsExplorerEntry, FfsManagerHandlerContext } from '../../types'

/**
 * 创建 FFS 页面预览与导出相关处理器。
 * @param context - 页面交互上下文
 */
export const createFfsManagerPreviewHandlers = (context: FfsManagerHandlerContext) => ({
	previewEntry: async (entry: Pick<FfsExplorerEntry, 'type' | 'fullPath' | 'previewMode'>) => {
		if (entry.type !== 'file' || entry.previewMode !== 'text') return

		const bytes = context.imageBytes()
		const current = context.state()
		if (!bytes || !current) return

		context.previewBusy.set(true)
		try {
			const preview = await readFfsTextPreview({ core: context.core, currentState: current, imageBytes: bytes, entry })
			context.previewFilePath.set(preview.path)
			context.previewText.set(preview.text)
			context.actionMessage.set(`Previewing ${preview.path}`)
		} finally {
			context.previewBusy.set(false)
		}
	},
	deleteEntry: async (entry: Pick<FfsExplorerEntry, 'name' | 'fullPath' | 'type' | 'size' | 'sizeText'>) => {
		const bytes = context.imageBytes()
		const current = context.state()
		if (!bytes || !current) return

		context.previewBusy.set(true)
		try {
			const result = await deleteFfsPreviewEntry({
				core: context.core,
				currentState: current,
				imageBytes: bytes,
				entry
			})
			context.imageBytes.set(result.imageBytes)
			context.previewText.set(null)
			context.previewFilePath.set(null)
			context.actionMessage.set(result.actionMessage)
			context.state.update(state => (state ? { ...state, preview: result.preview } : state))
		} finally {
			context.previewBusy.set(false)
		}
	},
	downloadImage: () => {
		const bytes = context.imageBytes()
		if (!bytes) return

		context.actionMessage.set(
			exportFfsPreviewImage({
				imageBytes: bytes,
				imageName: context.imageName()
			})
		)
	}
})
