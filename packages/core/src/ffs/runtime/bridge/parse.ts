/**
 * 解析串口元数据中的 USB ID。
 * @param raw - 原始 VID/PID 字段
 */
export const parseFfsUsbId = (raw: unknown) => {
	if (raw == null) return undefined
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw

	const text = String(raw).trim()
	if (!text) return undefined

	const cleaned = text.replace(/^0x/i, '')
	const value = Number.parseInt(cleaned, 16)
	return Number.isFinite(value) ? value : undefined
}
