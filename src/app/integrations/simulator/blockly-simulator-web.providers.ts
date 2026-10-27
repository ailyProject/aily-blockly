import { DestroyRef, InjectionToken, inject, makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import { ProjectService } from '@domain/project/public-api';
import { BuilderService } from '@domain/build/public-api';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router } from '@angular/router';
import { SimulatorHostProviderProductService } from './simulator-host-provider-product.service';
import { SIMULATOR_WEB_PROJECT_ACTIVATION } from './simulator-web-project-activation.providers';
import { SIMULATOR_WEB_PROJECT_PUBLICATION } from './simulator-web-app.providers';
import { createBlocklySimulatorWebPublication, type BlocklySimulatorWebDeployment } from './blockly-simulator-web-publication';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { readReadyBlocklySimulatorContext } from './blockly-simulator-web-readiness';
import { createBlocklySimulatorPrewarmTrigger } from './blockly-simulator-web-prewarm';

/** A trusted app/DI input, deliberately absent in an unconfigured installation.
 * Neither project content, iframe messages, URL parameters nor login fill it. */
export const BLOCKLY_SIMULATOR_WEB_DEPLOYMENT = new InjectionToken<BlocklySimulatorWebDeployment | null>(
  'BLOCKLY_SIMULATOR_WEB_DEPLOYMENT', { providedIn: 'root', factory: () => null });

/** Resolve only after the original Electron initializer selected its real
 * project activation port. This token reuses the publication singleton. */
export const BLOCKLY_SIMULATOR_WEB_PREWARM = new InjectionToken('BLOCKLY_SIMULATOR_WEB_PREWARM', {
  providedIn: 'root', factory: () => inject(SIMULATOR_WEB_PROJECT_PUBLICATION),
});

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
      const project = inject(ProjectService);
      if (inject(SIMULATOR_WEB_PROJECT_ACTIVATION) !== project) return null;
      const product = inject(SimulatorHostProviderProductService);
      const blockly = inject(BlocklyService);
      const publication = createBlocklySimulatorWebPublication({ deployment,
        openCurrentProjectScope: signal => product.openCurrentProjectScope(signal),
        // Retain the original generator and this exact SDK callback Authority.
        readContext: (scope, signal) => readReadyBlocklySimulatorContext(scope, blockly, signal),
      });
      const router = inject(Router), builder = inject(BuilderService);
      let navigating = false;
      const trigger = createBlocklySimulatorPrewarmTrigger({
        readSelection() {
          if (navigating || !router.url.startsWith('/main/blockly-editor') || project.isProjectOpening
            || project.isAilyCodeProject(project.currentProjectPath)) return null;
          const captured = project.captureCurrentProjectActivation(), code = blockly.getReusableGeneratedCode();
          if (!captured || code === null) return null;
          captured.requireCurrent();
          return { captured, revision: blockly.getWorkspaceContentRevision(), code };
        },
        prepare: (captured, signal) => publication.preparePublication(captured, signal),
      });
      const subscriptions = new Set<{ unsubscribe(): void }>();
      const invalidate = () => { void trigger.invalidate().catch(() => { /* Same pending handle retains cleanup. */ }); };
      const refresh = () => { invalidate(); trigger.notify(); };
      subscriptions.add(project.projectActivation$.subscribe(refresh));
      subscriptions.add(project.projectOpeningChanged$.subscribe(refresh));
      subscriptions.add(project.stateSubject.subscribe(() => trigger.notify()));
      subscriptions.add(blockly.workspaceContentRevisionChanged$.subscribe(invalidate));
      subscriptions.add(blockly.codeSubject.subscribe(() => trigger.notify()));
      subscriptions.add(builder.buildFinishedSubject.subscribe(event => {
        if (!event.projectPath || event.projectPath !== project.currentProjectPath) return;
        invalidate(); if (event.success) trigger.notify();
      }));
      subscriptions.add(router.events.subscribe(event => {
        if (event instanceof NavigationStart) { navigating = true; invalidate(); }
        else if (event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError) {
          navigating = false; trigger.notify();
        }
      }));
      let closing: Promise<void> | null = null;
      const facade = Object.freeze({
        readPresentation: publication.readPresentation?.bind(publication),
        readPublication: publication.readPublication.bind(publication),
        readPreparedPublication: trigger.readPreparedPublication,
        close(): Promise<void> {
          if (closing) return closing;
          const failures: unknown[] = [];
          for (const subscription of [...subscriptions]) {
            try { subscription.unsubscribe(); subscriptions.delete(subscription); } catch (error) { failures.push(error); }
          }
          const task = Promise.allSettled([trigger.close(), publication.close()]).then(results => {
            for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
            if (failures.length) throw new AggregateError(failures, 'Blockly publication trigger cleanup remains unconfirmed.');
          }).finally(() => { if (closing === task) closing = null; });
          closing = task; return task;
        },
        snapshot: () => ({ ...publication.snapshot(), prewarm: trigger.snapshot() }),
      });
      inject(DestroyRef).onDestroy(() => { void facade.close().catch(() => { /* Keep original scope responsibility. */ }); });
      trigger.notify();
      return facade;
    } },
  ]);
}
