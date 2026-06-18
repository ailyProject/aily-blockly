import type { HardwareRawSerialPortItem, HardwareSerialPlatform, HardwareSerialPortItem } from './types'

const bluetoothKeywords = ['蓝牙', 'ble', 'bluetooth']
const usbKeywords = ['usb', 'serial', 'uart', 'ftdi', 'ch340', 'cp210x']

const includesAnyKeyword = (value: string, keywords: Array<string>) =>
	keywords.some(keyword => value.toLowerCase().includes(keyword.toLowerCase()))

/**
 * 判断端口类型是否应按串口处理。
 * @param {string | null | undefined} type - 端口类型
 * @returns {boolean}
 */
export const isHardwareSerialPortType = (type: string | null | undefined) => !type || type === 'serial'

/**
 * 规范化 Windows 串口列表。
 * @param {Array<HardwareRawSerialPortItem>} ports - 原始串口列表
 * @returns {Array<HardwareSerialPortItem>}
 */
export const normalizeWindowsSerialPorts = (ports: Array<HardwareRawSerialPortItem>): Array<HardwareSerialPortItem> =>
	ports.map(item => {
		const friendlyName = String(item.friendlyName || item.manufacturer || item.path || '').replace(/ \(COM\d+\)$/, '')
		return {
			name: typeof item.path === 'string' ? item.path : '',
			text: friendlyName,
			type: 'serial',
			icon: includesAnyKeyword(String(item.friendlyName || ''), bluetoothKeywords)
				? 'fa-light fa-bluetooth'
				: 'fa-light fa-usb-drive'
		}
	})

/**
 * 规范化 macOS 串口列表。
 * @param {Array<HardwareRawSerialPortItem>} ports - 原始串口列表
 * @returns {Array<HardwareSerialPortItem>}
 */
export const normalizeMacosSerialPorts = (ports: Array<HardwareRawSerialPortItem>): Array<HardwareSerialPortItem> =>
	ports.map(item => {
		const rawPath = typeof item.path === 'string' ? item.path : ''
		const devicePath = rawPath.replace('/dev/tty.', '/dev/cu.')
		const friendlyName =
			typeof item.manufacturer === 'string' && item.manufacturer.length > 0
				? item.manufacturer
				: devicePath.replace('/dev/cu.usbserial-', '').replace('/dev/cu.', '')

		return {
			name: devicePath,
			text: friendlyName,
			type: 'serial',
			icon: includesAnyKeyword(devicePath, usbKeywords) ? 'fa-light fa-usb-drive' : 'fa-light fa-computer'
		}
	})

/**
 * 规范化 Linux 串口列表。
 * @param {Array<HardwareRawSerialPortItem>} ports - 原始串口列表
 * @returns {Array<HardwareSerialPortItem>}
 */
export const normalizeLinuxSerialPorts = (ports: Array<HardwareRawSerialPortItem>): Array<HardwareSerialPortItem> =>
	ports.map(item => ({
		name: typeof item.path === 'string' ? item.path : '',
		text: String(item.manufacturer || item.path || ''),
		type: 'serial',
		icon: 'fa-light fa-usb-drive'
	}))

/**
 * 按平台规范化串口列表。
 * @param {HardwareSerialPlatform} platform - 宿主平台
 * @param {Array<HardwareRawSerialPortItem>} ports - 原始串口列表
 * @returns {Array<HardwareSerialPortItem>}
 */
export const normalizeHardwareSerialPorts = (
	platform: HardwareSerialPlatform,
	ports: Array<HardwareRawSerialPortItem>
): Array<HardwareSerialPortItem> => {
	if (platform === 'windows') return normalizeWindowsSerialPorts(ports)
	if (platform === 'macos') return normalizeMacosSerialPorts(ports)
	if (platform === 'linux') return normalizeLinuxSerialPorts(ports)

	return ports.map(item => ({
		port: item,
		name: typeof item.path === 'string' ? item.path : '',
		text: String(item.friendlyName || item.manufacturer || item.path || ''),
		type: 'serial'
	}))
}
