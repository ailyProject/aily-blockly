import { Routes } from '@angular/router'

import { MainPageComponent } from '@/pages/main/main-page.component'
import { MigrationPageComponent } from '@/pages/migration/migration-page.component'

export const mainRoutes: Routes = [
	{
		path: 'main',
		component: MainPageComponent,
		children: [
			{ path: '', redirectTo: 'guide', pathMatch: 'full' },
			{
				path: 'guide',
				loadComponent: () => import('@/pages/home/home-page.component').then(module => module.HomePageComponent)
			},
			{
				path: 'project-new',
				component: MigrationPageComponent,
				data: {
					title: 'Project New',
					domain: 'ui.project',
					summary: 'Project creation flow, save path presets, and board bootstrapping are pending migration.',
					legacyHint: 'legacy: pages/project-new + windows/project-new'
				}
			},
			{
				path: 'playground',
				component: MigrationPageComponent,
				data: {
					title: 'Playground',
					domain: 'ui.playground',
					summary: 'Example catalog, subject pages, and legacy playground flows still need migration.',
					legacyHint: 'legacy: pages/playground'
				}
			},
			{
				path: 'blockly-editor',
				component: MigrationPageComponent,
				data: {
					title: 'Blockly Editor',
					domain: 'ui.editor',
					summary: 'Main visual editor shell, block workspace, and tool integration are still being migrated.',
					legacyHint: 'legacy: editors/blockly-editor'
				}
			},
			{
				path: 'code-editor',
				component: MigrationPageComponent,
				data: {
					title: 'Code Editor',
					domain: 'ui.editor',
					summary: 'Generated code editor, diagnostics, and build panel still need migration.',
					legacyHint: 'legacy: editors/code-editor'
				}
			}
		]
	}
]
