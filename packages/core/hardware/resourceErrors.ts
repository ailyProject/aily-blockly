const isHttpLikeError = (error: unknown): error is { status?: number; error?: unknown; message?: string } =>
	Boolean(error && typeof error === 'object' && ('status' in error || 'message' in error || 'error' in error))

/**
 * 提取资源加载错误消息
 * @param error - 原始错误
 */
export const getResourceLoadErrorMessage = (error: unknown): string => {
	if (isHttpLikeError(error)) {
		if (typeof error.error === 'string' && error.error.trim()) {
			return error.error
		}
		return error.message || `HTTP ${error.status ?? 0}`
	}

	if (error instanceof Error) {
		return error.message
	}

	if (typeof error === 'string') {
		return error
	}

	return '未知错误'
}

/**
 * 构建资源重载失败文案
 * @param resourceLabel - 资源名称
 * @param remoteError - 线上重载错误
 */
export const buildResourceReloadFailureMessage = (resourceLabel: string, remoteError: unknown): string => {
	if (isHttpLikeError(remoteError)) {
		if (remoteError.status === 0) {
			return `${resourceLabel}加载失败：网络连接异常，请检查网络或代理设置后重试。`
		}

		if (typeof remoteError.status === 'number' && remoteError.status > 0) {
			return `${resourceLabel}加载失败：服务器返回 ${remoteError.status}，请稍后重试。`
		}
	}

	const remoteMessage = getResourceLoadErrorMessage(remoteError)
	if (/(network|timeout|failed to fetch|net::|offline)/i.test(remoteMessage)) {
		return `${resourceLabel}加载失败：网络连接异常，请检查网络或代理设置后重试。`
	}

	const compactMessage = remoteMessage && remoteMessage.length <= 60 ? `：${remoteMessage}` : '，请稍后重试。'
	return `${resourceLabel}加载失败${compactMessage}`
}
