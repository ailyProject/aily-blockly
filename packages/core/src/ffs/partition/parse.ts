import { formatFfsBytes } from '../format'
import { detectFfsFilesystemType, getPartitionSubtypeName, getPartitionTypeName } from './detect'
import { PARTITION_ALIGNMENT, PARTITION_ENTRY_SIZE, PARTITION_MAGIC, readFfsAscii, toFfsHex } from './shared'

import type { FfsPartitionInfo } from '../types'

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
		const label = readFfsAscii(bytes.subarray(offset + 12, offset + 28))
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
