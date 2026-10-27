import { InjectionToken, makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import type { SimulatorWebProductSource } from './simulator-web-product.service';

/** Only the trusted application composition supplies this source. A normal Web
 * route without that composition remains unavailable. */
export const SIMULATOR_WEB_PRODUCT_SOURCE = new InjectionToken<SimulatorWebProductSource | null>(
  'SIMULATOR_WEB_PRODUCT_SOURCE', { providedIn: 'root', factory: () => null });

export function provideSimulatorWebProduct(
  useFactory: (...dependencies: any[]) => SimulatorWebProductSource | null,
  deps: any[] = [],
): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: SIMULATOR_WEB_PRODUCT_SOURCE, useFactory, deps }]);
}
