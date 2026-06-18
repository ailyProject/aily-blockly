/**
 * 将字节数格式化为人类可读文本。
 * @param bytes - 原始字节数
 */
export const formatFfsBytes = (bytes: number) => {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

	const units = ['B', 'KB', 'MB', 'GB']
	let value = bytes
	let unitIndex = 0

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024
		unitIndex += 1
	}

	const digits = value >= 10 || unitIndex === 0 ? 0 : 1
	return `${value.toFixed(digits)} ${units[unitIndex]}`
}
