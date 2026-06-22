import { spawn } from 'node:child_process'

import { parseHardwareUploadProgressLine } from '../progress'

import type { HardwareUploadCommandStep, HardwareUploadProgressEvent } from '../types'

const wrapHardwareUploadCommand = (command: string) => (/\s/.test(command) ? `"${command}"` : command)

/**
 * 运行中的上传子进程引用。
 */
export let currentUploadChild: ReturnType<typeof spawn> | null = null

/**
 * 当前上传是否已被请求取消。
 */
export let currentUploadCancelled = false

/**
 * 写入当前上传取消标记。
 * @param cancelled - 新的取消状态
 */
export const setCurrentUploadCancelled = (cancelled: boolean) => {
	currentUploadCancelled = cancelled
}

/**
 * 杀掉当前上传子进程。
 */
export const killCurrentUploadChild = () => {
	if (!currentUploadChild) {
		return { success: false }
	}

	currentUploadChild.kill('SIGTERM')
	return { success: true }
}

/**
 * 执行单个上传步骤，并从 stdout/stderr 中提取结构化进度事件。
 * @param step - 当前上传步骤
 */
export const runHardwareUploadStep = (step: HardwareUploadCommandStep) =>
	new Promise<{ stdout: string; stderr: string; exitCode: number; progressEvents: Array<HardwareUploadProgressEvent> }>(
		(resolve, reject) => {
			const child = spawn(wrapHardwareUploadCommand(step.command), step.args, {
				cwd: step.cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: true
			})
			currentUploadChild = child
			let stdout = ''
			let stderr = ''
			let stdoutLineBuffer = ''
			let stderrLineBuffer = ''
			const progressEvents: Array<HardwareUploadProgressEvent> = []
			const collectProgress = (bufferValue: string, chunkText: string) => {
				const nextBuffer = bufferValue + chunkText
				const lines = nextBuffer.split(/\r?\n/)
				const rest = lines.pop() || ''
				for (const line of lines) {
					const event = parseHardwareUploadProgressLine(step.label, line)
					if (event) progressEvents.push(event)
				}
				return rest
			}

			child.stdout?.on('data', chunk => {
				const text = chunk.toString()
				stdout += text
				stdoutLineBuffer = collectProgress(stdoutLineBuffer, text)
			})
			child.stderr?.on('data', chunk => {
				const text = chunk.toString()
				stderr += text
				stderrLineBuffer = collectProgress(stderrLineBuffer, text)
			})
			child.on('error', reject)
			child.on('close', exitCode => {
				if (currentUploadChild === child) {
					currentUploadChild = null
				}
				for (const trailingLine of [stdoutLineBuffer, stderrLineBuffer]) {
					const event = parseHardwareUploadProgressLine(step.label, trailingLine)
					if (event) progressEvents.push(event)
				}
				resolve({ stdout, stderr, exitCode: exitCode ?? 1, progressEvents })
			})
		}
	)
