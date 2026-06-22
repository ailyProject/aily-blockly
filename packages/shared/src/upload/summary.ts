import type { UploadChannel, UploadErrorCode, UploadResultSummary, UploadStatus } from './types'

/**
 * 统一上传摘要函数依赖的最小结果形状。
 */
export interface UploadSummarySource {
	/** 是否成功。 */
	success: boolean
	/** 最终端口。 */
	port?: string
	/** 上传步骤。 */
	steps: Array<{ label: string }>
	/** 最新进度事件列表。 */
	progressEvents: Array<{ phase: string; progress?: number }>
	/** 合并后的标准输出。 */
	stdout: string
	/** 错误文本。 */
	error?: string
	/** 结构化错误码。 */
	errorCode?: UploadErrorCode
	/** 固件产物路径。 */
	artifactPath?: string
}

const resolveUploadChannel = (result: UploadSummarySource): UploadChannel =>
	result.port ? 'serial' : result.steps.some(step => step.label.includes('debugger')) ? 'debugger' : 'ble'

const resolveUploadStatus = (result: UploadSummarySource): UploadStatus => {
	if (result.success) return 'success'
	if (result.errorCode === 'cancelled') return 'cancelled'
	if (
		result.errorCode === 'not-ready' ||
		result.errorCode === 'missing-port' ||
		result.errorCode === 'artifact-missing'
	)
		return 'not-ready'
	if (result.error?.includes('not-ready') || result.error?.includes('未找到')) return 'not-ready'
	if (result.error?.includes('cancel')) return 'cancelled'
	return 'error'
}

const resolveUploadErrorCode = (result: UploadSummarySource): UploadErrorCode | undefined => {
	if (result.success) return undefined
	if (result.errorCode) return result.errorCode

	const message = String(result.error || '').toLowerCase()
	if (!message) return 'unknown'
	if (message.includes('未提供串口') || message.includes('missing port')) return 'missing-port'
	if (message.includes('构建失败') || message.includes('build failed')) return 'build-failed'
	if (message.includes('未找到') || message.includes('artifact')) return 'artifact-missing'
	if (message.includes('timeout')) return 'timeout'
	if (message.includes('disconnect')) return 'disconnected'
	if (message.includes('cancel')) return 'cancelled'
	if (message.includes('ack')) return 'ack-failed'
	if (message.includes('command')) return 'command-failed'
	return 'unknown'
}

/**
 * 把上传执行结果规整成统一摘要。
 * @param result - 上传执行结果
 */
export const summarizeUploadResult = (result: UploadSummarySource): UploadResultSummary => ({
	channel: resolveUploadChannel(result),
	status: resolveUploadStatus(result),
	errorCode: resolveUploadErrorCode(result),
	message: result.error || result.stdout || 'upload finished',
	artifactPath: result.artifactPath,
	latestPhaseText: result.progressEvents.at(-1)
		? `${result.progressEvents.at(-1)!.phase}${typeof result.progressEvents.at(-1)!.progress === 'number' ? ` ${result.progressEvents.at(-1)!.progress}%` : ''}`
		: undefined
})
