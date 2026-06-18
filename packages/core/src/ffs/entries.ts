import { formatFfsBytes } from './format'
import { normalizeFfsPath } from './paths'

import type { FfsFileEntry, FfsFilesystemType, FfsFilesystemUsage } from './types'

type FfsRawEntry = {
	path?: unknown
	name?: unknown
	type?: unknown
	size?: unknown
}

/**
 * 将底层文件系统条目规整为统一 FFS 结构。
 * @param type - 文件系统类型
 * @param entry - 底层返回的原始条目
 */
export const normalizeFfsEntry = (type: FfsFilesystemType, entry: FfsRawEntry): FfsFileEntry => {
	const rawPath = String(entry.path || entry.name || '')
	const path = normalizeFfsPath(type === 'fatfs' ? rawPath.replace(/^\/fatfs/i, '') : rawPath)
	const segments = path.split('/').filter(Boolean)
	const name = String(entry.name || segments[segments.length - 1] || path)
	const entryType = entry.type === 'dir' ? 'dir' : 'file'
	const size = entryType === 'file' ? Number(entry.size || 0) : 0

	return {
		name,
		path,
		type: entryType,
		size,
		sizeText: entryType === 'file' ? formatFfsBytes(size) : '-'
	}
}

/**
 * 对 FFS 文件条目做稳定排序，目录优先，其次按路径字典序。
 * @param entries - 原始条目列表
 */
export const sortFfsEntries = (entries: Array<FfsFileEntry>) =>
	[...entries].sort((left, right) => {
		if (left.type !== right.type) {
			return left.type === 'dir' ? -1 : 1
		}

		return left.path.localeCompare(right.path)
	})

/**
 * 根据底层 usage 与已知条目生成统一的容量摘要。
 * @param options - 容量统计输入
 */
export const calculateFfsUsage = (options: {
	type: FfsFilesystemType
	usage?: {
		capacityBytes?: number
		usedBytes?: number
		freeBytes?: number
	} | null
	entries?: Array<FfsFileEntry>
}): FfsFilesystemUsage | null => {
	if (!options.usage) return null

	const capacityBytes = Number(options.usage.capacityBytes || 0)
	const usedBytes =
		options.type === 'fatfs'
			? (options.entries ?? []).reduce((total, entry) => (entry.type === 'file' ? total + entry.size : total), 0)
			: Number(options.usage.usedBytes || 0)
	const freeBytes = capacityBytes > usedBytes ? capacityBytes - usedBytes : Number(options.usage.freeBytes || 0)

	return {
		capacityBytes,
		usedBytes,
		freeBytes,
		capacityText: formatFfsBytes(capacityBytes),
		usedText: formatFfsBytes(usedBytes),
		freeText: formatFfsBytes(freeBytes),
		usedPercent: capacityBytes ? Math.min(100, Math.round((usedBytes / capacityBytes) * 100)) : 0
	}
}
