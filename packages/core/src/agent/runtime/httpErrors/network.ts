import { getQuotaExceededMessage, isQuotaExceededError } from './quota'
import { SESSION_LOST_GENERIC_PATTERNS, TRANSIENT_CONNECTIVITY_PATTERNS } from './shared'
import { extractErrorDetailMessage, extractHttpStatusCode, getHttpErrorFallbackMessage } from './status'

/**
 * 获取首选 HTTP 错误消息
 * @param error - 原始错误
 */
export const getPreferredHttpErrorMessage = (error: unknown) => {
	if (isQuotaExceededError(error)) {
		return getQuotaExceededMessage(error)
	}

	const detailMessage = extractErrorDetailMessage(error)
	if (detailMessage) {
		return detailMessage
	}

	return getHttpErrorFallbackMessage(error)
}

/**
 * 判断是否为瞬态网络错误
 * @param error - 原始错误
 */
export const isTransientNetworkError = (error: unknown) => {
	if (!error) return false
	if ((error as Error)?.name === 'AbortError') return false

	if (error instanceof TypeError) {
		const message = (error.message || '').toLowerCase()
		if (
			message === 'network' ||
			message.includes('failed to fetch') ||
			message.includes('load failed') ||
			message.includes('network error') ||
			message.includes('networkerror')
		) {
			return true
		}
	}

	const errorMessage = (((error as Error)?.message || '') as string).toLowerCase()
	if (
		errorMessage.includes('err_incomplete_chunked_encoding') ||
		errorMessage.includes('net::err_incomplete_chunked_encoding') ||
		errorMessage.includes('premature close') ||
		errorMessage.includes('err_content_length_mismatch') ||
		errorMessage.includes('err_connection_closed') ||
		errorMessage.includes('err_http2_protocol_error') ||
		(errorMessage.includes('aborted') && !(error as Error)?.name?.includes('AbortError'))
	) {
		return true
	}

	const status = extractHttpStatusCode(error)
	if (status === 502 || status === 503 || status === 504) {
		const detail = extractErrorDetailMessage(error)
		const message = ((error as Record<string, any>)?.['message'] || '').toLowerCase()
		const combined = `${detail} ${message}`.toLowerCase()
		if (TRANSIENT_CONNECTIVITY_PATTERNS.some(pattern => pattern.test(combined))) {
			return true
		}
	}

	if (status === 0) {
		const detail = extractErrorDetailMessage(error)
		if (detail) return false
		return true
	}

	return false
}

/**
 * 判断是否可能是会话丢失错误
 * @param error - 原始错误
 */
export const isLikelySessionLostError = (error: unknown) => {
	if (!error) return false

	const status = extractHttpStatusCode(error)
	const target = error as Record<string, any>
	const code = target?.['code'] ?? target?.['error']?.['code']

	if (status === 404 && code === 21001) return true
	if (status !== 500) return false

	const detail = extractErrorDetailMessage(error)
	if (!detail) return true
	return SESSION_LOST_GENERIC_PATTERNS.some(pattern => pattern.test(detail))
}
