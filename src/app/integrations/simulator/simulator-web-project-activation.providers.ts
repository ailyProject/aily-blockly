import { InjectionToken } from '@angular/core';
import type { SimulatorProjectActivationPort } from './simulator-web-project-activation';

/** The owning application explicitly supplies its real activation source.
 * Normal Blockly binds its original ProjectService with useExisting; a Browser
 * workspace host supplies the same structural port. Missing configuration
 * remains unavailable without loading a desktop service from this token. */
export const SIMULATOR_WEB_PROJECT_ACTIVATION = new InjectionToken<SimulatorProjectActivationPort | null>(
  'SIMULATOR_WEB_PROJECT_ACTIVATION', {
    providedIn: 'root',
    factory: () => null,
  });
