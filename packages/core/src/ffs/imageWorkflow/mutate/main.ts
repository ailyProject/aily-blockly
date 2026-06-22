import {
	createMountedFfsDirectory,
	deleteMountedFfsEntry,
	formatMountedFfsFilesystem,
	refreshMountedFfsFilesystem,
	renameMountedFfsEntry,
	writeMountedFfsFile
} from '../../runtime'
import { runFfsImageMutation } from './shared'

import type { FfsFileEntry, FfsPartitionInfo } from '../../types'

/**
 * 向镜像中写入文件，并返回更新后的镜像与快照。
 * @param options - 文件写入输入
 */
export const writeFfsImageFile = async (options: {
	partition: FfsPartitionInfo
	image: Uint8Array
	path: string
	data: Uint8Array
}) =>
	runFfsImageMutation({
		partition: options.partition,
		image: options.image,
		mutate: async filesystem => {
			await writeMountedFfsFile(filesystem, options.path, options.data)
			await refreshMountedFfsFilesystem(filesystem)
		}
	})

/**
 * 格式化镜像中的文件系统，并返回更新后的镜像与快照。
 * @param options - 文件系统格式化输入
 */
export const formatFfsImageFilesystem = async (options: { partition: FfsPartitionInfo; image: Uint8Array }) =>
	runFfsImageMutation({
		partition: options.partition,
		image: options.image,
		mutate: async filesystem => {
			await formatMountedFfsFilesystem(filesystem)
		}
	})

/**
 * 从镜像中删除文件系统条目，并返回更新后的镜像与快照。
 * @param options - 条目删除输入
 */
export const deleteFfsImageEntry = async (options: {
	partition: FfsPartitionInfo
	image: Uint8Array
	entry: FfsFileEntry
}) =>
	runFfsImageMutation({
		partition: options.partition,
		image: options.image,
		mutate: async filesystem => {
			await deleteMountedFfsEntry(filesystem, options.entry)
			await refreshMountedFfsFilesystem(filesystem)
		}
	})

/**
 * 重命名镜像中的文件系统条目，并返回更新后的镜像与快照。
 * @param options - 条目重命名输入
 */
export const renameFfsImageEntry = async (options: {
	partition: FfsPartitionInfo
	image: Uint8Array
	entry: FfsFileEntry
	nextPath: string
}) =>
	runFfsImageMutation({
		partition: options.partition,
		image: options.image,
		mutate: async filesystem => {
			await renameMountedFfsEntry(filesystem, options.entry, options.nextPath)
			await refreshMountedFfsFilesystem(filesystem)
		}
	})

/**
 * 在镜像中创建目录，并返回更新后的镜像与快照。
 * @param options - 目录创建输入
 */
export const createFfsImageDirectory = async (options: {
	partition: FfsPartitionInfo
	image: Uint8Array
	path: string
}) =>
	runFfsImageMutation({
		partition: options.partition,
		image: options.image,
		mutate: async filesystem => {
			await createMountedFfsDirectory(filesystem, options.path)
		}
	})
