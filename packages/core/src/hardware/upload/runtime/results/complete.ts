import { withHardwareUploadSummary } from './shared'

import type { HardwareUploadCommandStep, HardwareUploadProgressEvent } from '../../types'

/**
 * 构造上传取消结果。
 * @param input - 取消上下文
 */
export const createCancelledUploadResult = (input: {
	startedAt: number
	artifactPath?: string
	port?: string
	buildPath: string
	builtBeforeUpload: boolean
	step: HardwareUploadCommandStep
	stdout: string
	stderr: string
	progressEvents: Array<HardwareUploadProgressEvent>
	buildStdout?: string
	buildStderr?: string
	buildLogs?: Array<{ step: string; stdout: string; stderr: string }>
}) =>
	withHardwareUploadSummary({
		success: false,
		durationMs: Date.now() - input.startedAt,
		artifactPath: input.artifactPath,
		port: input.port,
		buildPath: input.buildPath,
		builtBeforeUpload: input.builtBeforeUpload,
		steps: [input.step],
		logs: [...(input.buildLogs ?? []), { step: input.step.label, stdout: input.stdout, stderr: input.stderr }],
		progressEvents: input.progressEvents,
		stdout: [input.buildStdout, input.stdout].filter(Boolean).join('\n'),
		stderr: [input.buildStderr, input.stderr].filter(Boolean).join('\n'),
		error: '上传已取消',
		errorCode: 'cancelled'
	})

/**
 * 构造上传完成结果。
 * @param input - 完成上下文
 */
export const createCompletedUploadResult = (input: {
	startedAt: number
	success: boolean
	artifactPath?: string
	port?: string
	buildPath: string
	builtBeforeUpload: boolean
	step: HardwareUploadCommandStep
	stdout: string
	stderr: string
	progressEvents: Array<HardwareUploadProgressEvent>
	buildStdout?: string
	buildStderr?: string
	buildLogs?: Array<{ step: string; stdout: string; stderr: string }>
	exitCode: number
}) =>
	withHardwareUploadSummary({
		success: input.success,
		durationMs: Date.now() - input.startedAt,
		artifactPath: input.artifactPath,
		port: input.port,
		buildPath: input.buildPath,
		builtBeforeUpload: input.builtBeforeUpload,
		steps: [input.step],
		logs: [...(input.buildLogs ?? []), { step: input.step.label, stdout: input.stdout, stderr: input.stderr }],
		progressEvents: input.progressEvents,
		stdout: [input.buildStdout, input.stdout].filter(Boolean).join('\n'),
		stderr: [input.buildStderr, input.stderr].filter(Boolean).join('\n'),
		...(input.success
			? {}
			: {
					error: input.stderr.trim() || `上传失败，退出码: ${input.exitCode}`,
					errorCode: input.stderr.toLowerCase().includes('timeout') ? 'timeout' : 'command-failed'
				})
	})
