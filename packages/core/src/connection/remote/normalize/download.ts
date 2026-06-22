/**
 * 解析云端返回的下载地址。
 * @param apiBase - API 基地址
 * @param value - 云端原始字段
 */
export const resolveRemoteDownloadUrl = (apiBase: string, value: unknown) => {
	if (typeof value !== 'string' || value.length === 0) return null
	if (/^https?:\/\//i.test(value)) return value
	return value.startsWith('/') ? `${apiBase.replace(/\/$/, '')}${value}` : null
}
