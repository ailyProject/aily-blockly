import {
	APP_INITIALIZER,
	ApplicationConfig,
	inject,
	provideBrowserGlobalErrorListeners,
	provideZonelessChangeDetection
} from '@angular/core'
import { provideRouter, Router } from '@angular/router'

import { routes } from './routes'
import { provideAgentApi } from './utils/chat'
import { initializeDesktopCoreBridge, initializeDesktopPendingProjectOpen } from './utils/desktop'

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideZonelessChangeDetection(),
		provideRouter(routes),
		{
			provide: APP_INITIALIZER,
			multi: true,
			useFactory: () => {
				const router = inject(Router)
				return async () => {
					await initializeDesktopCoreBridge()
					await initializeDesktopPendingProjectOpen(router)
				}
			}
		},
		provideAgentApi()
	]
}
