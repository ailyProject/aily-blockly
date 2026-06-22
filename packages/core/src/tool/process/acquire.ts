import { resolveChildToolRuntimeConfig } from '../discovery'
import { ensureChildToolSession } from './shared'
import { startChildToolProcess } from './start'

import type { ChildToolDiscoveryOptions, ChildToolHostInfo } from '../types'

/**
 * 启动并获取子工具宿主信息。
 * @param options - 子工具启动输入
 */
export const acquireChildToolHost = async (
	options: { toolId: string } & ChildToolDiscoveryOptions
): Promise<ChildToolHostInfo> => {
	const config = resolveChildToolRuntimeConfig(options.toolId, options)
	if (!config) {
		throw new Error(`Child tool is not available: ${options.toolId}`)
	}

	const session = ensureChildToolSession(options.toolId)
	session.refCount += 1

	if (session.hostInfo) return session.hostInfo
	if (!session.startPromise) {
		session.startPromise = startChildToolProcess(config, session).finally(() => {
			session.startPromise = null
		})
	}

	return session.startPromise
}
