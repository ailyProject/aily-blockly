import { getFfsPreviewMode } from './explorer.runtime'

import type { FfsManagerPreviewSummary } from './types'

type FfsSnapshotFile = {
	name?: string
	path?: string
	type: 'file' | 'dir'
	size: number
	sizeText: string
}

type FfsSnapshot = {
	partition: FfsManagerPreviewSummary['partition']
	type: string
	blockSize: number | null
	fileCount: number
	files: Array<FfsSnapshotFile>
	usage?: {
		capacityBytes?: number
		usedBytes?: number
	} | null
}

/**
 * 将 core 返回的文件系统快照规整为页面预览状态。
 * @param options - 预览状态映射输入
 */
export const mapFfsPreviewSummary = (options: {
	partitionLabel: string
	attemptCount: number
	attemptReasons: Array<string>
	snapshot: FfsSnapshot
}): FfsManagerPreviewSummary => ({
	partition: options.snapshot.partition,
	type: options.snapshot.type,
	partitionLabel: options.partitionLabel,
	blockSize: options.snapshot.blockSize,
	fileCount: options.snapshot.fileCount,
	capacityBytes: options.snapshot.usage?.capacityBytes ?? null,
	usedBytes: options.snapshot.usage?.usedBytes ?? null,
	attemptCount: options.attemptCount,
	attemptReasons: options.attemptReasons,
	files: options.snapshot.files.map(item => ({
		name: item.name || item.path || 'unknown',
		fullPath: item.path || '/',
		type: item.type,
		sizeText: item.sizeText,
		size: item.size,
		previewMode: getFfsPreviewMode(item.path || item.name || '')
	}))
})
