import type { FfsBridgeVendorInfo, FfsSupportedBaudrate } from '../types'

export const SUPPORTED_FFS_BAUDRATES: Array<FfsSupportedBaudrate> = [115200, 230400, 460800, 921600, 1500000, 2000000]
export const DEFAULT_FFS_ROM_BAUD = 115200
export const DEFAULT_FFS_FLASH_BAUD = 921600

export const USB_BRIDGE_CAPABILITIES: Record<number, FfsBridgeVendorInfo> = {
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
