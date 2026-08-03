import { ApplicationConfig, importProvidersFrom, inject, provideAppInitializer, provideZoneChangeDetection } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideTranslateService } from "@ngx-translate/core";
import { routes } from './app.routes';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { authInterceptor } from './interceptors/auth.interceptor';
import { retryInterceptor } from './interceptors/retry.interceptor';
import {
  AILY_CHAT_RUNTIME_OWNER_PROVIDERS,
  AILY_CHAT_SHARED_PROVIDERS,
} from './tools/aily-chat/aily-chat.providers';
import { AilyChatHostInitializerService } from './tools/aily-chat/services/aily-chat-host-initializer.service';
import { BlocklyLiveOperationBridgeService } from './services/blockly-live-operation-bridge.service';
import { ChatRuntimeHostBootstrapService } from './tools/aily-chat/services/chat-runtime-host-bootstrap.service';
import { SimulatorHostProviderProductService } from './services/simulator-host-provider-product.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ 
      eventCoalescing: true,
      runCoalescing: true
    }),
    { provide: DOCUMENT, useFactory: () => document },
    provideRouter(routes,
      withHashLocation()
    ),
    provideTranslateService(),
    provideHttpClient(
      withInterceptors([authInterceptor, retryInterceptor])
    ),
    provideAnimations(),
    importProvidersFrom(NzModalModule),
    provideAppInitializer(() => {
      inject(AilyChatHostInitializerService).ensureInitialized();
      inject(BlocklyLiveOperationBridgeService).ensureInitialized();
      inject(SimulatorHostProviderProductService).ensureRegistered();
      void inject(ChatRuntimeHostBootstrapService).startHostRuntimeOwner().catch((error) => {
        console.error('[AilyChat][RuntimeOwnerHost] Failed to start app-scoped runtime owner:', error);
      });
    }),
    ...AILY_CHAT_SHARED_PROVIDERS,
    ...AILY_CHAT_RUNTIME_OWNER_PROVIDERS,
  ]
};
