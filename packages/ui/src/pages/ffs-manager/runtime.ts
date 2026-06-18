import { config } from '@/workspace'

import type { Core } from '@/core-service'
import type { FfsManagerState } from './types'

const flashFsPort = 'COM9'

/**
 * 加载 Flash FS 页面状态。
 * @param {Core} core - core 服务句柄
 * @returns {Promise<FfsManagerState>}
 */
export const loadFfsManagerState = async (core: Core): Promise<FfsManagerState> => {
	const [configSummary, connect] = await Promise.all([
		core.config.get.query({ config }),
		core.config.buildSerialConnectOptions.query({ config, port: flashFsPort })
	])

	return {
		serial: {
			port: configSummary.serialMonitor.port ?? 'unset',
			baudRate: configSummary.serialMonitor.baudRate
		},
		connect
	}
}
