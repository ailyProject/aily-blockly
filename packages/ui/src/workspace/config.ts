import type { AilyAgentConfig, AilyAppConfig, AppRegistryItem } from 'shared'

export const agentConfig: AilyAgentConfig = {
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

export const config: AilyAppConfig = {
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

export const recentProject = {
	name: 'Vision Station',
	path: '/Users/workspace/projects/vision-station'
}

export const toolbarApps: Array<AppRegistryItem> = [
	{ id: 'aily-chat', enabled: true, lock: true, router: ['/main/blockly-editor'] },
	{ id: 'cloud-space', enabled: true, router: ['/main/blockly-editor'] },
	{ id: 'terminal', enabled: true, router: ['/main/blockly-editor'] },
	{ id: 'serial-monitor', enabled: true, router: ['/main/blockly-editor'], core: ['esp32', 'renesas'] },
	{ id: 'flash-fs', enabled: true, router: ['/main/blockly-editor'] },
	{ id: 'dev-tool', enabled: true, dev: true, router: ['/main/blockly-editor'] }
]

export const configMutationInput = {
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
