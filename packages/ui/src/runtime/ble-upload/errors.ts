/**
 * 规整 BLE 上传异常到统一错误码。
 * @param error - 原始异常
 */
export const classifyBleUploadError = (error: unknown) => {
	const message = String(error instanceof Error ? error.message : error || '')
	const lower = message.toLowerCase()
	if (lower.includes('timeout')) return 'timeout' as const
	if (lower.includes('disconnect')) return 'disconnected' as const
	if (lower.includes('crc') || lower.includes('ack') || lower.includes('packet index') || lower.includes('signature')) {
		return 'ack-failed' as const
	}
	return 'unknown' as const
}
