import { createAilyCoreServiceAddress } from 'shared'

import { writeDesktopStartupLog } from '../../app/log'
import { readDesktopCoreServiceHealth, waitForDesktopCoreServiceHealthy } from './health'
import { createDesktopCoreServiceChild, resolveDesktopCoreServiceEntrypoint } from './process'

import type { UtilityProcess } from 'electron'
import type { AilyCoreServiceRuntimeStatus } from 'shared'
import type { DesktopCoreServiceManager, DesktopCoreServiceManagerOptions } from '../types'

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
			writeDesktopStartupLog(`[core-service] start-begin ${address.baseUrl}`)
			if (await waitForDesktopCoreServiceHealthy(address, { timeoutMs: 1_000, intervalMs: 0 })) {
				writeDesktopStartupLog('[core-service] already-healthy')
				return address
			}

			if (!child) {
				writeDesktopStartupLog('[core-service] spawn-child')
				child = createDesktopCoreServiceChild(address, {
					entry: resolveDesktopCoreServiceEntrypoint(options.entryOverride)
				})
			}

			const healthy = await waitForDesktopCoreServiceHealthy(address, {
				timeoutMs: options.startupTimeoutMs,
				intervalMs: options.healthcheckIntervalMs
			})
			if (healthy) {
				writeDesktopStartupLog('[core-service] start-healthy')
				return address
			}

			writeDesktopStartupLog('[core-service] start-timeout')
			throw new Error(`Core service failed to start before timeout: ${address.healthUrl}`)
		},
		stop: async () => {
			if (!child) return
			child.kill()
			child = null
		},
		isRunning: () => child !== null,
		getStatus: async (): Promise<AilyCoreServiceRuntimeStatus> => {
			const health = await readDesktopCoreServiceHealth(address.healthUrl)

			return {
				managed: child !== null,
				reachable: health !== null,
				health,
				address
			}
		}
	}
}
