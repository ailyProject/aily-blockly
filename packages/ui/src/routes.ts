import { Routes } from '@angular/router'

import { mainRoutes } from '@/routes/main-routes'
import { toolRoutes } from '@/routes/tool-routes'
import { windowRoutes } from '@/routes/window-routes'

export const routes: Routes = [
	{ path: '', redirectTo: 'main', pathMatch: 'full' },
	...mainRoutes,
	...toolRoutes,
	...windowRoutes,
	{
		path: 'lab/home',
		loadComponent: () => import('@/pages/home/component').then(module => module.HomePageComponent)
	},
	{
		path: 'lab/agent',
		loadComponent: () => import('@/pages/agent/component').then(module => module.AgentPageComponent)
	}
]
