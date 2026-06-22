import { listFfsParentDirectories, toFfsClientPath } from '../mount'
import { normalizeFfsDirectoryPath } from '../paths'
import { listMountedFfsFiles, readMountedFfsUsage } from './filesystem'

import type { FfsMountedFilesystem } from '../types'
import type { FfsRuntimeClient, FfsSpiffsClient, FfsTreeFilesystemClient } from './filesystem/types'

const isSpiffsClient = (client: FfsRuntimeClient): client is FfsSpiffsClient =>
	'read' in client && 'write' in client && 'remove' in client

const getTreeClient = (client: FfsRuntimeClient): FfsTreeFilesystemClient => client as FfsTreeFilesystemClient

/**
 * 刷新挂载文件系统的文件与容量快照。
 * @param filesystem - 已挂载文件系统
 */
export const refreshMountedFfsFilesystem = async (filesystem: FfsMountedFilesystem<FfsRuntimeClient>) => {
	filesystem.files = await listMountedFfsFiles(filesystem)
	filesystem.usage = await readMountedFfsUsage(filesystem)
	return filesystem
}

/**
 * 导出当前挂载文件系统对应的镜像。
 * @param filesystem - 已挂载文件系统
 */
export const exportMountedFfsImage = async (filesystem: FfsMountedFilesystem<FfsRuntimeClient>) => {
	const nextImage = await filesystem.client.toImage()
	filesystem.image = nextImage
	return nextImage
}

/**
 * 创建目录并刷新挂载快照。
 * @param filesystem - 已挂载文件系统
 * @param path - 目录路径
 */
export const createMountedFfsDirectory = async (filesystem: FfsMountedFilesystem<FfsRuntimeClient>, path: string) => {
	if (filesystem.type === 'spiffs') {
		throw new Error('SPIFFS 不支持目录')
	}

	const normalizedPath = normalizeFfsDirectoryPath(path)
	const client = getTreeClient(filesystem.client)
	for (const directoryPath of listFfsParentDirectories(normalizedPath)) {
		await Promise.resolve(client.mkdir(toFfsClientPath(filesystem.type, directoryPath))).catch(() => undefined)
	}
	await Promise.resolve(client.mkdir(toFfsClientPath(filesystem.type, normalizedPath)))
	return refreshMountedFfsFilesystem(filesystem)
}

/**
 * 格式化文件系统并刷新挂载快照。
 * @param filesystem - 已挂载文件系统
 */
export const formatMountedFfsFilesystem = async (filesystem: FfsMountedFilesystem<FfsRuntimeClient>) => {
	await filesystem.client.format()
	return refreshMountedFfsFilesystem(filesystem)
}
