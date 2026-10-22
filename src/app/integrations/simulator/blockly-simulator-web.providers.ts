import { DestroyRef, InjectionToken, inject, makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import { ProjectService } from '@domain/project/public-api';
import { SimulatorHostProviderProductService } from './simulator-host-provider-product.service';
import { SIMULATOR_WEB_PROJECT_ACTIVATION } from './simulator-web-project-activation.providers';
import { SIMULATOR_WEB_PROJECT_PUBLICATION } from './simulator-web-app.providers';
import { createBlocklySimulatorWebPublication, type BlocklySimulatorWebDeployment } from './blockly-simulator-web-publication';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { readReadyBlocklySimulatorContext } from './blockly-simulator-web-readiness';

/** A trusted app/DI input, deliberately absent in an unconfigured installation.
 * Neither project content, iframe messages, URL parameters nor login fill it. */
export const BLOCKLY_SIMULATOR_WEB_DEPLOYMENT = new InjectionToken<BlocklySimulatorWebDeployment | null>(
  'BLOCKLY_SIMULATOR_WEB_DEPLOYMENT', { providedIn: 'root', factory: () => null });

/** Wire the actual owning application once. Native keeps its registered
 * provider; Browser borrows a separate scope from the exact same constructor. */
export function provideBlocklySimulatorWebProject(): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: SIMULATOR_WEB_PROJECT_PUBLICATION, useFactory: () => {
      const deployment = inject(BLOCKLY_SIMULATOR_WEB_DEPLOYMENT);
      if (!deployment) return null;
      // Existing application project-input composition supplies ProjectService
      // for Electron. A Browser/Coder owner needs its own publication adapter;
      // it must never be paired with this desktop Blockly file authority.
      if (inject(SIMULATOR_WEB_PROJECT_ACTIVATION) !== inject(ProjectService)) return null;
      const product = inject(SimulatorHostProviderProductService);
      const blockly = inject(BlocklyService);
      const publication = createBlocklySimulatorWebPublication({ deployment,
        openCurrentProjectScope: signal => product.openCurrentProjectScope(signal),
        // Retain the original generator and this exact SDK callback Authority.
        readContext: (scope, signal) => readReadyBlocklySimulatorContext(scope, blockly, signal),
      });
      inject(DestroyRef).onDestroy(() => { void publication.close().catch(() => { /* Keep original scope responsibility. */ }); });
      return publication;
    } },
  ]);
}
