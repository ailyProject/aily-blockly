import { Routes } from '@angular/router'

import { MigrationPageComponent } from '@/pages/migration/migration-page.component'

export const windowRoutes: Routes = [
	{
		path: 'project-new',
		component: MigrationPageComponent,
		data: {
			title: 'Project New Window',
			domain: 'ui.window',
			summary: 'Detached project creation window and modal flow still need migration.',
			legacyHint: 'legacy: windows/project-new'
		}
	},
	{
		path: 'settings',
		component: MigrationPageComponent,
		data: {
			title: 'Settings',
			domain: 'ui.window',
			summary: 'Settings window, region switching, and update preferences are still pending migration.',
			legacyHint: 'legacy: windows/settings'
		}
	},
	{
		path: 'about',
		component: MigrationPageComponent,
		data: {
			title: 'About',
			domain: 'ui.window',
			summary: 'About dialog, version details, and links are pending migration.',
			legacyHint: 'legacy: windows/about'
		}
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
