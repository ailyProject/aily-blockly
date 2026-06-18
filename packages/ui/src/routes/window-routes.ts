import { Routes } from '@angular/router'

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
		loadComponent: () => import('@/pages/iframe/component').then(module => module.IframePageComponent)
	},
	{
		path: 'graph-editor',
		loadComponent: () => import('@/pages/graph-editor/component').then(module => module.GraphEditorPageComponent)
	},
	{
		path: 'model-train',
		loadComponent: () => import('@/pages/model-train/component').then(module => module.ModelTrainPageComponent),
		children: [
			{
				path: 'vision',
				loadComponent: () =>
					import('@/pages/model-train/vision/component').then(module => module.VisionTrainPageComponent)
			},
			{
				path: 'vision/classification',
				loadComponent: () =>
					import('@/pages/model-train/classification/component').then(module => module.ClassificationTrainPageComponent)
			},
			{
				path: 'vision/detection',
				loadComponent: () =>
					import('@/pages/model-train/detection/component').then(module => module.DetectionTrainPageComponent)
			}
		]
	},
	{
		path: 'model-deploy',
		loadComponent: () => import('@/pages/model-deploy/component').then(module => module.ModelDeployPageComponent),
		children: [
			{
				path: '',
				loadComponent: () =>
					import('@/pages/model-deploy/sscma/component').then(module => module.SscmaDeployPageComponent)
			},
			{
				path: 'sscma',
				loadComponent: () =>
					import('@/pages/model-deploy/sscma/component').then(module => module.SscmaDeployPageComponent)
			},
			{
				path: 'sscma/test',
				loadComponent: () =>
					import('@/pages/model-deploy/sscma-test/component').then(module => module.SscmaTestPageComponent)
			}
		]
	}
]
