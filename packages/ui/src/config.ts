import {
	ApplicationConfig,
	ENVIRONMENT_INITIALIZER,
	inject,
	provideBrowserGlobalErrorListeners,
	provideZonelessChangeDetection
} from '@angular/core'
import { provideRouter, Router } from '@angular/router'

import { routes } from './routes'
import { provideAgentApi } from './utils/chat'
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
