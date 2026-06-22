import { bootstrapApplication } from '@angular/platform-browser'

import { App } from './app'
import { appConfig } from './config'

bootstrapApplication(App, appConfig).catch(err => console.error(err))
