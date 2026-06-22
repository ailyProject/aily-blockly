import type { FfsFilesystemType } from '../types'

const FAT_MOUNT = '/fatfs'

const stripFatMount = (path: string) => {
	const normalized = String(path || '')
	if (normalized.toLowerCase() === FAT_MOUNT) return '/'
	return normalized.toLowerCase().startsWith(`${FAT_MOUNT}/`) ? normalized.slice(FAT_MOUNT.length) || '/' : normalized
}

/**
 * 规范化 FFS 通用路径。
 * @param path - 原始路径
 */
export const normalizeFfsPath = (path: string) => {
	const normalized = String(path || '')
		.trim()
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')

	const prefixed = stripFatMount(normalized).startsWith('/')
		? stripFatMount(normalized)
		: `/${stripFatMount(normalized)}`
	const segments = prefixed.split('/').filter(Boolean)
	if (segments.some(segment => segment === '.' || segment === '..')) {
		throw new Error('路径不能包含 . 或 ..')
	}

	return segments.length ? `/${segments.join('/')}` : '/'
}

/**
 * 规范化 FFS 文件路径。
 * @param path - 原始文件路径
 * @param type - 文件系统类型
 */
export const normalizeFfsFilePath = (path: string, type: FfsFilesystemType) => {
	const normalized = normalizeFfsPath(path)
	const segments = normalized.split('/').filter(Boolean)

	if (segments.length === 0) {
		throw new Error('文件路径不能为空')
	}

	if (type === 'spiffs' && segments.length > 1) {
		throw new Error('SPIFFS 文件名不能包含目录')
	}

	return `/${segments.join('/')}`
}

/**
 * 规范化 FFS 目录路径。
 * @param path - 原始目录路径
 */
export const normalizeFfsDirectoryPath = (path: string) => {
	const normalized = normalizeFfsPath(path)
	if (normalized === '/') throw new Error('目录路径不能为空')
	return normalized
}
