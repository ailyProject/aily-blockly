import { formatFfsPreviewImage, loadFfsImagePreview, writeFfsImageFileFromUpload } from './component.actions'

import type { FfsManagerHandlerContext } from './component.handlers.types'

/**
 * 创建 FFS 页面与镜像文件输入相关的处理器。
 * @param context - 页面交互上下文
 */
export const createFfsManagerFileHandlers = (context: FfsManagerHandlerContext) => ({
	handleImageFileChange: async (event: Event) => {
		const input = event.target as HTMLInputElement
		const file = input.files?.[0]
		const current = context.state()
		if (!file || !current) return

		context.previewBusy.set(true)
		try {
			const result = await loadFfsImagePreview({ core: context.core, currentState: current, file })
			context.imageBytes.set(result.imageBytes)
			context.imageName.set(result.imageName)
			context.previewText.set(null)
			context.previewFilePath.set(null)
			context.actionMessage.set(result.actionMessage)
			context.currentPath.set('/')
			context.state.update(state => (state ? { ...state, preview: result.preview } : state))
		} finally {
			context.previewBusy.set(false)
			input.value = ''
		}
	},
	handleFileUploadChange: async (event: Event) => {
		const input = event.target as HTMLInputElement
		const file = input.files?.[0]
		const bytes = context.imageBytes()
		const current = context.state()
		if (!file || !bytes || !current) return

		context.previewBusy.set(true)
		try {
			const result = await writeFfsImageFileFromUpload({
				core: context.core,
				currentState: current,
				currentPath: context.currentPath(),
				imageBytes: bytes,
				file
			})
			context.imageBytes.set(result.imageBytes)
			context.previewText.set(null)
			context.previewFilePath.set(null)
			context.actionMessage.set(result.actionMessage)
			context.state.update(state => (state ? { ...state, preview: result.preview } : state))
		} finally {
			context.previewBusy.set(false)
			input.value = ''
		}
	},
	formatCurrentImage: async () => {
		const bytes = context.imageBytes()
		const current = context.state()
		if (!bytes || !current) return

		context.previewBusy.set(true)
		try {
			const result = await formatFfsPreviewImage({ core: context.core, currentState: current, imageBytes: bytes })
			context.imageBytes.set(result.imageBytes)
			context.previewText.set(null)
			context.previewFilePath.set(null)
			context.actionMessage.set(result.actionMessage)
			context.currentPath.set('/')
			context.state.update(state => (state ? { ...state, preview: result.preview } : state))
		} finally {
			context.previewBusy.set(false)
		}
	}
})
