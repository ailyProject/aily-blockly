import { mapFfsPreviewSummary } from './preview'

import type { Core } from '@/utils/core'
import type { FfsExplorerEntry, FfsManagerPreviewSummary, FfsManagerState } from '../types'

const toByteArray = (bytes: Uint8Array) => Array.from(bytes)

/**
 * 重命名镜像中的文件系统条目。
 * @param options - 条目重命名输入
 */
export const renameFfsPreviewEntry = async (options: {
	core: Core
	currentState: FfsManagerState
	imageBytes: Uint8Array
	entry: Pick<FfsExplorerEntry, 'name' | 'fullPath' | 'type' | 'size' | 'sizeText'>
	nextPath: string
}): Promise<{
	imageBytes: Uint8Array
	preview: FfsManagerPreviewSummary
	actionMessage: string
}> => {
	const result = await options.core.ffs.renameImageEntry.query({
		partition: options.currentState.preview.partition,
		bytes: toByteArray(options.imageBytes),
		entry: {
			name: options.entry.name,
			path: options.entry.fullPath,
			type: options.entry.type,
			size: options.entry.size,
			sizeText: options.entry.sizeText
		},
		nextPath: options.nextPath
	})

	return {
		imageBytes: Uint8Array.from(result.image),
		preview: mapFfsPreviewSummary({
			partitionLabel: options.currentState.preview.partition.label,
			attemptCount: options.currentState.preview.attemptCount,
			attemptReasons: ['rename-entry'],
			snapshot: result.snapshot
		}),
		actionMessage: `Renamed ${options.entry.fullPath}`
	}
}

/**
 * 在镜像中创建目录。
 * @param options - 目录创建输入
 */
export const createFfsPreviewDirectory = async (options: {
	core: Core
	currentState: FfsManagerState
	imageBytes: Uint8Array
	path: string
}): Promise<{
	imageBytes: Uint8Array
	preview: FfsManagerPreviewSummary
	actionMessage: string
}> => {
	const result = await options.core.ffs.createImageDirectory.query({
		partition: options.currentState.preview.partition,
		bytes: toByteArray(options.imageBytes),
		path: options.path
	})

	return {
		imageBytes: Uint8Array.from(result.image),
		preview: mapFfsPreviewSummary({
			partitionLabel: options.currentState.preview.partition.label,
			attemptCount: options.currentState.preview.attemptCount,
			attemptReasons: ['create-directory'],
			snapshot: result.snapshot
		}),
		actionMessage: `Created directory ${options.path}`
	}
}
