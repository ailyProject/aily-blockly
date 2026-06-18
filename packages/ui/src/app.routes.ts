import { Routes } from '@angular/router'

export const routes: Routes = [
	{
		path: '',
		loadComponent: () => import('@/pages/home/home-page.component').then(module => module.HomePageComponent)
	},
	{
		path: 'agent',
		loadComponent: () => import('@/pages/agent/agent-page.component').then(module => module.AgentPageComponent)
	}
]
