import type { WorkspaceEmbedTarget } from './types'

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
