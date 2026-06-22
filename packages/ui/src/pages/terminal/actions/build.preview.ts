import {
	formatTerminalCommandPreview,
	planTerminalBleUpload,
	planTerminalProjectBuild,
	planTerminalProjectUpload
} from '../runtime'

import type { Core } from '@/utils/core'
import type { TerminalPageSignals } from '../component.types'
import type { TerminalUploadTargetOption } from '../types'

/**
 * 创建 terminal 的 build/upload 计划预览动作。
 * @param input - core 依赖、terminal 状态与输出动作
 */
export const createTerminalBuildPreviewActions = (input: {
	core: Core
	signals: TerminalPageSignals
	appendOutput: (text: string) => void
}) => ({
	async appendBuildPlanPreview(projectPath: string, code?: string) {
		const runtimeInfo = input.signals.runtimeInfo()
		if (!runtimeInfo) return

		const plan = await planTerminalProjectBuild(input.core, runtimeInfo, projectPath, code)
		input.appendOutput('\n[build plan]\n')
		input.appendOutput(
			`[preprocess] ${formatTerminalCommandPreview(plan.preprocessCommand.executable, plan.preprocessCommand.args)}\n`
		)
		input.appendOutput(
			`[compile] ${formatTerminalCommandPreview(plan.compileCommand.executable, plan.compileCommand.args)}\n`
		)
	},
	async appendUploadPlanPreview(projectPath: string, target: TerminalUploadTargetOption, code?: string) {
		const runtimeInfo = input.signals.runtimeInfo()
		if (!runtimeInfo) return null

		if (target.portType === 'ble' && target.deviceId) {
			const plan = await planTerminalBleUpload(input.core, runtimeInfo, projectPath, code, target.deviceId)
			input.appendOutput('\n[upload plan]\n')
			input.appendOutput(`[target] ${target.label}\n`)
			input.appendOutput('[channel] ble\n')
			input.appendOutput(`[message] ${plan.message}\n`)
			input.appendOutput(`[ready] ${plan.ready ? 'yes' : 'no'}\n`)
			if (plan.artifactPath) {
				input.appendOutput(`[artifact] ${plan.artifactPath}\n`)
			}
			input.appendOutput(`[packet size] ${plan.packetSize}\n`)
			input.appendOutput(`[packet count] ${plan.packetCount}\n`)
			return plan
		}

		const prepared = await planTerminalProjectUpload(input.core, runtimeInfo, projectPath, target, code)
		input.appendOutput('\n[upload plan]\n')
		input.appendOutput(`[target] ${target.label}\n`)
		input.appendOutput(`[status] ${prepared.status}\n`)
		input.appendOutput(`[message] ${prepared.message}\n`)
		if (prepared.builtBeforeUpload) {
			input.appendOutput('[prebuild] upload preparation rebuilt project artifacts\n')
		}
		if (prepared.port) {
			input.appendOutput(`[port] ${prepared.port}\n`)
		}
		if (prepared.artifactPath) {
			input.appendOutput(`[artifact] ${prepared.artifactPath}\n`)
		}
		if (prepared.step) {
			input.appendOutput(
				`[${prepared.step.label}] ${formatTerminalCommandPreview(prepared.step.command, prepared.step.args)}\n`
			)
		}
		if (prepared.buildLogs.length) {
			input.appendOutput('\n[upload prebuild logs]\n')
			for (const log of prepared.buildLogs) {
				input.appendOutput(`[step:${log.step}]\n`)
				const body = log.stdout || log.stderr || 'No step output.'
				for (const line of body.split(/\r?\n/).filter(Boolean)) {
					input.appendOutput(`${line}\n`)
				}
			}
		}
		return prepared
	}
})
