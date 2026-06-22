import { toFfsByteArray } from './component.actions.shared'
import { mapFfsPreviewSummary } from './preview.runtime'

import type { Core } from '@/utils/core'
import type { FfsExplorerEntry } from './explorer.types'
import type { FfsManagerState } from './types'

/**
 * 向当前镜像写入文件。
 * @param options - 文件写入输入
 */
export const writeFfsImageFileFromUpload = async (options: {
	core: Core
	currentState: FfsManagerState
	currentPath: string
	imageBytes: Uint8Array
	file: File
}) => {
	const data = new Uint8Array(await options.file.arrayBuffer())
	const targetPath =
		options.currentPath === '/' ? `/${options.file.name}` : `${options.currentPath}/${options.file.name}`
	const result = await options.core.ffs.writeImageFile.query({
		partition: options.currentState.preview.partition,
		bytes: toFfsByteArray(options.imageBytes),
		path: targetPath,
		data: toFfsByteArray(data)
	})

	return {
		imageBytes: Uint8Array.from(result.image),
		preview: mapFfsPreviewSummary({
			partitionLabel: options.currentState.preview.partition.label,
			attemptCount: options.currentState.preview.attemptCount,
			attemptReasons: ['write-file'],
			snapshot: result.snapshot
		}),
		actionMessage: `Added ${options.file.name}`
	}
}

/**
 * 删除镜像中的文件系统条目。
 * @param options - 删除输入
 */
export const deleteFfsPreviewEntry = async (options: {
	core: Core
	currentState: FfsManagerState
	imageBytes: Uint8Array
	entry: Pick<FfsExplorerEntry, 'name' | 'fullPath' | 'type' | 'size' | 'sizeText'>
}) => {
	const result = await options.core.ffs.deleteImageEntry.query({
		partition: options.currentState.preview.partition,
		bytes: toFfsByteArray(options.imageBytes),
		entry: {
			name: options.entry.name,
			path: options.entry.fullPath,
			type: options.entry.type,
			size: options.entry.size,
			sizeText: options.entry.sizeText
		}
	})

	return {
		imageBytes: Uint8Array.from(result.image),
		preview: mapFfsPreviewSummary({
			partitionLabel: options.currentState.preview.partition.label,
			attemptCount: options.currentState.preview.attemptCount,
			attemptReasons: ['delete-entry'],
			snapshot: result.snapshot
		}),
		actionMessage: `Deleted ${options.entry.fullPath}`
	}
}
