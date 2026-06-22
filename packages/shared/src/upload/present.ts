import type { UploadChannel, UploadErrorCode, UploadRecoveryActions, UploadStatus } from './types'

/**
 * 把统一上传状态规整成更适合展示的短文案。
 * @param status - 统一上传状态
 * @param errorCode - 统一上传错误码
 */
export const renderUploadStatusText = (status: UploadStatus, errorCode?: UploadErrorCode) => {
	if (status === 'success') return 'success'
	if (status === 'cancelled') return 'cancelled'
	if (status === 'not-ready') return errorCode ? `not-ready (${errorCode})` : 'not-ready'
	return errorCode ? `error (${errorCode})` : 'error'
}

/**
 * 基于统一错误码给出最小恢复建议。
 * @param errorCode - 统一上传错误码
 */
export const renderUploadRecoveryHint = (errorCode?: UploadErrorCode) => {
	if (!errorCode) return ''
	if (errorCode === 'missing-port') return '请选择正确的端口后重试。'
	if (errorCode === 'build-failed') return '先修复构建错误，再重新上传。'
	if (errorCode === 'artifact-missing') return '确认构建产物已生成，或检查开发板模板/固件路径。'
	if (errorCode === 'not-ready') return '请先完成设备选择或上传准备步骤。'
	if (errorCode === 'timeout') return '请保持设备连接稳定，并重试上传。'
	if (errorCode === 'disconnected') return '请重新连接设备后再试。'
	if (errorCode === 'cancelled') return '如需继续，请重新发起上传。'
	if (errorCode === 'ack-failed') return '请重试；若持续失败，尝试重新上电或重新授权设备。'
	if (errorCode === 'command-failed') return '请检查工具链输出日志并重试。'
	return '请查看日志细节后重试。'
}

/**
 * 基于通道/状态/错误码推导最小恢复动作。
 */
export const resolveUploadRecoveryActions = (input: {
	channel: UploadChannel
	status: UploadStatus
	errorCode?: UploadErrorCode
}): UploadRecoveryActions => {
	const { channel, status, errorCode } = input
	if (status === 'success') {
		return {
			canRetry: false,
			canReprepare: false,
			shouldReconnect: false,
			shouldSelectPort: false,
			shouldFixBuild: false
		}
	}

	if (errorCode === 'missing-port') {
		return {
			canRetry: false,
			canReprepare: false,
			shouldReconnect: false,
			shouldSelectPort: true,
			shouldFixBuild: false
		}
	}

	if (errorCode === 'build-failed') {
		return {
			canRetry: false,
			canReprepare: false,
			shouldReconnect: false,
			shouldSelectPort: false,
			shouldFixBuild: true
		}
	}

	if (errorCode === 'artifact-missing' || errorCode === 'not-ready') {
		return {
			canRetry: false,
			canReprepare: true,
			shouldReconnect: false,
			shouldSelectPort: false,
			shouldFixBuild: false
		}
	}

	if (errorCode === 'disconnected') {
		return {
			canRetry: true,
			canReprepare: channel === 'ble',
			shouldReconnect: true,
			shouldSelectPort: channel === 'serial',
			shouldFixBuild: false
		}
	}

	if (
		errorCode === 'ack-failed' ||
		errorCode === 'timeout' ||
		errorCode === 'command-failed' ||
		errorCode === 'cancelled'
	) {
		return {
			canRetry: true,
			canReprepare: channel === 'ble',
			shouldReconnect: channel === 'ble',
			shouldSelectPort: false,
			shouldFixBuild: false
		}
	}

	return {
		canRetry: true,
		canReprepare: channel === 'ble',
		shouldReconnect: channel === 'ble',
		shouldSelectPort: false,
		shouldFixBuild: false
	}
}
