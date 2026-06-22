/**
 * 解析数组载荷
 * @param raw - 原始 JSON 文本
 * @param invalidMessage - 无效时的错误消息
 * @param wrapperKey - 可选包裹字段
 */
export const parseArrayPayload = <T>(raw: string, invalidMessage: string, wrapperKey?: string): Array<T> => {
	const parsed = JSON.parse(raw)
	if (Array.isArray(parsed)) {
		return parsed
	}

	if (
		wrapperKey &&
		parsed &&
		typeof parsed === 'object' &&
		Array.isArray((parsed as Record<string, unknown>)[wrapperKey])
	) {
		return (parsed as Record<string, Array<T>>)[wrapperKey]
	}

	throw new Error(invalidMessage)
}
