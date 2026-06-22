import { getNestedErrorData } from './shared'
import { extractErrorDetailMessage, extractHttpStatusCode } from './status'

/**
 * 判断是否为 quota exceeded 错误
 * @param error - 原始错误
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
			candidate['error'],
			candidate['code'],
			candidate['error_code'],
			candidate['errorCode'],
			candidate['type'],
			candidate['reason']
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
					: [candidate?.['message'], candidate?.['detail'], candidate?.['msg']].filter(Boolean).join(' ')
			return /quota_exceeded|AI对话免费次数已用完|对话次数已用完/.test(String(text))
		})
	)
}

/**
 * 获取 quota exceeded 文案
 * @param error - 原始错误
 */
export const getQuotaExceededMessage = (error: unknown) =>
	extractErrorDetailMessage(error) || '本月AI对话免费次数已用完'

/**
 * 获取 quota 使用量文本
 * @param error - 原始错误
 */
export const getQuotaUsageText = (error: unknown) => {
	for (const candidate of getNestedErrorData(error)) {
		if (!candidate || typeof candidate !== 'object') continue
		const limit = Number(candidate['limit'])
		const used = Number(candidate['used'])
		if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
			return `本月已用 ${used}/${limit} 次。`
		}
	}

	return ''
}
