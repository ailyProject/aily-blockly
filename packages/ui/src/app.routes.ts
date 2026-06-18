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
		path: 'lab/agent',
		loadComponent: () => import('@/pages/agent/agent-page.component').then(module => module.AgentPageComponent)
	}
]
