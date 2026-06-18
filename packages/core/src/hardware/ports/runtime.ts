import { createRequire } from 'node:module'

import { normalizeHardwareSerialPorts } from './normalize'

import type { HardwareRawSerialPortItem, HardwareSerialListResult, HardwareSerialPlatform } from './types'

const require = createRequire(import.meta.url)

const resolveHardwareSerialPlatform = (): HardwareSerialPlatform =>
	process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

const loadSerialportModule = (): { SerialPort?: { list: () => Promise<Array<HardwareRawSerialPortItem>> } } | null => {
	try {
		return require('serialport') as { SerialPort?: { list: () => Promise<Array<HardwareRawSerialPortItem>> } }
	} catch {
		return null
	}
}

/**
 * 获取宿主串口列表。
 * @returns {Promise<HardwareSerialListResult>}
 */
export const listHardwareSerialPorts = async (): Promise<HardwareSerialListResult> => {
	const platform = resolveHardwareSerialPlatform()
	const serialport = loadSerialportModule()

	if (!serialport?.SerialPort?.list) {
		return {
			available: false,
			platform,
			ports: [],
			error: 'serialport package is unavailable'
		}
	}

	try {
		const ports = await serialport.SerialPort.list()
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
