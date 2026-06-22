import { Routes } from '@angular/router'

import { MainPageComponent } from '@/pages/main/component'

export const mainRoutes: Routes = [
	{
		path: 'main',
		component: MainPageComponent,
		children: [
			{ path: '', redirectTo: 'guide', pathMatch: 'full' },
			{
				path: 'guide',
				loadComponent: () => import('@/pages/guide/component').then(module => module.GuidePageComponent)
			},
			{
				path: 'project-open',
				loadComponent: () => import('@/pages/project-open/component').then(module => module.ProjectOpenPageComponent)
			},
			{
				path: 'project-new',
				loadComponent: () => import('@/pages/project-new/component').then(module => module.ProjectNewPageComponent)
			},
			{
				path: 'playground',
				loadComponent: () => import('@/pages/playground/component').then(module => module.PlaygroundPageComponent),
				children: [
					{ path: '', redirectTo: 'list', pathMatch: 'full' },
					{
						path: 'list',
						loadComponent: () =>
							import('@/pages/playground/list/component').then(module => module.PlaygroundListPageComponent)
					},
					{
						path: 's/:name',
						loadComponent: () =>
							import('@/pages/playground/subject/component').then(module => module.PlaygroundSubjectPageComponent)
					}
				]
			},
			{
				path: 'blockly-editor',
				loadComponent: () =>
					import('@/pages/blockly-editor/component').then(module => module.BlocklyEditorPageComponent)
			},
			{
				path: 'code-editor',
				loadComponent: () => import('@/pages/code-editor/component').then(module => module.CodeEditorPageComponent)
			},
			{
				path: 'lib-manager',
				loadComponent: () => import('@/pages/lib-manager/component').then(module => module.LibManagerPageComponent)
			}
		]
	}
]
