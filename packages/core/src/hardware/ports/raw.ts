import { createRequire } from 'node:module'

import type { HardwareRawSerialPortItem, HardwareSerialPlatform } from './types'

const require = createRequire(import.meta.url)

/**
 * 加载 `serialport` 模块。
 */
export const loadHardwareSerialportModule = (): {
	SerialPort?: { list: () => Promise<Array<HardwareRawSerialPortItem>> }
} | null => {
	try {
		return require('serialport') as { SerialPort?: { list: () => Promise<Array<HardwareRawSerialPortItem>> } }
	} catch {
		return null
	}
}

/**
 * 解析当前宿主平台。
 */
export const resolveHardwareSerialPlatform = (): HardwareSerialPlatform =>
	process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

/**
 * 读取宿主原始串口列表。
 */
export const listHardwareRawSerialPorts = async (): Promise<Array<HardwareRawSerialPortItem>> => {
	const serialport = loadHardwareSerialportModule()
	if (!serialport?.SerialPort?.list) return []
	return serialport.SerialPort.list()
}
