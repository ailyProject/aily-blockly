import { Routes } from '@angular/router'

import { MigrationPageComponent } from '@/pages/migration/component'

export const windowRoutes: Routes = [
	{
		path: 'project-new',
		loadComponent: () => import('@/pages/project-new/component').then(module => module.ProjectNewPageComponent)
	},
	{
		path: 'settings',
		loadComponent: () => import('@/pages/settings/component').then(module => module.SettingsPageComponent)
	},
	{
		path: 'about',
		loadComponent: () => import('@/pages/about/component').then(module => module.AboutPageComponent)
	},
	{
		path: 'iframe',
		component: MigrationPageComponent,
		data: {
			title: 'Iframe Tool Window',
			domain: 'ui.window',
			summary: 'Iframe-hosted tool window integration is still pending migration.',
			legacyHint: 'legacy: windows/iframe'
		}
	},
	{
		path: 'graph-editor',
		component: MigrationPageComponent,
		data: {
			title: 'Graph Editor',
			domain: 'ui.editor',
			summary: 'Connection graph editor and themed viewer are pending migration.',
			legacyHint: 'legacy: editors/graph-editor'
		}
	},
	{
		path: 'model-train',
		component: MigrationPageComponent,
		data: {
			title: 'Model Train',
			domain: 'ui.window',
			summary: 'Vision training flows and related project handling are pending migration.',
			legacyHint: 'legacy: windows/model-train'
		}
	},
	{
		path: 'model-deploy',
		component: MigrationPageComponent,
		data: {
			title: 'Model Deploy',
			domain: 'ui.window',
			summary: 'Deployment wizard and SSCMA-specific flows are pending migration.',
			legacyHint: 'legacy: windows/model-deploy'
		}
	}
]
