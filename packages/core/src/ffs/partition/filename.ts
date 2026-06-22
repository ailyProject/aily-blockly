import { sanitizeFfsPartitionFileName } from './shared'

import type { FfsPartitionInfo } from '../types'

/**
 * 根据分区信息生成默认镜像文件名。
 * @param partition - 目标分区
 */
export const buildFfsPartitionFileName = (partition: FfsPartitionInfo) => {
	const label = sanitizeFfsPartitionFileName(partition.label || `partition_${partition.index}`)
	const suffix =
		partition.filesystemType || partition.subtypeName.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'partition'
	return `${label}_${partition.offsetHex}_${suffix}.bin`
}
