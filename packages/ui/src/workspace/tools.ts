import type { WorkspaceChildToolItem, WorkspaceEmbedTarget } from './types'

export const childTools: Array<WorkspaceChildToolItem> = [
	{
		id: 'mqtt-debugger',
		title: 'MQTT Debugger',
		summary: 'Inspect topic flow, payload direction, and cloud-side message state.',
		launchPath: '/child-tool/mqtt-debugger'
	},
	{
		id: 'network-debugger',
		title: 'Network Debugger',
		summary: 'Track connectivity checks, requests, and transport-level diagnostics.',
		launchPath: '/child-tool/network-debugger'
	},
	{
		id: 'industrial-bus-debugger',
		title: 'Industrial Bus Debugger',
		summary: 'Focus on field-bus capture, timing, and register-oriented diagnostics.',
		launchPath: '/child-tool/industrial-bus-debugger'
	},
	{
		id: 'ble-debugger',
		title: 'BLE Debugger',
		summary: 'Review BLE scan results, services, and characteristic payload exchange.',
		launchPath: '/child-tool/ble-debugger'
	},
	{
		id: 'ffs-manager-child',
		title: 'Flash FS Child',
		summary: 'Dedicated flash filesystem child tool host for embedded file transfers.',
		launchPath: '/child-tool/ffs-manager-child'
	}
]

export const embedTargets: Array<WorkspaceEmbedTarget> = [
	{
		id: 'connection-graph',
		title: 'Connection Graph',
		summary: 'Interactive graph canvas for device wiring and schematic preview.',
		url: 'https://tool.aily.pro/connection-graph?type=json'
	},
	{
		id: 'component-viewer',
		title: 'Component Viewer',
		summary: 'Renderable component explorer used by diagnostics and layout previews.',
		url: 'https://tool.aily.pro/component-viewer?type=json&theme=dark&lang=en'
	}
]
