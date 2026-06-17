const TRANSIENT_CONNECTIVITY_PATTERNS: Array<RegExp> = [
	/name resolution failed/i,
	/dns/i,
	/econnrefused/i,
	/econnreset/i,
	/enotfound/i,
	/connection refused/i,
	/connection reset/i,
	/socket hang up/i,
	/service(?:.*?)unavailable/i,
	/invalid response.*upstream/i,
	/upstream/i,
	/bad gateway/i,
	/gateway timeout/i
]

const SESSION_LOST_GENERIC_PATTERNS: Array<RegExp> = [
	/^an unexpected error occurred$/i,
	/^internal server error$/i,
	/^unknown error$/i,
	/^unexpected error$/i,
	/^server error$/i,
	/session.*not found/i,
	/session.*expired/i,
	/session.*invalid/i,
	/session.*does not exist/i
]

const getNestedErrorData = (error: unknown) => {
	const target = error as Record<string, any>
	return [target, target?.error, target?.data, target?.response?.data, target?.cause, target?.cause?.error].filter(
		Boolean
	)
}

const isGenericTransportErrorText = (text: string) => {
	const normalized = text.trim()
	if (!normalized) return false

	return [
		/\bhttp\s*error\b/i,
		/\brequest failed with status code \d{3}\b/i,
		/\bstatus(?:\s+code)?\s*[:=]?\s*\d{3}\b/i,
		/\bnetwork\s*error\b/i,
		/\bnetworkerror\b/i,
		/^network$/i,
		/\bfailed to fetch\b/i,
		/\bload failed\b/i,
		/\btimeout of \d+ms exceeded\b/i,
		/^timeout$/i
	].some(pattern => pattern.test(normalized))
}

/**
 * 提取 HTTP 状态码
 * @param {unknown} error - 原始错误
 * @returns {number}
 */
export const extractHttpStatusCode = (error: unknown): number => {
	const target = error as Record<string, any>
	const directCandidate =
		target?.status ??
		target?.statusCode ??
		target?.response?.status ??
		target?.error?.status ??
		target?.error?.statusCode ??
		target?.cause?.status ??
		target?.cause?.statusCode

	const directStatus = Number(directCandidate)
	if (Number.isFinite(directStatus) && directStatus >= 100 && directStatus <= 599) {
		return directStatus
	}

	const textCandidates = [
		target?.message,
		target?.error?.message,
		target?.response?.statusText,
		target?.cause?.message,
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
 * @param {unknown} error - 原始错误
 * @returns {string}
 */
export const extractErrorDetailMessage = (error: unknown): string => {
	if (!error) return ''

	const target = error as Record<string, any>
	const detailCandidate = target?.error ?? target?.response?.data ?? target?.data ?? target?.cause?.error
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
		target?.detail,
		target?.error?.detail,
		target?.error?.message,
		target?.response?.data?.message,
		target?.response?.data?.detail,
		target?.message,
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
 * 判断是否为 quota exceeded 错误
 * @param {unknown} error - 原始错误
 * @returns {boolean}
 */
export const isQuotaExceededError = (error: unknown) => {
	if (!error) return false

	const status = extractHttpStatusCode(error)
	const candidates = getNestedErrorData(error)

	for (const candidate of candidates) {
		if (typeof candidate === 'string') {
			if (candidate === 'quota_exceeded') return true
			continue
		}

		if (!candidate || typeof candidate !== 'object') continue
		const codeCandidates = [
			candidate.error,
			candidate.code,
			candidate.error_code,
			candidate.errorCode,
			candidate.type,
			candidate.reason
		]

		if (codeCandidates.some(code => code === 'quota_exceeded')) {
			return true
		}
	}

	return (
		status === 429 &&
		candidates.some(candidate => {
			const text =
				typeof candidate === 'string'
					? candidate
					: [candidate?.message, candidate?.detail, candidate?.msg].filter(Boolean).join(' ')
			return /quota_exceeded|AI对话免费次数已用完|对话次数已用完/.test(String(text))
		})
	)
}

/**
 * 获取 quota exceeded 文案
 * @param {unknown} error - 原始错误
 * @returns {string}
 */
export const getQuotaExceededMessage = (error: unknown) =>
	extractErrorDetailMessage(error) || '本月AI对话免费次数已用完'

/**
 * 获取 quota 使用量文本
 * @param {unknown} error - 原始错误
 * @returns {string}
 */
export const getQuotaUsageText = (error: unknown) => {
	for (const candidate of getNestedErrorData(error)) {
		if (!candidate || typeof candidate !== 'object') continue
		const limit = Number(candidate.limit)
		const used = Number(candidate.used)
		if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
			return `本月已用 ${used}/${limit} 次。`
		}
	}

	return ''
}

/**
 * 根据状态码生成兜底错误文案
 * @param {unknown} error - 原始错误
 * @returns {string}
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

/**
 * 获取首选 HTTP 错误消息
 * @param {unknown} error - 原始错误
 * @returns {string}
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
 * @param {unknown} error - 原始错误
 * @returns {boolean}
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
		const message = ((error as Record<string, any>)?.message || '').toLowerCase()
		const combined = `${detail} ${message}`.toLowerCase()
		if (TRANSIENT_CONNECTIVITY_PATTERNS.some(pattern => pattern.test(combined))) {
			return true
		}
	}

	if (status === 0) {
		const detail = extractErrorDetailMessage(error)
		if (detail && !isGenericTransportErrorText(detail)) return false
		return true
	}

	return false
}

/**
 * 判断是否可能是会话丢失错误
 * @param {unknown} error - 原始错误
 * @returns {boolean}
 */
export const isLikelySessionLostError = (error: unknown) => {
	if (!error) return false

	const status = extractHttpStatusCode(error)
	const target = error as Record<string, any>
	const code = target?.code ?? target?.error?.code

	if (status === 404 && code === 21001) return true
	if (status !== 500) return false

	const detail = extractErrorDetailMessage(error)
	if (!detail) return true
	return SESSION_LOST_GENERIC_PATTERNS.some(pattern => pattern.test(detail))
}
