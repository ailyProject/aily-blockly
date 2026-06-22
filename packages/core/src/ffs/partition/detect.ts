import { toFfsHex } from './shared'

import type { FfsFilesystemType } from '../types'

const DATA_SUBTYPE_NAMES: Record<number, string> = {
	0x00: 'ota',
	0x01: 'phy',
	0x02: 'nvs',
	0x03: 'coredump',
	0x04: 'nvs_keys',
	0x05: 'efuse',
	0x80: 'esphttpd',
	0x81: 'fatfs',
	0x82: 'spiffs',
	0x83: 'littlefs'
}

/**
 * 解析分区类型名称。
 * @param type - 分区类型字节
 */
export const getPartitionTypeName = (type: number) => {
	if (type === 0x00) return 'app'
	if (type === 0x01) return 'data'
	return toFfsHex(type, 2)
}

/**
 * 解析分区子类型名称。
 * @param type - 分区类型字节
 * @param subtype - 分区子类型字节
 */
export const getPartitionSubtypeName = (type: number, subtype: number) => {
	if (type === 0x00) {
		if (subtype === 0x00) return 'factory'
		if (subtype === 0x20) return 'test'
		if (subtype >= 0x10 && subtype <= 0x1f) return `ota_${subtype - 0x10}`
	}

	if (type === 0x01) {
		return DATA_SUBTYPE_NAMES[subtype] ?? toFfsHex(subtype, 2)
	}

	return toFfsHex(subtype, 2)
}

/**
 * 根据分区标签与类型推断 Flash FS 类型。
 * @param label - 分区标签
 * @param type - 分区类型
 * @param subtype - 分区子类型
 */
export const detectFfsFilesystemType = (label: string, type: number, subtype: number): FfsFilesystemType | null => {
	if (type !== 0x01) return null
	if (subtype === 0x82) return 'spiffs'
	if (subtype === 0x83) return 'littlefs'
	if (subtype === 0x81) return 'fatfs'

	const normalized = label.toLowerCase()
	if (normalized.includes('littlefs') || normalized.includes('little_fs')) return 'littlefs'
	if (normalized.includes('spiffs') || normalized.includes('spiflash')) return 'spiffs'
	if (normalized.includes('fatfs') || normalized === 'ffat' || normalized.includes('vfs')) return 'fatfs'
	return null
}
