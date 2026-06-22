export const primaryRouteLinks = [
	{ href: '/main/guide', label: 'Guide', detail: 'start page, onboarding, and recent projects', exact: true },
	{ href: '/main/project-open', label: 'Open', detail: 'open an existing workspace', exact: true },
	{ href: '/main/project-new', label: 'New', detail: 'create a new board project', exact: true },
	{ href: '/main/playground', label: 'Playground', detail: 'examples and subjects', exact: false },
	{ href: '/main/blockly-editor', label: 'Blockly', detail: 'visual programming workspace', exact: true },
	{ href: '/main/code-editor', label: 'Code', detail: 'code build and upload', exact: true },
	{ href: '/main/lib-manager', label: 'Library', detail: 'library management and recovery', exact: true }
]

export const utilityRouteLinks = [
	{ href: '/aily-chat', label: 'Chat', detail: 'AI assistant workspace' },
	{ href: '/serial-monitor', label: 'Serial', detail: 'device console and quick send' },
	{ href: '/terminal', label: 'Terminal', detail: 'build output and shell session' },
	{ href: '/ffs-manager', label: 'Flash FS', detail: 'filesystem manager' },
	{ href: '/model-store', label: 'Model Store', detail: 'catalog browsing and deploy entry' },
	{ href: '/cloud-space', label: 'Cloud', detail: 'template and personal cloud projects' },
	{ href: '/model-train', label: 'Train', detail: 'vision training workflows' },
	{ href: '/model-deploy', label: 'Deploy', detail: 'model deployment wizard' }
]

export const footerRouteLinks = [
	{ href: '/settings', label: 'Settings' },
	{ href: '/about', label: 'About' }
]
