import { mountFfsFilesystem, readMountedFfsFile } from '../runtime'
import { createFfsImageSnapshot, createFfsTextPreview } from './shared'

import type { FfsPartitionInfo } from '../types'

/**
 * 检查分区镜像并返回文件系统快照。
 * @param options - 镜像检查输入
 */
export const inspectFfsImage = async (options: { partition: FfsPartitionInfo; image: Uint8Array }) => {
	const filesystem = await mountFfsFilesystem(options)
	return createFfsImageSnapshot({ partition: options.partition, filesystem })
}

/**
 * 读取镜像中文本文件的预览内容。
 * @param options - 文件预览输入
 */
export const readFfsImageFilePreview = async (options: {
	partition: FfsPartitionInfo
	image: Uint8Array
	path: string
	maxBytes?: number
}) => {
	const filesystem = await mountFfsFilesystem(options)
	const content = await readMountedFfsFile(filesystem, options.path)
	return createFfsTextPreview(options.path, content, options.maxBytes)
}
