import { ApplicationConfig, importProvidersFrom, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideTranslateService } from "@ngx-translate/core";
import { routes } from './app.routes';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { authInterceptor } from './interceptors/auth.interceptor';
import { retryInterceptor } from './interceptors/retry.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ 
      eventCoalescing: true,
      runCoalescing: true
    }),
    provideRouter(routes, 
      withHashLocation()
    ),
    provideTranslateService(),
    provideHttpClient(
      withInterceptors([authInterceptor, retryInterceptor])
    ),
    provideAnimations(),
    importProvidersFrom(NzModalModule)
  ]
};
