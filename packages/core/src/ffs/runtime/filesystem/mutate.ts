import { listFfsParentDirectories, toFfsClientPath } from '../../mount'
import { normalizeFfsDirectoryPath, normalizeFfsFilePath } from '../../paths'
import { getTreeClient, isSpiffsClient } from './shared'

import type { FfsFileEntry, FfsMountedFilesystem } from '../../types'
import type { FfsRuntimeClient } from './types'

/**
 * 向已挂载文件系统写入文件。
 * @param filesystem - 已挂载文件系统
 * @param path - 目标路径
 * @param data - 文件内容
 */
export const writeMountedFfsFile = async (
	filesystem: FfsMountedFilesystem<FfsRuntimeClient>,
	path: string,
	data: Uint8Array
) => {
	const normalizedPath = normalizeFfsFilePath(path, filesystem.type)
	if (isSpiffsClient(filesystem.client)) {
		await filesystem.client.write(normalizedPath, data)
		return
	}

	const client = getTreeClient(filesystem.client)
	for (const directoryPath of listFfsParentDirectories(normalizedPath)) {
		await Promise.resolve(client.mkdir(toFfsClientPath(filesystem.type, directoryPath))).catch(() => undefined)
	}
	await Promise.resolve(client.writeFile(toFfsClientPath(filesystem.type, normalizedPath), data))
}

/**
 * 删除已挂载文件系统中的条目。
 * @param filesystem - 已挂载文件系统
 * @param entry - 待删除条目
 */
export const deleteMountedFfsEntry = async (
	filesystem: FfsMountedFilesystem<FfsRuntimeClient>,
	entry: FfsFileEntry
) => {
	if (isSpiffsClient(filesystem.client)) {
		await filesystem.client.remove(entry.path)
		return
	}

	const client = getTreeClient(filesystem.client)
	const clientPath = toFfsClientPath(filesystem.type, entry.path)
	if (filesystem.type === 'littlefs' && entry.type === 'dir' && client.delete) {
		await Promise.resolve(client.delete(clientPath, { recursive: true }))
		return
	}

	await Promise.resolve(client.deleteFile?.(clientPath))
}

/**
 * 重命名已挂载文件系统中的条目。
 * @param filesystem - 已挂载文件系统
 * @param entry - 待重命名条目
 * @param nextPath - 新路径
 */
export const renameMountedFfsEntry = async (
	filesystem: FfsMountedFilesystem<FfsRuntimeClient>,
	entry: FfsFileEntry,
	nextPath: string
) => {
	const normalizedPath =
		entry.type === 'dir' ? normalizeFfsDirectoryPath(nextPath) : normalizeFfsFilePath(nextPath, filesystem.type)

	if (isSpiffsClient(filesystem.client)) {
		const data = await filesystem.client.read(entry.path)
		await filesystem.client.write(normalizedPath, data)
		await filesystem.client.remove(entry.path)
		return
	}

	const client = getTreeClient(filesystem.client)
	for (const directoryPath of listFfsParentDirectories(normalizedPath)) {
		await Promise.resolve(client.mkdir(toFfsClientPath(filesystem.type, directoryPath))).catch(() => undefined)
	}
	await Promise.resolve(
		client.rename(toFfsClientPath(filesystem.type, entry.path), toFfsClientPath(filesystem.type, normalizedPath))
	)
}
