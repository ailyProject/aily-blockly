import { Routes } from '@angular/router'

export const routes: Routes = [
	{
		path: '',
		loadComponent: () => import('@ui/pages/home/home-page.component').then(module => module.HomePageComponent)
	}
]
