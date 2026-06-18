import { config } from '@/workspace'

import type { Core } from '@/core-service'
import type { FfsManagerState } from './types'

const flashFsPort = 'COM9'

/**
 * 加载 Flash FS 页面状态。
 * @param core - core 服务句柄
 */
export const loadFfsManagerState = async (core: Core): Promise<FfsManagerState> => {
	const [configSummary, connect, serialPorts] = await Promise.all([
		core.config.get.query({ config }),
		core.config.buildSerialConnectOptions.query({ config, port: flashFsPort }),
		core.hardware.listSerialPorts.query()
	])
	const portPath = configSummary.serialMonitor.port || flashFsPort
	const requestedBaudRate = Number.parseInt(configSummary.serialMonitor.baudRate, 10) || connect.baudRate
	const baud = await core.ffs.resolveBaud.query({ portPath, requestedBaud: requestedBaudRate })

	return {
		serial: {
			port: configSummary.serialMonitor.port ?? 'unset',
			baudRate: configSummary.serialMonitor.baudRate
		},
		connect,
		baud: {
			requestedBaudRate: baud.requested,
			resolvedBaudRate: baud.baud,
			capped: baud.capped,
			bridgeName: baud.bridge?.productName ?? baud.bridge?.vendorName ?? 'unknown'
		},
		serialPortCount: serialPorts.ports.length
	}
}
