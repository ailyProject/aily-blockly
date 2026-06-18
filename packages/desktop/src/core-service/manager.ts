import { createRequire } from 'node:module'
import path from 'node:path'
import { utilityProcess } from 'electron'
import { createAilyCoreServiceAddress } from 'shared'

import type { UtilityProcess } from 'electron'
import type { AilyCoreServiceHealth, AilyCoreServiceRuntimeStatus } from 'shared'
import type { DesktopCoreServiceManager, DesktopCoreServiceManagerOptions } from './types'

const require = createRequire(import.meta.url)
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_HEALTHCHECK_INTERVAL_MS = 250

const sleep = async (timeout: number) => {
	await new Promise(resolve => setTimeout(resolve, timeout))
}

const isServiceHealthy = async (healthUrl: string) => {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 1_000)

	try {
		const response = await fetch(healthUrl, { signal: controller.signal })
		return response.ok
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}

const readServiceHealth = async (healthUrl: string): Promise<AilyCoreServiceHealth | null> => {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 1_000)

	try {
		const response = await fetch(healthUrl, { signal: controller.signal })
		if (!response.ok) return null
		return (await response.json()) as AilyCoreServiceHealth
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}

const resolveStandaloneEntrypoint = (entryOverride?: string) => {
	if (entryOverride) return entryOverride

	const rpcEntrypoint = require.resolve('core/rpc')
	return path.resolve(path.dirname(rpcEntrypoint), '../rpc-standalone/index.js')
}

/**
 * 创建桌面壳内的 Core 服务管理器
 * @param options - 启动与轮询选项
 */
export const createDesktopCoreServiceManager = (
	options: DesktopCoreServiceManagerOptions = {}
): DesktopCoreServiceManager => {
	const address = createAilyCoreServiceAddress(options)
	let child: UtilityProcess | null = null

	return {
		address,
		start: async () => {
			if (await isServiceHealthy(address.healthUrl)) {
				return address
			}

			if (!child) {
				child = utilityProcess.fork(resolveStandaloneEntrypoint(options.entryOverride), [], {
					env: {
						...process.env,
						AILY_CORE_SERVICE_HOST: address.host,
						AILY_CORE_SERVICE_PORT: String(address.port)
					}
				})
			}

			const deadline = Date.now() + (options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
			while (Date.now() < deadline) {
				if (await isServiceHealthy(address.healthUrl)) {
					return address
				}

				await sleep(options.healthcheckIntervalMs ?? DEFAULT_HEALTHCHECK_INTERVAL_MS)
			}

			throw new Error(`Core service failed to start before timeout: ${address.healthUrl}`)
		},
		stop: async () => {
			if (!child) return

			child.kill()
			child = null
		},
		isRunning: () => child !== null,
		getStatus: async (): Promise<AilyCoreServiceRuntimeStatus> => {
			const health = await readServiceHealth(address.healthUrl)

			return {
				managed: child !== null,
				reachable: health !== null,
				health,
				address
			}
		}
	}
}
