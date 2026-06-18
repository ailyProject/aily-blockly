import { Routes } from '@angular/router'

import { MainPageComponent } from '@/pages/main/component'
import { MigrationPageComponent } from '@/pages/migration/component'

export const mainRoutes: Routes = [
	{
		path: 'main',
		component: MainPageComponent,
		children: [
			{ path: '', redirectTo: 'guide', pathMatch: 'full' },
			{
				path: 'guide',
				loadComponent: () => import('@/pages/home/component').then(module => module.HomePageComponent)
			},
			{
				path: 'project-new',
				loadComponent: () => import('@/pages/project-new/component').then(module => module.ProjectNewPageComponent)
			},
			{
				path: 'playground',
				loadComponent: () => import('@/pages/playground/component').then(module => module.PlaygroundPageComponent)
			},
			{
				path: 'blockly-editor',
				loadComponent: () =>
					import('@/pages/blockly-editor/component').then(module => module.BlocklyEditorPageComponent)
			},
			{
				path: 'code-editor',
				loadComponent: () => import('@/pages/code-editor/component').then(module => module.CodeEditorPageComponent)
			}
		]
	}
]
