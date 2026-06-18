import { Routes } from '@angular/router'

export const toolRoutes: Routes = [
	{
		path: 'serial-monitor',
		loadComponent: () => import('@/pages/serial-monitor/component').then(module => module.SerialMonitorPageComponent)
	},
	{
		path: 'child-tool/:toolId',
		loadComponent: () => import('@/pages/child-tool/component').then(module => module.ChildToolPageComponent)
	},
	{
		path: 'ffs-manager',
		loadComponent: () => import('@/pages/ffs-manager/component').then(module => module.FfsManagerPageComponent)
	},
	{
		path: 'aily-chat',
		loadComponent: () => import('@/pages/agent/component').then(module => module.AgentPageComponent)
	},
	{
		path: 'simulator',
		loadComponent: () => import('@/pages/simulator/component').then(module => module.SimulatorPageComponent)
	},
	{
		path: 'model-store',
		loadComponent: () => import('@/pages/model-store/component').then(module => module.ModelStorePageComponent)
	}
]
