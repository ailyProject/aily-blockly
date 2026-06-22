import {
	ApplicationConfig,
	ENVIRONMENT_INITIALIZER,
	inject,
	provideBrowserGlobalErrorListeners,
	provideZonelessChangeDetection
} from '@angular/core'
import { provideRouter, Router } from '@angular/router'

import { provideAgentApi } from './agent-api'
import { routes } from './app.routes'
import {
	initializeDesktopCoreBridge,
	initializeDesktopPendingProjectOpen,
	initializeStoredProjectSession
} from './utils/desktop'

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideZonelessChangeDetection(),
		provideRouter(routes),
		{
			provide: ENVIRONMENT_INITIALIZER,
			multi: true,
			useValue: () => {
				initializeDesktopCoreBridge()
				const router = inject(Router)
				void initializeDesktopPendingProjectOpen(router).then(openedByDesktop => {
					if (!openedByDesktop) {
						void initializeStoredProjectSession(router)
					}
				})
			}
		},
		provideAgentApi()
	]
}
