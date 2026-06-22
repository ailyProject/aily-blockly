import { cancelTerminalProjectBuild, cancelTerminalProjectUpload } from '../runtime'
import { createTerminalCurrentBuildActions } from './build.run.build'
import { createTerminalCurrentUploadActions } from './build.run.upload'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { TerminalPageSignals } from '../component.types'
import type { createTerminalBuildPreviewActions } from './build.preview'

/**
 * 创建 terminal 的 build/upload 执行动作。
 * @param input - 依赖、预览动作与输出动作
 */
export const createTerminalBuildRunActions = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	signals: TerminalPageSignals
	previewActions: ReturnType<typeof createTerminalBuildPreviewActions>
	appendOutput: (text: string) => void
	appendBuildLogs: (
		action: 'build' | 'upload',
		logs: Array<{ step: string; stdout: string; stderr: string }>,
		stdout: string,
		stderr: string,
		success: boolean
	) => void
	appendUploadProgress: (progressEvents: Array<import('shared').UploadProgressEvent>) => void
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
}) => ({
	async interruptRunningAction() {
		if (input.signals.actionKind() === 'build') {
			await cancelTerminalProjectBuild(input.core)
			input.appendOutput('\n[build cancel requested]\n')
			return true
		}
		if (input.signals.actionKind() === 'upload') {
			await cancelTerminalProjectUpload(input.core)
			input.appendOutput('\n[upload cancel requested]\n')
			return true
		}
		return false
	},
	...createTerminalCurrentBuildActions(input),
	...createTerminalCurrentUploadActions(input)
})
