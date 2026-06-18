import type { BoardIndexItem, LegacyBoardItem, LegacyLibraryItem } from '@core'
import type { LibraryIndexItem } from 'core/hardware'
import type { AilyAgentConfig, AilyAppConfig, AppRegistryItem } from 'shared'

type BadgeTone = 'default' | 'secondary' | 'outline'

export const bottomTabItems = [
	{
		id: 'logs',
		title: 'Build Logs',
		items: ['board package resolved', 'workspace loaded', 'compiler task idle']
	},
	{
		id: 'terminal',
		title: 'Terminal',
		items: ['pnpm turbo run deps', 'ng build --configuration development', 'serial monitor waiting']
	}
]

export const inspectorCards = [
	{ title: 'Aily Chat', detail: 'structured tool loop and user approvals' },
	{ title: 'Serial Monitor', detail: 'device console, baud presets, chart hooks' },
	{ title: 'Flash FS', detail: 'filesystem content, partition map, upload flow' }
]

export const navigationCards = [
	{ title: 'Workspace', detail: 'blocks, code generation, assets', tone: 'default' as BadgeTone },
	{ title: 'Boards', detail: 'switch board, libraries, examples', tone: 'secondary' as BadgeTone },
	{ title: 'Panes', detail: 'right tools, bottom logs, shell layout', tone: 'outline' as BadgeTone }
]

export const seedBoardIndex: Array<BoardIndexItem> = [
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

export const seedLegacyBoards: Array<LegacyBoardItem> = [
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

export const seedLegacyLibraries: Array<LegacyLibraryItem> = [
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

export const seedLibraryIndex: Array<LibraryIndexItem> = [
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

export const seedAgentConfig: AilyAgentConfig = {
	useCustomApiKey: true,
	maxCount: 12,
	enabledTools: ['searchBoardsLibraries', 'readProjectFile'],
	disabledTools: ['dangerousShell'],
	agentTools: {
		mainAgent: {
			enabledTools: ['searchBoardsLibraries', 'readProjectFile'],
			disabledTools: ['dangerousShell']
		},
		schematicAgent: {
			enabledTools: ['searchBoardsLibraries'],
			disabledTools: []
		}
	},
	securityWorkspaces: {
		project: true,
		library: false
	},
	models: [
		{ model: 'gpt-5', name: 'GPT-5', family: 'openai', speed: 'fast', enabled: true },
		{
			model: 'custom-hw',
			name: 'Custom HW',
			family: 'custom',
			speed: 'balanced',
			enabled: true,
			isCustom: true,
			baseUrl: 'https://llm.example.com',
			apiKey: 'local-key'
		}
	]
}

export const seedAppConfig: AilyAppConfig = {
	lang: 'en_US',
	selectedLanguage: 'en',
	recentlyProjects: [
		{ name: 'Aily Blocks', path: '/Users/workspace/projects/aily-blocks' },
		{ name: 'Robot Arm', path: '/Users/workspace/projects/robot-arm' }
	],
	toolbarAppIds: ['aily-chat', 'serial-monitor', 'flash-fs'],
	skippedVersions: ['1.2.0'],
	aiChatMode: 'ask',
	aiChatModel: {
		model: 'missing-model',
		name: 'Missing Model',
		family: 'legacy',
		speed: 'slow',
		enabled: true
	},
	quickSendList: [
		{ name: 'DTR', type: 'signal', data: 'DTR' },
		{ name: 'Hello', type: 'text', data: 'hello from ui shell' }
	],
	serialMonitor: {
		port: 'COM3',
		baudRate: '115200',
		dataBits: '8',
		stopBits: '1',
		parity: 'none',
		flowControl: 'none'
	}
}

export const seedRecentProject = {
	name: 'Vision Station',
	path: '/Users/workspace/projects/vision-station'
}

export const seedToolbarApps: Array<AppRegistryItem> = [
	{ id: 'aily-chat', enabled: true, lock: true, router: ['/main/blockly-editor'] },
	{ id: 'serial-monitor', enabled: true, router: ['/main/blockly-editor'], core: ['esp32', 'renesas'] },
	{ id: 'flash-fs', enabled: true, router: ['/main/blockly-editor'] },
	{ id: 'dev-tool', enabled: true, dev: true, router: ['/main/blockly-editor'] }
]

export const seedAppConfigMutationInput = {
	versionToSkip: '1.3.0',
	themeMode: 'light' as const,
	aiChatMode: 'agent' as const,
	selectedLanguage: 'zh_cn',
	devmodeEnabled: true,
	devmodeAutoSave: false,
	toolbarAppIds: ['aily-chat', 'flash-fs'],
	quickSendList: [
		{ name: 'RST', type: 'signal' as const, data: 'RTS' },
		{ name: 'Ping', type: 'text' as const, data: 'ping from config update' }
	],
	serialMonitor: {
		port: 'COM9',
		baudRate: '921600'
	}
}
