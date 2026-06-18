import type { BoardIndexItem, LegacyBoardItem, LegacyLibraryItem } from '@core'
import type { LibraryIndexItem } from 'core/hardware'

export const boardIndex: Array<BoardIndexItem> = [
	{
		name: 'xiao-esp32s3',
		displayName: 'XIAO ESP32S3',
		brand: 'Seeed',
		type: 'board',
		architecture: 'xtensa',
		cores: 2,
		frequency: 240,
		frequencyUnit: 'MHz',
		flash: 8192,
		sram: 512,
		psram: 8192,
		connectivity: ['wifi', 'ble'],
		interfaces: ['i2c', 'spi', 'uart'],
		core: 'esp32',
		voltage: 3.3,
		tags: ['compact', 'wifi'],
		keywords: ['xiao', 'esp32', 's3'],
		description: 'Compact ESP32-S3 board for AI and IoT workflows.'
	},
	{
		name: 'uno-r4',
		displayName: 'Arduino UNO R4',
		brand: 'Arduino',
		type: 'board',
		architecture: 'renesas',
		cores: 1,
		frequency: 48,
		frequencyUnit: 'MHz',
		flash: 256,
		sram: 32,
		psram: 0,
		connectivity: ['usb'],
		interfaces: ['i2c', 'spi', 'uart'],
		core: 'renesas',
		voltage: 5,
		tags: ['classic', 'education'],
		keywords: ['uno', 'r4', 'arduino'],
		description: 'Next-generation UNO board with classic shield compatibility.'
	}
]

export const legacyBoards: Array<LegacyBoardItem> = [
	{
		name: 'xiao-esp32s3',
		nickname: 'Seeed XIAO ESP32S3',
		displayName: 'XIAO ESP32S3',
		description: 'ESP32-S3 board for compact builds.'
	},
	{
		name: 'uno-r4',
		nickname: 'UNO R4',
		displayName: 'Arduino UNO R4',
		description: 'Classic Arduino board with refreshed silicon.'
	}
]

export const legacyLibraries: Array<LegacyLibraryItem> = [
	{
		name: '@aily-project/lib-oled-ssd1306',
		nickname: 'SSD1306 OLED',
		description: 'OLED display driver library.',
		keywords: ['oled', 'ssd1306', 'display']
	},
	{
		name: '@aily-project/lib-rc522',
		nickname: 'RC522 RFID',
		description: 'RFID reader support for RC522 modules.',
		keywords: ['rc522', 'rfid', 'nfc']
	}
]

export const libraryIndex: Array<LibraryIndexItem> = [
	{
		name: '@aily-project/lib-oled-ssd1306',
		displayName: 'SSD1306 OLED',
		category: 'display',
		supportedCores: ['esp32'],
		communication: ['i2c'],
		voltage: [3.3],
		hardwareType: ['display'],
		compatibleHardware: ['xiao-esp32s3'],
		tags: ['oled', 'screen'],
		keywords: ['oled', 'ssd1306', 'display'],
		description: 'Small OLED display driver for I2C workflows.'
	},
	{
		name: '@aily-project/lib-rc522',
		displayName: 'RC522 RFID',
		category: 'wireless',
		supportedCores: ['esp32', 'renesas'],
		communication: ['spi'],
		voltage: [3.3, 5],
		hardwareType: ['sensor'],
		compatibleHardware: ['uno-r4', 'xiao-esp32s3'],
		tags: ['rfid', 'nfc'],
		keywords: ['rc522', 'rfid', 'reader'],
		description: 'RC522 RFID reader support for card and tag scenarios.'
	}
]
