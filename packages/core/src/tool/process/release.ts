import { acquireChildToolHost } from './acquire'
import { childToolSessions } from './shared'

import type { ChildToolDiscoveryOptions } from '../types'

/**
 * 释放子工具宿主会话。
 * @param options - 子工具释放输入
 */
export const releaseChildToolHost = async (options: { toolId: string }) => {
	const session = childToolSessions.get(options.toolId)
	if (!session) return

	session.refCount = Math.max(0, session.refCount - 1)
	if (session.refCount > 0) return

	session.process?.kill()
	childToolSessions.delete(options.toolId)
}

/**
 * 重启子工具宿主会话。
 * @param options - 子工具重启输入
 */
export const restartChildToolHost = async (options: { toolId: string } & ChildToolDiscoveryOptions) => {
	await releaseChildToolHost({ toolId: options.toolId })
	return acquireChildToolHost(options)
}
