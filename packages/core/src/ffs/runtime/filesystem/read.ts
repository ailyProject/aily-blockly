import { calculateFfsUsage, normalizeFfsEntry, sortFfsEntries } from '../../entries'
import { getFfsTraversalRoots, toFfsClientPath } from '../../mount'
import { normalizeFfsFilePath } from '../../paths'
import { collectFfsTreeEntries } from '../../traversal'
import { getTreeClient, isSpiffsClient } from './shared'

import type { FfsFileEntry, FfsFilesystemUsage, FfsMountedFilesystem } from '../../types'
import type { FfsRuntimeClient } from './types'

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
