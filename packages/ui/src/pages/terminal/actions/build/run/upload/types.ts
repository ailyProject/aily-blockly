import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { UploadErrorCode, UploadProgressEvent } from 'shared'
import type { TerminalPageSignals } from '../../../../utils/types'
import type { createTerminalBuildPreviewActions } from '../../preview'

/**
 * terminal 当前 upload 动作依赖。
 */
export interface TerminalCurrentUploadActionInput {
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
	appendUploadProgress: (progressEvents: Array<UploadProgressEvent>) => void
	appendUploadSummary: (input: {
		success: boolean
		port?: string
		steps: Array<{ label: string }>
		progressEvents: Array<{ phase: string; progress?: number }>
		stdout: string
		error?: string
		errorCode?: UploadErrorCode
		artifactPath?: string
	}) => void
}
