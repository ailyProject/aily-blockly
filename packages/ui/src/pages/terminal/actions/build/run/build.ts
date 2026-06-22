import { getCurrentProjectPath, getCurrentProjectSourceCode } from '@/runtime/project-session'

import { runTerminalProjectBuild, runTerminalProjectBuildLive } from '../../../runtime'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { TerminalPageSignals } from '../../../utils/types'
import type { createTerminalBuildPreviewActions } from '../preview'

const shouldSkipLiveBuildFallback = (output: string, exitCode: number | null) =>
	exitCode === 130 || output.includes('\u0003') || /\^c/i.test(output) || /cancel/i.test(output)

/**
 * 创建 terminal 的当前 build 动作。
 * @param input - 依赖、预览动作与输出动作
 */
export const createTerminalCurrentBuildActions = (input: {
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
}) => ({
	async runCurrentBuild() {
		const runtimeInfo = input.signals.runtimeInfo()
		const projectPath = getCurrentProjectPath()
		const sessionId = input.signals.session()?.id
		if (!runtimeInfo || !projectPath) return

		input.signals.actionBusy.set(true)
		input.signals.actionKind.set('build')
		try {
			const code = getCurrentProjectSourceCode()
			await input.previewActions.appendBuildPlanPreview(projectPath, code)
			if (input.desktop && sessionId) {
				input.appendOutput('\n[build live session]\n')
				const result = await runTerminalProjectBuildLive({
					core: input.core,
					desktop: input.desktop,
					sessionId,
					runtimeInfo,
					projectPath,
					code
				})
				input.appendOutput(
					`[preprocess exit] ${result.preprocessResult.exitCode ?? 'unknown'}${result.preprocessResult.timedOut ? ' (timed out)' : ''}\n`
				)
				if (result.compileResult) {
					input.appendOutput(
						`[compile exit] ${result.compileResult.exitCode ?? 'unknown'}${result.compileResult.timedOut ? ' (timed out)' : ''}\n`
					)
				}
				if (!result.success) {
					const combinedOutput = `${result.preprocessResult.output}\n${result.compileResult?.output ?? ''}`
					const finalExitCode = result.compileResult?.exitCode ?? result.preprocessResult.exitCode
					if (!shouldSkipLiveBuildFallback(combinedOutput, finalExitCode)) {
						input.appendOutput('\n[build fallback core diagnostics]\n')
						const fallbackResult = await runTerminalProjectBuild(input.core, runtimeInfo, projectPath, code)
						input.appendBuildLogs(
							'build',
							fallbackResult.logs,
							fallbackResult.stdout,
							fallbackResult.stderr,
							fallbackResult.success
						)
					}
				}
				input.appendOutput(`\n[build ${result.success ? 'done' : 'failed'}]\n`)
				return
			}

			const result = await runTerminalProjectBuild(input.core, runtimeInfo, projectPath, code)
			input.appendBuildLogs('build', result.logs, result.stdout, result.stderr, result.success)
		} catch (error) {
			input.appendOutput(`\n[build error]\n${error instanceof Error ? error.message : String(error)}\n`)
		} finally {
			input.signals.actionKind.set('')
			input.signals.actionBusy.set(false)
		}
	}
})
