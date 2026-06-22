import { normalizeFfsFilePath } from './normalize'

import type { FfsFilesystemType } from '../types'

const FILE_NAME_MAX_BYTES: Record<FfsFilesystemType, number> = {
	spiffs: 30,
	littlefs: 63,
	fatfs: 255
}

const FILESYSTEM_LABELS: Record<FfsFilesystemType, string> = {
	spiffs: 'SPIFFS',
	littlefs: 'LittleFS',
	fatfs: 'FATFS'
}

const sanitizePathSegment = (value: string) =>
	String(value || 'file.bin')
		.replace(/[\\/:*?"<>|]+/g, '_')
		.replace(/^_+|_+$/g, '') || 'file.bin'

const getUtf8ByteLength = (value: string) => new TextEncoder().encode(value).length

const truncateName = (value: string) => {
	const chars = Array.from(value)
	if (chars.length <= 48) return value
	return `${chars.slice(0, 24).join('')}...${chars.slice(-21).join('')}`
}

/**
 * 构建某种文件系统的默认上传目标路径。
 * @param fileName - 原始文件名
 * @param type - 文件系统类型
 */
export const getDefaultFfsUploadPath = (fileName: string, type: FfsFilesystemType) =>
	normalizeFfsFilePath(`/${sanitizePathSegment(fileName || 'file.bin')}`, type)

/**
 * 校验上传文件名是否满足当前文件系统限制。
 * @param fileName - 原始文件名
 * @param type - 文件系统类型
 */
export const validateFfsUploadFileName = (fileName: string, type: FfsFilesystemType) => {
	const safeName = sanitizePathSegment(fileName || 'file.bin')
	const byteLength = getUtf8ByteLength(safeName)
	const maxBytes = FILE_NAME_MAX_BYTES[type]

	if (byteLength <= maxBytes) return null

	const originalName = fileName || 'file.bin'
	const safeNameNote = safeName === originalName ? '' : `（清理后文件名：${truncateName(safeName)}）`
	return `${FILESYSTEM_LABELS[type]} 文件名过长${safeNameNote}：当前 ${byteLength} 字节，最多支持 ${maxBytes} 字节。请缩短文件名后再上传；中文通常每个字占 3 字节。`
}
