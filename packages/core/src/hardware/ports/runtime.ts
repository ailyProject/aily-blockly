import { normalizeHardwareSerialPorts } from './normalize'
import { listHardwareRawSerialPorts, loadHardwareSerialportModule, resolveHardwareSerialPlatform } from './raw'

import type { HardwareRawSerialPortItem, HardwareSerialListResult, HardwareSerialPlatform } from './types'

/**
 * 获取宿主串口列表。
 */
export const listHardwareSerialPorts = async (): Promise<HardwareSerialListResult> => {
	const platform = resolveHardwareSerialPlatform()
	const serialport = loadHardwareSerialportModule()

	if (!serialport?.SerialPort?.list) {
		return {
			available: false,
			platform,
			ports: [],
			error: 'serialport package is unavailable'
		}
	}

	try {
		const ports = await listHardwareRawSerialPorts()
		return {
			available: true,
			platform,
			ports: normalizeHardwareSerialPorts(platform, ports)
		}
	} catch (error) {
		return {
			available: false,
			platform,
			ports: [],
			error: (error as Error).message
		}
	}
}
