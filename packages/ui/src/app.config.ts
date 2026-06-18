import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core'
import { provideRouter } from '@angular/router'

import { provideAgentApi } from './agent-api'
import { routes } from './app.routes'
import { provideCore } from './core-service'
import { provideDesktop, provideDesktopCoreServiceBridge } from './desktop-service'

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideZonelessChangeDetection(),
		provideRouter(routes),
		provideDesktop(),
		provideDesktopCoreServiceBridge(),
		provideCore(),
		provideAgentApi()
	]
}
