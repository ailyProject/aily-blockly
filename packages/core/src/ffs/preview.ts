import { mountFfsFilesystem } from './runtime/mountFilesystem'

import type { FfsPartitionInfo } from './types'

/**
 * Flash FS 预览分区基线。
 */
export const ffsPreviewPartition: FfsPartitionInfo = {
	index: 0,
	label: 'spiffs',
	type: 0x01,
	subtype: 0x82,
	typeName: 'data',
	subtypeName: 'spiffs',
	offset: 0x290000,
	size: 4096 * 16,
	flags: 0,
	offsetHex: '0x290000',
	sizeHex: '0x10000',
	sizeText: '64 KB',
	filesystemType: 'spiffs'
}

/**
 * 构建用于 FFS 页面预览的空白挂载快照。
 */
export const createFfsPreviewSnapshot = async () => {
	const image = new Uint8Array(ffsPreviewPartition.size).fill(0xff)
	return mountFfsFilesystem({
		partition: ffsPreviewPartition,
		image
	})
}
