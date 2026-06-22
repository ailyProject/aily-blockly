import { createTerminalBuildPreviewActions } from './build/preview'
import { createTerminalBuildRunActions } from './build/run'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { UploadProgressEvent } from 'shared'
import type { TerminalPageSignals } from '../utils/types'

/**
 * 创建 terminal 构建与上传动作。
 * @param input - terminal 状态、core 依赖与输出动作
 */
export const createTerminalBuildActions = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	signals: TerminalPageSignals
	appendOutput: (text: string) => void
	appendBuildLogs: (
		action: 'build' | 'upload',
		logs: Array<{ step: string; stdout: string; stderr: string }>,
		stdout: string,
		stderr: string,
		success: boolean
	) => void
	appendUploadProgress: (progressEvents: Array<UploadProgressEvent>) => void
	appendUploadSummary: (input: {
		success: boolean
		port?: string
		steps: Array<{ label: string }>
		progressEvents: Array<{ phase: string; progress?: number }>
		stdout: string
		error?: string
		errorCode?: import('shared').UploadErrorCode
		artifactPath?: string
	}) => void
}) => {
	const previewActions = createTerminalBuildPreviewActions({
		core: input.core,
		signals: input.signals,
		appendOutput: input.appendOutput
	})

	return {
		...previewActions,
		...createTerminalBuildRunActions({
			core: input.core,
			desktop: input.desktop,
			signals: input.signals,
			previewActions,
			appendOutput: input.appendOutput,
			appendBuildLogs: input.appendBuildLogs,
			appendUploadProgress: input.appendUploadProgress,
			appendUploadSummary: input.appendUploadSummary
		})
	}
}
