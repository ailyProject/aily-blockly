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
  BLOCKLY_GENERATED_CODE_PORT,
  BLOCKLY_LIVE_EDITOR_PORT,
  AUTOMATION_UI_PORT,
  BlocklyLiveOperationBridgeService,
} from '@integration/automation/public-api';
import { BlocklyEditorAutomationAdapter } from './integrations/blockly/blockly-editor-automation.adapter';
import { AutomationUiAdapter } from './integrations/automation/automation-ui.adapter';
import { ActionService } from '@core/app-shell/public-api';
import { BUILD_ACTION_PORT, BUILD_APPLICATION_PORT } from '@domain/build/public-api';
import { DEPENDENCY_APPLICATION_PORT } from '@domain/dependencies/public-api';
import { DEVICE_APPLICATION_PORT } from '@domain/device/public-api';
import { PROJECT_APPLICATION_PORT } from '@domain/project/public-api';
import { BuildApplicationAdapter } from './integrations/build/build-application.adapter';
import { DependencyApplicationAdapter } from './integrations/dependencies/dependency-application.adapter';
import { DeviceApplicationAdapter } from './integrations/device/device-application.adapter';
import { ProjectApplicationAdapter } from './integrations/project/project-application.adapter';
import { SUBAPP_AUTOMATION_PORT } from '@integration/subapps/public-api';
import { SubappAutomationAdapter } from './integrations/subapps/subapp-automation.adapter';
import { SimulatorHostProviderProductService } from './integrations/simulator/simulator-host-provider-product.service';

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
    {
      provide: BLOCKLY_GENERATED_CODE_PORT,
      useExisting: BlocklyEditorAutomationAdapter,
    },
    {
      provide: BLOCKLY_LIVE_EDITOR_PORT,
      useExisting: BlocklyEditorAutomationAdapter,
    },
    {
      provide: AUTOMATION_UI_PORT,
      useExisting: AutomationUiAdapter,
    },
    {
      provide: BUILD_ACTION_PORT,
      useExisting: ActionService,
    },
    {
      provide: BUILD_APPLICATION_PORT,
      useExisting: BuildApplicationAdapter,
    },
    {
      provide: DEPENDENCY_APPLICATION_PORT,
      useExisting: DependencyApplicationAdapter,
    },
    {
      provide: DEVICE_APPLICATION_PORT,
      useExisting: DeviceApplicationAdapter,
    },
    {
      provide: PROJECT_APPLICATION_PORT,
      useExisting: ProjectApplicationAdapter,
    },
    {
      provide: SUBAPP_AUTOMATION_PORT,
      useExisting: SubappAutomationAdapter,
    },
    provideAppInitializer(() => {
      inject(BlocklyLiveOperationBridgeService).ensureInitialized();
      inject(SimulatorHostProviderProductService).ensureRegistered();
    }),
  ]
};
