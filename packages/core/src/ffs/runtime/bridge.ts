import { listHardwareRawSerialPorts } from '../../hardware/ports'

import type { FfsBridgeLookupResult, FfsBridgeVendorInfo, FfsResolvedBaudrate, FfsSupportedBaudrate } from './types'

export const SUPPORTED_FFS_BAUDRATES: Array<FfsSupportedBaudrate> = [115200, 230400, 460800, 921600, 1500000, 2000000]
export const DEFAULT_FFS_ROM_BAUD = 115200
export const DEFAULT_FFS_FLASH_BAUD = 921600

const USB_BRIDGE_CAPABILITIES: Record<number, FfsBridgeVendorInfo> = {
	0x1a86: {
		vendorName: 'QinHeng Electronics',
		products: {
			0x7522: { name: 'CH340', maxBaudrate: 460800 },
			0x7523: { name: 'CH340', maxBaudrate: 460800 },
			0x7584: { name: 'CH340', maxBaudrate: 460800 },
			0x5523: { name: 'CH341', maxBaudrate: 2000000 },
			0x55d3: { name: 'CH343', maxBaudrate: 6000000 },
			0x55d4: { name: 'CH9102', maxBaudrate: 6000000 },
			0x55d8: { name: 'CH9101', maxBaudrate: 3000000 }
		}
	},
	0x10c4: {
		vendorName: 'Silicon Labs',
		products: {
			0xea60: { name: 'CP2102(n)', maxBaudrate: 3000000 },
			0xea70: { name: 'CP2105', maxBaudrate: 2000000 },
			0xea71: { name: 'CP2108', maxBaudrate: 2000000 }
		}
	},
	0x0403: {
		vendorName: 'FTDI',
		products: {
			0x6001: { name: 'FT232R', maxBaudrate: 3000000 },
			0x6010: { name: 'FT2232', maxBaudrate: 3000000 },
			0x6011: { name: 'FT4232', maxBaudrate: 3000000 },
			0x6014: { name: 'FT232H', maxBaudrate: 12000000 },
			0x6015: { name: 'FT230X', maxBaudrate: 3000000 }
		}
	},
	0x303a: {
		vendorName: 'Espressif Systems',
		products: {
			0x0002: { name: 'ESP32-S2 Native USB', maxBaudrate: 2000000 },
			0x1000: { name: 'ESP32 Native USB', maxBaudrate: 2000000 },
			0x1001: { name: 'ESP32 Native USB', maxBaudrate: 2000000 },
			0x1002: { name: 'ESP32 Native USB', maxBaudrate: 2000000 },
			0x4002: { name: 'ESP32 Native USB (CDC)', maxBaudrate: 2000000 }
		}
	}
}

const parseUsbId = (raw: unknown) => {
	if (raw == null) return undefined
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw

	const text = String(raw).trim()
	if (!text) return undefined

	const cleaned = text.replace(/^0x/i, '')
	const value = Number.parseInt(cleaned, 16)
	return Number.isFinite(value) ? value : undefined
}

/**
 * 根据 VID/PID 查找 USB 串口桥接芯片信息。
 * @param vid - USB Vendor ID
 * @param pid - USB Product ID
 */
export const getFfsUsbBridgeInfo = (vid: number, pid: number): FfsBridgeLookupResult | undefined => {
	const vendor = USB_BRIDGE_CAPABILITIES[vid]
	if (!vendor) return undefined

	const product = vendor.products[pid]
	if (!product) return { vendorName: vendor.vendorName }

	return {
		vendorName: vendor.vendorName,
		productName: product.name,
		maxBaudrate: product.maxBaudrate
	}
}

/**
 * 通过串口路径查找 USB 串口桥接芯片信息。
 * @param portPath - 串口路径
 */
export const lookupFfsBridgeByPath = async (portPath: string) => {
	const ports = await listHardwareRawSerialPorts()
	const entry = ports.find(item => item.path === portPath)
	if (!entry) return {}

	const vid = parseUsbId(entry.vendorId)
	const pid = parseUsbId(entry.productId)
	if (vid === undefined || pid === undefined) return { vid, pid }

	return {
		vid,
		pid,
		bridge: getFfsUsbBridgeInfo(vid, pid)
	}
}

/**
 * 根据桥接芯片能力对请求波特率做钳制。
 * @param requestedBaud - 用户请求的波特率
 * @param bridge - 已识别的桥接芯片
 */
export const capFfsBaudrate = (
	requestedBaud: number,
	bridge?: FfsBridgeLookupResult
): Pick<FfsResolvedBaudrate, 'baud' | 'capped' | 'requested' | 'bridge'> => {
	const requested = requestedBaud || DEFAULT_FFS_FLASH_BAUD
	const maxBaudrate = bridge?.maxBaudrate
	if (maxBaudrate && requested > maxBaudrate) {
		const baud = SUPPORTED_FFS_BAUDRATES.filter(rate => rate <= maxBaudrate).pop() ?? DEFAULT_FFS_FLASH_BAUD
		return { baud, capped: true, requested, bridge }
	}

	return { baud: requested, capped: false, requested, bridge }
}

/**
 * 一步完成串口桥接芯片探测与波特率解析。
 * @param portPath - 串口路径
 * @param requestedBaud - 用户请求的波特率
 */
export const resolveFfsBaudrate = async (portPath: string, requestedBaud: number): Promise<FfsResolvedBaudrate> => {
	const { bridge, vid, pid } = await lookupFfsBridgeByPath(portPath)
	return {
		...capFfsBaudrate(requestedBaud, bridge),
		vid,
		pid
	}
}
