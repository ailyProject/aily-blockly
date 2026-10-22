import { makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import { ElectronService } from '@core/platform/public-api';
import { ProjectService } from '@domain/project/public-api';
import { SIMULATOR_WEB_PROJECT_ACTIVATION } from '../simulator/simulator-web-project-activation.providers';
import { BrowserProjectInputService } from './browser-project-input.service';

/** Explicit owning-application choice. Desktop retains its original service;
 * Web accepts whichever real workspace owner is bound, including Blockly. */
export function provideBrowserProjectInput(): EnvironmentProviders {
  return makeEnvironmentProviders([{
    provide: SIMULATOR_WEB_PROJECT_ACTIVATION,
    useFactory: (electron: ElectronService, native: ProjectService, browser: BrowserProjectInputService) =>
      electron.isElectron ? native : browser,
    deps: [ElectronService, ProjectService, BrowserProjectInputService],
  }]);
}
