import { spawn } from 'node:child_process'

import type { ChildToolHostInfo } from '../types'

export type ChildToolSession = {
	process: ReturnType<typeof spawn> | null
	startPromise: Promise<ChildToolHostInfo> | null
	hostInfo: ChildToolHostInfo | null
	refCount: number
	stdoutBuffer: string
	stderrBuffer: string
}

export const childToolSessions = new Map<string, ChildToolSession>()

/**
 * 读取或创建某个子工具的会话槽。
 * @param toolId - 子工具 ID
 */
export const ensureChildToolSession = (toolId: string) => {
	let session = childToolSessions.get(toolId)
	if (!session) {
		session = {
			process: null,
			startPromise: null,
			hostInfo: null,
			refCount: 0,
			stdoutBuffer: '',
			stderrBuffer: ''
		}
		childToolSessions.set(toolId, session)
	}

	return session
}

/**
 * 打印子工具普通日志。
 * @param toolId - 子工具 ID
 * @param stage - 当前阶段
 * @param detail - 附加信息
 */
export const logChildTool = (toolId: string, stage: string, detail?: unknown) => {
	console.log(`[child-tool:${toolId}] ${stage}`, detail ?? '')
}

/**
 * 打印子工具错误日志。
 * @param toolId - 子工具 ID
 * @param stage - 当前阶段
 * @param detail - 附加信息
 */
export const logChildToolError = (toolId: string, stage: string, detail?: unknown) => {
	console.error(`[child-tool:${toolId}] ${stage}`, detail ?? '')
}
