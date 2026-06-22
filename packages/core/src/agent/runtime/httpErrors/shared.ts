export const TRANSIENT_CONNECTIVITY_PATTERNS: Array<RegExp> = [
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

export const SESSION_LOST_GENERIC_PATTERNS: Array<RegExp> = [
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

export const getNestedErrorData = (error: unknown) => {
	const target = error as Record<string, any>
	return [
		target,
		target?.['error'],
		target?.['data'],
		target?.['response']?.['data'],
		target?.['cause'],
		target?.['cause']?.['error']
	].filter(Boolean)
}

export const isGenericTransportErrorText = (text: string) => {
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
