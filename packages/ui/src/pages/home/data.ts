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
	{ title: 'Workspace', detail: 'blocks, code generation, assets', tone: 'default' as const },
	{ title: 'Boards', detail: 'switch board, libraries, playground', tone: 'secondary' as const },
	{ title: 'Panes', detail: 'right tools, bottom logs, shell layout', tone: 'outline' as const }
]
