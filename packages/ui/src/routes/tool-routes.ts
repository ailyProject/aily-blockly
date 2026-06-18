import { Routes } from '@angular/router'

import { MigrationPageComponent } from '@/pages/migration/migration-page.component'

export const toolRoutes: Routes = [
	{
		path: 'serial-monitor',
		component: MigrationPageComponent,
		data: {
			title: 'Serial Monitor',
			domain: 'ui.tools',
			summary: 'Serial console, quick send, and chart-capable monitor UI are pending migration.',
			legacyHint: 'legacy: tools/serial-monitor'
		}
	},
	{
		path: 'child-tool/:toolId',
		component: MigrationPageComponent,
		data: {
			title: 'Child Tool Host',
			domain: 'ui.tools',
			summary: 'Embedded child tool routing, iframe host, and bridge context are pending migration.',
			legacyHint: 'legacy: tools/child-tool-host'
		}
	},
	{
		path: 'ffs-manager',
		component: MigrationPageComponent,
		data: {
			title: 'Flash FS Manager',
			domain: 'ui.tools',
			summary: 'Filesystem manager and ESP transport UI still need migration.',
			legacyHint: 'legacy: tools/ffs-manager'
		}
	},
	{
		path: 'aily-chat',
		loadComponent: () => import('@/pages/agent/agent-page.component').then(module => module.AgentPageComponent)
	},
	{
		path: 'simulator',
		component: MigrationPageComponent,
		data: {
			title: 'Simulator',
			domain: 'ui.tools',
			summary: 'Simulation surface and hardware preview tooling are still pending migration.',
			legacyHint: 'legacy: tools/simulator'
		}
	},
	{
		path: 'model-store',
		component: MigrationPageComponent,
		data: {
			title: 'Model Store',
			domain: 'ui.tools',
			summary: 'Model marketplace and asset browser are still pending migration.',
			legacyHint: 'legacy: tools/model-store'
		}
	}
]
