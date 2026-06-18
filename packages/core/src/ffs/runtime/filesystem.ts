import { calculateFfsUsage, normalizeFfsEntry, sortFfsEntries } from '../entries'
import { getFfsTraversalRoots, listFfsParentDirectories, toFfsClientPath } from '../mount'
import { normalizeFfsDirectoryPath, normalizeFfsFilePath } from '../paths'
import { collectFfsTreeEntries } from '../traversal'

import type { FfsFileEntry, FfsFilesystemUsage, FfsMountedFilesystem } from '../types'
import type { FfsRuntimeClient, FfsSpiffsClient, FfsTreeFilesystemClient } from './filesystem.types'

const isSpiffsClient = (client: FfsRuntimeClient): client is FfsSpiffsClient =>
	'read' in client && 'write' in client && 'remove' in client

const getTreeClient = (client: FfsRuntimeClient): FfsTreeFilesystemClient => client as FfsTreeFilesystemClient

/**
 * 读取已挂载文件系统的文件列表。
 * @param filesystem - 已挂载文件系统
 */
export const listMountedFfsFiles = async (
	filesystem: FfsMountedFilesystem<FfsRuntimeClient>
): Promise<Array<FfsFileEntry>> => {
	const entries = isSpiffsClient(filesystem.client)
		? await filesystem.client.list()
		: collectFfsTreeEntries({
				rootPaths: getFfsTraversalRoots(filesystem.type),
				list: path => getTreeClient(filesystem.client).list(path)
			})

	return sortFfsEntries(entries.map(entry => normalizeFfsEntry(filesystem.type, entry)))
}

/**
 * 从已挂载文件系统读取文件。
 * @param filesystem - 已挂载文件系统
 * @param path - 目标路径
 */
export const readMountedFfsFile = async (filesystem: FfsMountedFilesystem<FfsRuntimeClient>, path: string) => {
	const normalizedPath = normalizeFfsFilePath(path, filesystem.type)
	if (isSpiffsClient(filesystem.client)) {
		return filesystem.client.read(normalizedPath)
	}

	return getTreeClient(filesystem.client).readFile(toFfsClientPath(filesystem.type, normalizedPath))
}

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
 * 计算已挂载文件系统的容量统计。
 * @param filesystem - 已挂载文件系统
 */
export const readMountedFfsUsage = async (
	filesystem: FfsMountedFilesystem<FfsRuntimeClient>
): Promise<FfsFilesystemUsage | null> => {
	if (!filesystem.client.getUsage) return null
	return calculateFfsUsage({
		type: filesystem.type,
		usage: await filesystem.client.getUsage(),
		entries: filesystem.files
	})
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
