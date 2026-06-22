/**
 * ESP 分区表单项字节长度。
 */
export const PARTITION_ENTRY_SIZE = 32

/**
 * ESP 分区表魔数。
 */
export const PARTITION_MAGIC = 0x50aa

/**
 * ESP 分区偏移和尺寸的最小对齐单位。
 */
export const PARTITION_ALIGNMENT = 0x1000

/**
 * 把数值转换成稳定的大写十六进制文本。
 * @param value - 原始数值
 * @param minLength - 最小位数
 */
export const toFfsHex = (value: number, minLength = 0) =>
	`0x${value.toString(16).toUpperCase().padStart(minLength, '0')}`

/**
 * 从固定长度字节区间读取 ASCII 标签。
 * @param bytes - 原始字节片段
 */
export const readFfsAscii = (bytes: Uint8Array) => {
	let text = ''
	for (const byte of bytes) {
		if (byte === 0) break
		text += String.fromCharCode(byte)
	}
	return text.trim()
}

/**
 * 把分区标签规整成适合文件名的片段。
 * @param value - 原始标签
 */
export const sanitizeFfsPartitionFileName = (value: string) =>
	(value || 'partition').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'partition'
