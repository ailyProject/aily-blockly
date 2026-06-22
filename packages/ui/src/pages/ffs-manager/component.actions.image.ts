import { toFfsByteArray } from './component.actions.shared'
import { mapFfsPreviewSummary } from './preview.runtime'

import type { Core } from '@/utils/core'
import type { FfsManagerPreviewSummary, FfsManagerState } from './types'

/**
 * 读取镜像并生成页面预览状态。
 * @param options - 镜像加载输入
 */
export const loadFfsImagePreview = async (options: {
	core: Core
	currentState: FfsManagerState
	file: File
}): Promise<{
	imageBytes: Uint8Array
	imageName: string
	preview: FfsManagerPreviewSummary
	actionMessage: string
}> => {
	const imageBytes = new Uint8Array(await options.file.arrayBuffer())
	const snapshot = await options.core.ffs.inspectImage.query({
		partition: options.currentState.preview.partition,
		bytes: toFfsByteArray(imageBytes)
	})

	return {
		imageBytes,
		imageName: options.file.name,
		preview: mapFfsPreviewSummary({
			partitionLabel: options.currentState.preview.partition.label,
			attemptCount: 1,
			attemptReasons: ['uploaded-image'],
			snapshot
		}),
		actionMessage: `Loaded ${options.file.name}`
	}
}

/**
 * 格式化当前镜像中的文件系统。
 * @param options - 格式化输入
 */
export const formatFfsPreviewImage = async (options: {
	core: Core
	currentState: FfsManagerState
	imageBytes: Uint8Array
}) => {
	const result = await options.core.ffs.formatImageFilesystem.query({
		partition: options.currentState.preview.partition,
		bytes: toFfsByteArray(options.imageBytes)
	})

	return {
		imageBytes: Uint8Array.from(result.image),
		preview: mapFfsPreviewSummary({
			partitionLabel: options.currentState.preview.partition.label,
			attemptCount: options.currentState.preview.attemptCount,
			attemptReasons: ['format-image'],
			snapshot: result.snapshot
		}),
		actionMessage: 'Formatted image'
	}
}

/**
 * 导出当前镜像到浏览器下载。
 * @param options - 导出输入
 */
export const exportFfsPreviewImage = (options: { imageBytes: Uint8Array; imageName: string | null }) => {
	const blob = new Blob([options.imageBytes.slice().buffer], { type: 'application/octet-stream' })
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement('a')
	anchor.href = url
	anchor.download = options.imageName || 'ffs-preview.bin'
	anchor.click()
	URL.revokeObjectURL(url)
	return `Exported ${anchor.download}`
}
