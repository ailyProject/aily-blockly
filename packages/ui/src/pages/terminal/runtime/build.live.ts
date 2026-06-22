import { planTerminalProjectUpload } from './build.plan'
import { formatTerminalCommandPreview } from './format'
import { executeTerminalCommand } from './session'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { TerminalUploadTargetOption } from '../types'

/**
 * 在当前 terminal 会话中执行 live build。
 * @param input - core/desktop 依赖、session 与项目上下文
 */
export const runTerminalProjectBuildLive = async (input: {
	core: Core
	desktop: NonNullable<Desktop>
	sessionId: string
	runtimeInfo: DesktopHostRuntimeInfo
	projectPath: string
	code?: string
}) => {
	const plan = await input.core.build.prepareProjectBuild.mutate({
		projectPath: input.projectPath,
		appDataPath: input.runtimeInfo.appDataPath,
		childPath: input.runtimeInfo.childPath ?? '',
		code: input.code?.trim() ? input.code : undefined
	})

	const preprocessCommand = formatTerminalCommandPreview(plan.preprocessCommand.executable, plan.preprocessCommand.args)
	const preprocessResult = await executeTerminalCommand(input.desktop, input.sessionId, preprocessCommand, 1500)
	if (preprocessResult.timedOut || preprocessResult.exitCode !== 0) {
		return {
			success: false,
			plan,
			preprocessResult,
			compileResult: null
		}
	}

	const compileCommand = formatTerminalCommandPreview(plan.compileCommand.executable, plan.compileCommand.args)
	const compileResult = await executeTerminalCommand(input.desktop, input.sessionId, compileCommand, 1500)
	return {
		success: !compileResult.timedOut && compileResult.exitCode === 0,
		plan,
		preprocessResult,
		compileResult
	}
}

/**
 * 在当前 terminal 会话中执行 live upload。
 * @param input - core/desktop 依赖、session 与项目上下文
 */
export const runTerminalProjectUploadLive = async (input: {
	core: Core
	desktop: NonNullable<Desktop>
	sessionId: string
	runtimeInfo: DesktopHostRuntimeInfo
	projectPath: string
	target: TerminalUploadTargetOption
	code?: string
}) => {
	const prepared = await planTerminalProjectUpload(
		input.core,
		input.runtimeInfo,
		input.projectPath,
		input.target,
		input.code
	)
	if (!prepared.ready || !prepared.step) {
		return {
			success: false,
			prepared,
			result: null
		}
	}

	const command = formatTerminalCommandPreview(prepared.step.command, prepared.step.args)
	const result = await executeTerminalCommand(input.desktop, input.sessionId, command, 2000)
	return {
		success: !result.timedOut && result.exitCode === 0,
		prepared,
		result
	}
}
