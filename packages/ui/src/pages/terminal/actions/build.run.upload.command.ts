import { runTerminalProjectUpload, runTerminalProjectUploadLive } from '../runtime'

import type { TerminalCurrentUploadActionInput } from './build.run.upload.types'

const shouldSkipLiveUploadFallback = (output: string, exitCode: number | null) =>
	exitCode === 130 || output.includes('\u0003') || /\^c/i.test(output) || /cancel/i.test(output)

/**
 * 执行 terminal 的命令型上传动作（serial/debugger）。
 * @param input - upload 动作依赖
 * @param context - 当前运行时与项目上下文
 */
export const runTerminalCommandUploadAction = async (
	input: TerminalCurrentUploadActionInput,
	context: {
		runtimeInfo: NonNullable<ReturnType<TerminalCurrentUploadActionInput['signals']['runtimeInfo']>>
		projectPath: string
		code: string
		target: NonNullable<ReturnType<TerminalCurrentUploadActionInput['signals']['uploadTargets']>>[number]
		sessionId: string | undefined
	}
) => {
	if (input.desktop && context.sessionId) {
		input.appendOutput('\n[upload live session]\n')
		const result = await runTerminalProjectUploadLive({
			core: input.core,
			desktop: input.desktop,
			sessionId: context.sessionId,
			runtimeInfo: context.runtimeInfo,
			projectPath: context.projectPath,
			target: context.target,
			code: context.code
		})
		if (!result.prepared.ready) {
			input.appendOutput('[upload live unavailable]\n')
			return
		}
		input.appendOutput(
			`[upload exit] ${result.result?.exitCode ?? 'unknown'}${result.result?.timedOut ? ' (timed out)' : ''}\n`
		)
		if (!result.success) {
			const output = result.result?.output ?? ''
			const exitCode = result.result?.exitCode ?? null
			if (!shouldSkipLiveUploadFallback(output, exitCode)) {
				input.appendOutput('\n[upload fallback core diagnostics]\n')
				const fallbackResult = await runTerminalProjectUpload(
					input.core,
					context.runtimeInfo,
					context.projectPath,
					context.target,
					context.code
				)
				input.appendUploadProgress(fallbackResult.progressEvents)
				input.appendBuildLogs(
					'upload',
					fallbackResult.logs,
					fallbackResult.stdout,
					fallbackResult.stderr,
					fallbackResult.success
				)
				input.appendUploadSummary({
					success: fallbackResult.success,
					port: fallbackResult.port,
					steps: fallbackResult.steps,
					progressEvents: fallbackResult.progressEvents,
					stdout: fallbackResult.stdout,
					error: fallbackResult.error,
					errorCode: fallbackResult.errorCode,
					artifactPath: fallbackResult.artifactPath
				})
			}
		}
		input.appendOutput(`\n[upload ${result.success ? 'done' : 'failed'}]\n`)
		return
	}

	const result = await runTerminalProjectUpload(
		input.core,
		context.runtimeInfo,
		context.projectPath,
		context.target,
		context.code
	)
	input.appendUploadProgress(result.progressEvents)
	input.appendBuildLogs('upload', result.logs, result.stdout, result.stderr, result.success)
	input.appendUploadSummary({
		success: result.success,
		port: result.port,
		steps: result.steps,
		progressEvents: result.progressEvents,
		stdout: result.stdout,
		error: result.error,
		errorCode: result.errorCode,
		artifactPath: result.artifactPath
	})
}
