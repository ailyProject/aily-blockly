import { formatFfsBytes } from './format'

import type { FfsFilesystemType, FfsPartitionInfo } from './types'

const PARTITION_ENTRY_SIZE = 32
const PARTITION_MAGIC = 0x50aa
const PARTITION_ALIGNMENT = 0x1000

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

const toFfsHex = (value: number, minLength = 0) => `0x${value.toString(16).toUpperCase().padStart(minLength, '0')}`

const readAscii = (bytes: Uint8Array) => {
	let text = ''
	for (const byte of bytes) {
		if (byte === 0) break
		text += String.fromCharCode(byte)
	}
	return text.trim()
}

const getPartitionTypeName = (type: number) => {
	if (type === 0x00) return 'app'
	if (type === 0x01) return 'data'
	return toFfsHex(type, 2)
}

const getPartitionSubtypeName = (type: number, subtype: number) => {
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

const sanitizePartitionFileName = (value: string) =>
	(value || 'partition').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'partition'

/**
 * 解析 ESP 分区表二进制内容。
 * @param bytes - 原始分区表字节流
 */
export const parseFfsPartitionTable = (bytes: Uint8Array): Array<FfsPartitionInfo> => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const partitions: Array<FfsPartitionInfo> = []

	for (let offset = 0; offset + PARTITION_ENTRY_SIZE <= bytes.length; offset += PARTITION_ENTRY_SIZE) {
		const magic = view.getUint16(offset, true)
		if (magic === 0xffff || magic === 0x0000) break
		if (magic !== PARTITION_MAGIC) continue

		const type = view.getUint8(offset + 2)
		const subtype = view.getUint8(offset + 3)
		const partitionOffset = view.getUint32(offset + 4, true)
		const size = view.getUint32(offset + 8, true)
		const label = readAscii(bytes.subarray(offset + 12, offset + 28))
		const flags = view.getUint32(offset + 28, true)

		partitions.push({
			index: partitions.length,
			label,
			type,
			subtype,
			typeName: getPartitionTypeName(type),
			subtypeName: getPartitionSubtypeName(type, subtype),
			offset: partitionOffset,
			size,
			flags,
			offsetHex: toFfsHex(partitionOffset),
			sizeHex: toFfsHex(size),
			sizeText: formatFfsBytes(size),
			filesystemType: detectFfsFilesystemType(label, type, subtype)
		})
	}

	return partitions
}

/**
 * 判断一段字节是否像一个有效的分区表首项。
 * @param bytes - 待探测的首项字节
 */
export const isPlausibleFfsPartitionEntry = (bytes: Uint8Array) => {
	if (bytes.length < PARTITION_ENTRY_SIZE) return false

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (view.getUint16(0, true) !== PARTITION_MAGIC) return false

	const type = view.getUint8(2)
	const offset = view.getUint32(4, true)
	const size = view.getUint32(8, true)

	if (type === 0xff) return false
	if (offset < PARTITION_ALIGNMENT || size < PARTITION_ALIGNMENT) return false
	return offset % PARTITION_ALIGNMENT === 0 && size % PARTITION_ALIGNMENT === 0
}

/**
 * 根据分区信息生成默认镜像文件名。
 * @param partition - 目标分区
 */
export const buildFfsPartitionFileName = (partition: FfsPartitionInfo) => {
	const label = sanitizePartitionFileName(partition.label || `partition_${partition.index}`)
	const suffix =
		partition.filesystemType || partition.subtypeName.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'partition'
	return `${label}_${partition.offsetHex}_${suffix}.bin`
}
