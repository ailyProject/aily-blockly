import { isGenericTransportErrorText } from './shared'

/**
 * 提取 HTTP 状态码
 * @param error - 原始错误
 */
export const extractHttpStatusCode = (error: unknown): number => {
	const target = error as Record<string, any>
	const directCandidate =
		target?.['status'] ??
		target?.['statusCode'] ??
		target?.['response']?.['status'] ??
		target?.['error']?.['status'] ??
		target?.['error']?.['statusCode'] ??
		target?.['cause']?.['status'] ??
		target?.['cause']?.['statusCode']

	const directStatus = Number(directCandidate)
	if (Number.isFinite(directStatus) && directStatus >= 100 && directStatus <= 599) {
		return directStatus
	}

	const textCandidates = [
		target?.['message'],
		target?.['error']?.['message'],
		target?.['response']?.['statusText'],
		target?.['cause']?.['message'],
		typeof error === 'string' ? error : ''
	].filter(Boolean)

	for (const text of textCandidates) {
		const matched = String(text).match(
			/\b(?:http\s*error[^\d]*|request failed with status code\s*|status(?:\s+code)?\s*[:=]?\s*)(\d{3})\b/i
		)
		if (matched?.[1]) {
			return Number(matched[1])
		}
	}

	const joined = textCandidates
		.map(value => String(value))
		.join(' | ')
		.toLowerCase()
	if (
		joined.includes('failed to fetch') ||
		joined.includes('networkerror') ||
		joined.includes('network error') ||
		/\bnetwork\b/.test(joined) ||
		joined.includes('load failed') ||
		joined.includes('timeout')
	) {
		return 0
	}

	return 0
}

/**
 * 提取详细错误消息
 * @param error - 原始错误
 */
export const extractErrorDetailMessage = (error: unknown): string => {
	if (!error) return ''

	const target = error as Record<string, any>
	const detailCandidate =
		target?.['error'] ?? target?.['response']?.['data'] ?? target?.['data'] ?? target?.['cause']?.['error']
	const objectCandidate = detailCandidate && typeof detailCandidate === 'object' ? detailCandidate : null
	if (objectCandidate) {
		const objectCode = objectCandidate.code
		const objectMessage =
			objectCandidate.message ??
			objectCandidate.msg ??
			objectCandidate.error_description ??
			objectCandidate.error ??
			objectCandidate.detail

		if (objectCode !== undefined && objectCode !== null && typeof objectMessage === 'string' && objectMessage.trim()) {
			return objectMessage.trim()
		}

		if (typeof objectMessage === 'string' && objectMessage.trim()) {
			return objectMessage.trim()
		}
	}

	const directTextCandidates = [
		target?.['detail'],
		target?.['error']?.['detail'],
		target?.['error']?.['message'],
		target?.['response']?.['data']?.['message'],
		target?.['response']?.['data']?.['detail'],
		target?.['message'],
		typeof error === 'string' ? error : ''
	]

	for (const candidate of directTextCandidates) {
		if (typeof candidate !== 'string') continue
		const text = candidate.trim()
		if (!text || isGenericTransportErrorText(text)) continue
		return text
	}

	return ''
}

/**
 * 根据状态码生成兜底错误文案
 * @param error - 原始错误
 */
export const getHttpErrorFallbackMessage = (error: unknown) => {
	const status = extractHttpStatusCode(error)
	const statusMessageMap: Record<number, string> = {
		400: '请求格式错误，请检查。',
		401: '登录已失效，请重新登录。',
		403: '无权限执行该操作。',
		404: '资源不存在，请确认。',
		408: '请求超时，请重试。',
		429: '请求过快，请稍后再试。',
		500: '服务器异常，请稍后再试。',
		502: '服务连接波动，请稍后重试。',
		503: '服务暂时不可用，请稍后重试。',
		504: '服务响应超时，请重试。'
	}

	return statusMessageMap[status] || '网络波动，请重试。'
}
