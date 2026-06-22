import { isBlankFfsImage } from './image'

import type { FfsFilesystemType, FfsMountAttempt, FfsMountPlan } from './types'

export const FFS_DEFAULT_BLOCK_SIZE = 4096
export const FFS_SPIFFS_PAGE_SIZE = 256
export const FFS_BLOCK_SIZE_CANDIDATES = [4096, 2048, 1024, 512]
export const FFS_FAT_MOUNT_PATH = '/fatfs'

const buildFfsMountAttempts = (
	type: FfsFilesystemType,
	imageSize: number,
	blankImage: boolean
): Array<FfsMountAttempt> => {
	const buildAttempt = (blockSize: number, reason: string): FfsMountAttempt => ({
		blockSize,
		blockCount: Math.max(1, Math.floor(imageSize / blockSize)),
		pageSize: type === 'spiffs' ? FFS_SPIFFS_PAGE_SIZE : undefined,
		reason
	})

	if (blankImage) {
		return [buildAttempt(FFS_DEFAULT_BLOCK_SIZE, 'blank-image-init')]
	}

	if (type === 'fatfs') {
		return [buildAttempt(FFS_DEFAULT_BLOCK_SIZE, 'fatfs-default')]
	}

	return FFS_BLOCK_SIZE_CANDIDATES.filter(blockSize => imageSize % blockSize === 0).map((blockSize, index) =>
		buildAttempt(blockSize, index === 0 ? 'default' : 'fallback')
	)
}

/**
 * 获取底层文件系统客户端的根路径。
 * @param type - 文件系统类型
 */
export const getFfsClientRootPath = (type: FfsFilesystemType) => (type === 'fatfs' ? FFS_FAT_MOUNT_PATH : '/')

/**
 * 获取遍历文件系统树时的起始根路径列表。
 * @param type - 文件系统类型
 */
export const getFfsTraversalRoots = (type: FfsFilesystemType) => [getFfsClientRootPath(type)]

/**
 * 计算写文件前需要确保存在的父目录链。
 * @param path - 规范化后的绝对路径
 */
export const listFfsParentDirectories = (path: string) => {
	const segments = path.split('/').filter(Boolean)
	const directories: Array<string> = []
	let currentPath = ''

	for (const segment of segments.slice(0, -1)) {
		currentPath += `/${segment}`
		directories.push(currentPath)
	}

	return directories
}

/**
 * 将标准化路径映射到底层文件系统客户端路径。
 * @param type - 文件系统类型
 * @param path - 标准化绝对路径
 */
export const toFfsClientPath = (type: FfsFilesystemType, path: string) =>
	type === 'fatfs' && !path.toLowerCase().startsWith(`${FFS_FAT_MOUNT_PATH}/`) && path !== FFS_FAT_MOUNT_PATH
		? `${FFS_FAT_MOUNT_PATH}${path}`
		: path

/**
 * 根据镜像内容推导文件系统挂载尝试计划。
 * @param type - 文件系统类型
 * @param image - 原始镜像
 */
export const buildFfsMountPlan = (type: FfsFilesystemType, image: Uint8Array): FfsMountPlan => {
	const blankImage = isBlankFfsImage(image)
	return {
		type,
		blankImage,
		clientRootPath: getFfsClientRootPath(type),
		attempts: buildFfsMountAttempts(type, image.length, blankImage)
	}
}
