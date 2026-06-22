export const primaryRouteLinks = [
	{ href: '/main/guide', label: 'Guide', detail: 'workspace overview and onboarding path' },
	{
		href: '/main/project-open',
		label: 'Project Open',
		detail: 'open an existing project directory and restore session context'
	},
	{ href: '/main/project-new', label: 'Project New', detail: 'new project flow and save presets' },
	{ href: '/main/playground', label: 'Playground', detail: 'examples, subject lists, and experiments' },
	{ href: '/main/blockly-editor', label: 'Blockly Editor', detail: 'visual editor shell and right tools' },
	{ href: '/main/code-editor', label: 'Code Editor', detail: 'generated code and build diagnostics' },
	{
		href: '/main/lib-manager',
		label: 'Lib Manager',
		detail: 'declared Blockly libraries, missing packages, and restore actions'
	}
]

export const utilityRouteLinks = [
	{ href: '/aily-chat', label: 'Aily Chat', detail: 'AI SDK Angular route already wired to core API' },
	{ href: '/cloud-space', label: 'Cloud Space', detail: 'public, template, and personal cloud project workflows' },
	{ href: '/serial-monitor', label: 'Serial Monitor', detail: 'device console and quick send runtime' },
	{ href: '/terminal', label: 'Terminal', detail: 'PTY-backed shell, live build, and live upload orchestration' },
	{ href: '/ffs-manager', label: 'Flash FS', detail: 'filesystem manager and transport bridge' },
	{ href: '/model-store', label: 'Model Store', detail: 'catalog browsing, detail preview, and deploy entry' },
	{ href: '/model-train', label: 'Model Train', detail: 'vision training and project persistence' },
	{ href: '/model-deploy', label: 'Model Deploy', detail: 'deployment wizard and runtime checks' }
]
