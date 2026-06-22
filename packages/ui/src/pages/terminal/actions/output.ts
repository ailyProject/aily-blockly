import { renderUploadRecoveryHint, renderUploadStatusText, summarizeUploadResult } from 'shared'

import type { UploadErrorCode, UploadProgressEvent } from 'shared'
import type { TerminalPageSignals } from '../component.types'

/**
 * 创建 terminal 输出写入动作。
 * @param signals - terminal 页面信号集合
 */
export const createTerminalOutputActions = (signals: TerminalPageSignals) => ({
	/**
	 * 逐行追加多段文本，避免把长日志块直接一次性塞进视图。
	 * @param lines - 待写入的文本行
	 */
	appendOutputLines(lines: Array<string>) {
		for (const line of lines) {
			this.appendOutput(`${line}\n`)
		}
	},
	/**
	 * 把任意文本片段追加到 terminal 输出区域，并同步行计数。
	 * @param text - 待追加的终端文本
	 */
	appendOutput(text: string) {
		signals.lines.update(lines => [...lines, text])
		const lineBreakCount = text.split(/\r?\n/).length - 1
		if (lineBreakCount > 0) {
			signals.lineCount.update(lineCount => lineCount + lineBreakCount)
		}
	},
	/**
	 * 把 core build/upload 的步骤日志规整后写入 terminal 视图。
	 * @param action - 当前动作标签
	 * @param logs - 分步骤日志
	 * @param stdout - 聚合标准输出
	 * @param stderr - 聚合标准错误
	 * @param success - 最终是否成功
	 */
	appendBuildLogs(
		action: 'build' | 'upload',
		logs: Array<{ step: string; stdout: string; stderr: string }>,
		stdout: string,
		stderr: string,
		success: boolean
	) {
		this.appendOutput(`\n[${action} start]\n`)
		for (const log of logs) {
			this.appendOutput(`\n[step:${log.step}]\n`)
			const body = log.stdout || log.stderr || 'No step output.'
			this.appendOutputLines(body.split(/\r?\n/).filter(Boolean))
		}
		if (!logs.length) {
			this.appendOutput(`\n[${action} output]\n`)
			this.appendOutputLines((stdout || stderr || 'No output.').split(/\r?\n/).filter(Boolean))
		}
		this.appendOutput(`\n[${action} ${success ? 'done' : 'failed'}]\n`)
	},
	/**
	 * 把上传过程中的结构化进度事件写入 terminal 视图。
	 * @param progressEvents - 上传阶段事件
	 */
	appendUploadProgress(progressEvents: Array<UploadProgressEvent>) {
		if (!progressEvents.length) return
		this.appendOutput('\n[upload progress]\n')
		for (const event of progressEvents) {
			const progressText = typeof event.progress === 'number' ? ` ${event.progress}%` : ''
			this.appendOutput(`[phase:${event.phase}]${progressText} ${event.line}\n`)
		}
	},
	/**
	 * 把统一上传摘要写入 terminal 输出。
	 * @param input - 上传摘要输入
	 */
	appendUploadSummary(input: {
		success: boolean
		port?: string
		steps: Array<{ label: string }>
		progressEvents: Array<{ phase: string; progress?: number }>
		stdout: string
		error?: string
		errorCode?: UploadErrorCode
		artifactPath?: string
	}) {
		const summary = summarizeUploadResult(input)
		signals.lastUploadSummary.set({
			channel: summary.channel,
			status: summary.status,
			errorCode: summary.errorCode,
			message: summary.message,
			artifactPath: summary.artifactPath,
			latestPhaseText: summary.latestPhaseText,
			recoveryHint: renderUploadRecoveryHint(summary.errorCode)
		})
		this.appendOutput('\n[upload summary]\n')
		this.appendOutput(`[channel] ${summary.channel}\n`)
		this.appendOutput(`[status] ${renderUploadStatusText(summary.status, summary.errorCode)}\n`)
		this.appendOutput(`[message] ${summary.message}\n`)
		if (summary.artifactPath) {
			this.appendOutput(`[artifact] ${summary.artifactPath}\n`)
		}
		if (summary.latestPhaseText) {
			this.appendOutput(`[latest] ${summary.latestPhaseText}\n`)
		}
		const recoveryHint = renderUploadRecoveryHint(summary.errorCode)
		if (recoveryHint) {
			this.appendOutput(`[recovery] ${recoveryHint}\n`)
		}
	}
})
