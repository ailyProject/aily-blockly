import { config } from '@/workspace'

import { getFfsPreviewMode } from './utils/explorer'

import type { Core } from '@/utils/core'
import type { FfsManagerState } from './types'

/**
 * 加载 Flash FS 页面状态。
 * @param core - core 服务句柄
 */
export const loadFfsManagerState = async (core: Core): Promise<FfsManagerState> => {
	const [configSummary, serialPorts] = await Promise.all([
		core.config.get.query({ config }),
		core.hardware.listSerialPorts.query()
	])
	const availablePorts = serialPorts.ports.map(port => port.name || '').filter(Boolean)
	const portPath = configSummary.serialMonitor.port || availablePorts[0] || ''
	const connect = await core.config.buildSerialConnectOptions.query({ config, port: portPath })
	const requestedBaudRate = Number.parseInt(configSummary.serialMonitor.baudRate, 10) || connect.baudRate
	const [baud, preview] = await Promise.all([
		core.ffs.resolveBaud.query({ portPath, requestedBaud: requestedBaudRate }),
		core.ffs.getPreviewSnapshot.query()
	])

	return {
		serial: {
			port: portPath || 'unset',
			baudRate: configSummary.serialMonitor.baudRate
		},
		connect,
		baud: {
			requestedBaudRate: baud.requested,
			resolvedBaudRate: baud.baud,
			capped: baud.capped,
			bridgeName: baud.bridge?.productName ?? baud.bridge?.vendorName ?? 'unknown'
		},
		serialPortCount: serialPorts.ports.length,
		preview: {
			partition: preview.partition,
			type: preview.type,
			partitionLabel: preview.partition.label,
			blockSize: preview.blockSize,
			fileCount: preview.fileCount,
			capacityBytes: preview.usage?.capacityBytes ?? null,
			usedBytes: preview.usage?.usedBytes ?? null,
			attemptCount: 1,
			attemptReasons: preview.files.length === 0 ? ['blank-image-init'] : ['mounted'],
			files: preview.files.map(item => ({
				name: item.name || item.path || 'unknown',
				fullPath: item.path || '/',
				type: item.type,
				sizeText: item.sizeText,
				size: item.size,
				previewMode: getFfsPreviewMode(item.path || item.name || '')
			}))
		}
	}
}
