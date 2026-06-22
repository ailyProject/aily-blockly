import { spawn } from 'node:child_process'

import { parseProjectLibraryProgressEvents } from './progress'
import {
	beginProjectBlocklyLibraryActionStatus,
	finishProjectBlocklyLibraryActionStatus,
	updateProjectBlocklyLibraryActionStatus
} from './status'

import type { ProjectBlocklyLibraryMutationResult } from '../types'

/**
 * 在当前项目目录执行包管理命令。
 * @param input - 命令参数
 */
export const runProjectPackageManagerCommand = (input: {
	projectPath: string
	command: string
	args: Array<string>
	action: ProjectBlocklyLibraryMutationResult['action']
	packageName: string
	version?: string
	successMessage: string
}) =>
	new Promise<ProjectBlocklyLibraryMutationResult>((resolve, reject) => {
		beginProjectBlocklyLibraryActionStatus({
			projectPath: input.projectPath,
			packageName: input.packageName,
			action: input.action
		})

		const child = spawn(input.command, argsWithColor(input.args), {
			cwd: input.projectPath,
			env: {
				...process.env,
				FORCE_COLOR: '1'
			},
			stdio: ['ignore', 'pipe', 'pipe']
		})

		let stdout = ''
		let stderr = ''
		const syncActionStatus = () =>
			updateProjectBlocklyLibraryActionStatus({
				projectPath: input.projectPath,
				packageName: input.packageName,
				action: input.action,
				stdout,
				stderr,
				progressEvents: parseProjectLibraryProgressEvents(stdout, stderr)
			})
		child.stdout?.on('data', chunk => {
			stdout += chunk.toString()
			syncActionStatus()
		})
		child.stderr?.on('data', chunk => {
			stderr += chunk.toString()
			syncActionStatus()
		})
		child.on('error', reject)
		child.on('close', exitCode => {
			const normalizedExitCode = exitCode ?? 1
			const success = normalizedExitCode === 0
			const result = {
				success,
				action: input.action,
				projectPath: input.projectPath,
				packageName: input.packageName,
				...(input.version ? { version: input.version } : {}),
				stdout,
				stderr,
				exitCode: normalizedExitCode,
				progressEvents: parseProjectLibraryProgressEvents(stdout, stderr),
				message: success ? input.successMessage : stderr.trim() || stdout.trim() || `${input.action} failed`
			} satisfies ProjectBlocklyLibraryMutationResult
			finishProjectBlocklyLibraryActionStatus(result)
			resolve(result)
		})
	})

const argsWithColor = (args: Array<string>) => [...args]
