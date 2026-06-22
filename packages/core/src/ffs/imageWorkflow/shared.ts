import { mountFfsFilesystem } from '../runtime'

import type { FfsPartitionInfo } from '../types'

const textDecoder = new TextDecoder()

/**
 * 把运行时文件系统状态映射成对外快照。
 * @param options - 快照输入
 */
export const createFfsImageSnapshot = (options: {
	partition: FfsPartitionInfo
	filesystem: Awaited<ReturnType<typeof mountFfsFilesystem>>
}) => ({
	partition: options.partition,
	type: options.filesystem.type,
	blockSize: options.filesystem.blockSize ?? null,
	fileCount: options.filesystem.files.length,
	files: options.filesystem.files,
	usage: options.filesystem.usage
})

/**
 * 把 Uint8Array 导出成 RPC 友好的 number[]。
 * @param image - 镜像字节
 */
export const exportFfsImageBytes = (image: Uint8Array) => Array.from(image)

/**
 * 把镜像中的文件内容截断成可预览文本。
 * @param path - 文件路径
 * @param content - 文件字节
 * @param maxBytes - 预览字节上限
 */
export const createFfsTextPreview = (path: string, content: Uint8Array, maxBytes = 4096) => {
	const previewBytes = content.slice(0, maxBytes)
	return {
		path,
		size: content.length,
		truncated: previewBytes.length < content.length,
		text: textDecoder.decode(previewBytes)
	}
}
