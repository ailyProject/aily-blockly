import { spawn } from 'node:child_process'

import type { ProjectBuildCommand, ProjectBuildLog } from '../types'

/**
 * 当前运行中的构建子进程。
 */
export let currentBuildChild: ReturnType<typeof spawn> | null = null

/**
 * 当前构建是否已被请求取消。
 */
export let currentBuildCancelled = false

/**
 * 更新当前构建取消标记。
 * @param cancelled - 新的取消状态
 */
export const setCurrentBuildCancelled = (cancelled: boolean) => {
	currentBuildCancelled = cancelled
}

/**
 * 执行单个构建命令并收集 stdout/stderr。
 * @param command - 构建命令
 */
export const runProjectBuildCommand = (command: ProjectBuildCommand) =>
	new Promise<ProjectBuildLog & { exitCode: number }>((resolve, reject) => {
		const child = spawn(command.executable, command.args, {
			cwd: command.cwd,
			stdio: ['ignore', 'pipe', 'pipe']
		})
		currentBuildChild = child

		let stdout = ''
		let stderr = ''

		child.stdout?.on('data', chunk => {
			stdout += chunk.toString()
		})
		child.stderr?.on('data', chunk => {
			stderr += chunk.toString()
		})
		child.on('error', reject)
		child.on('close', exitCode => {
			if (currentBuildChild === child) {
				currentBuildChild = null
			}
			resolve({
				step: command.label,
				stdout,
				stderr,
				exitCode: exitCode ?? 1
			})
		})
	})

/**
 * 取消当前正在执行的项目构建。
 */
export const cancelProjectBuild = () => {
	setCurrentBuildCancelled(true)
	if (!currentBuildChild) {
		return { success: false }
	}

	currentBuildChild.kill('SIGTERM')
	return { success: true }
}
