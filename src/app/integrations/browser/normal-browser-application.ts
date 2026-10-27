import '@angular/compiler';
import 'zone.js';
import { Component, InjectionToken, createComponent, inject, provideZoneChangeDetection } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { BrowserProjectViewComponent } from '../coder/browser-project-view.component';
import { CODER_BROWSER_EMBED_CONFIGURATION, captureCoderBrowserEmbedConfiguration, type CoderBrowserEmbedConfiguration } from '../coder/coder-browser-embed.providers';
import { captureCurrentCoderBrowserDocumentClient, type CoderBrowserDocumentClient } from '../coder/coder-browser-document';
import { BrowserProjectInputService } from '../project/browser-project-input.service';
import { BrowserProjectDocumentService } from '../project/browser-project-document.service';
import { provideSimulatorWebApplication, SIMULATOR_WEB_PROJECT_PUBLICATION } from '../simulator/simulator-web-app.providers';
import { SIMULATOR_WEB_PRODUCT_SOURCE } from '../simulator/simulator-web-product.providers';
import { SIMULATOR_WEB_PROJECT_ACTIVATION } from '../simulator/simulator-web-project-activation.providers';
import type { SimulatorProjectActivationPort, SimulatorWebProjectPublicationPort } from '../simulator/simulator-web-project-activation';
import { SimulatorWebComponent } from '../../tools/simulator-web/simulator-web.component';
import { ChildAppHostRegistryService } from '../../services/integrations/subapps/child-app-host-registry.service';

export interface NormalBrowserPublicationContext {
  readonly project: SimulatorProjectActivationPort;
  readonly documents: BrowserProjectDocumentService;
  /** Borrow the same original capability; await its ready before use. */
  getClient(): CoderBrowserDocumentClient | null;
}

export interface NormalBrowserApplicationDeployment {
  readonly container: HTMLElement;
  /** Original Blockly or another owning application's selected project. Borrow
   * it directly: presentation close never closes or aborts this authority. */
  readonly project?: SimulatorProjectActivationPort | null;
  readonly editor?: CoderBrowserEmbedConfiguration | null;
  /** Trusted application authority seam. Missing production input stays null;
   * a login token, route or child message never creates publication authority. */
  readonly createPublication?: (context: NormalBrowserPublicationContext) => SimulatorWebProjectPublicationPort | null;
}

export interface NormalBrowserCloseResult {
  readonly ok: boolean;
  readonly closeSettled: boolean;
  readonly message?: string;
  readonly snapshot: object;
}

interface ClosingIntent { application: boolean; project: boolean; }
const CLOSING_INTENT = new InjectionToken<ClosingIntent>('NORMAL_BROWSER_CLOSING_INTENT');
function requireBusinessOpen(intent: ClosingIntent): void {
  if (intent.application || intent.project) throw new Error('The original Web application has requested cleanup; retry its original close first.');
}

@Component({
  selector: 'app-normal-browser-application',
  standalone: true,
  imports: [BrowserProjectViewComponent, SimulatorWebComponent],
  template: '<nav aria-label="Workspace"><button type="button" [disabled]="!editorConfigured" (click)="toggleEditor()">Show / hide editor</button><button type="button" [disabled]="!configured" (click)="requestSimulator()">Open simulator</button><button type="button" (click)="requestCloseProject()">Close project</button></nav><div role="status">{{ error }}</div><main>@if (editorConfigured) {<app-browser-project-view [active]="editorVisible"></app-browser-project-view>}@if (simulatorVisible) {<app-simulator-web></app-simulator-web>}</main>',
  styles: [':host{display:flex;flex-direction:column;min-height:0;height:100%}nav{display:flex;gap:.5rem;padding:.5rem}main{display:flex;flex:1;min-height:0}app-browser-project-view,app-simulator-web{flex:1;min-width:0}[role=status]:empty{display:none}'],
})
class NormalBrowserApplicationRoot {
  private readonly project = inject(SIMULATOR_WEB_PROJECT_ACTIVATION);
  private readonly documents = inject(BrowserProjectDocumentService);
  private readonly registry = inject(ChildAppHostRegistryService);
  private readonly source = inject(SIMULATOR_WEB_PRODUCT_SOURCE);
  private readonly closingIntent = inject(CLOSING_INTENT);
  readonly editorConfigured = inject(CODER_BROWSER_EMBED_CONFIGURATION) !== null;
  private projectClose: Promise<void> | null = null;
  readonly configured = this.source !== null;
  editorVisible = true;
  simulatorVisible = false;
  error = '';

  openSimulator(): void {
    requireBusinessOpen(this.closingIntent);
    if (!this.source) throw Object.assign(new Error('Simulator Web product configuration is unavailable.'), { code: 'web-product-unavailable' });
    const selected = this.project?.captureCurrentProjectActivation();
    if (!selected) throw Object.assign(new Error('Open a project through the original editor first.'), { code: 'project-unavailable' });
    selected.requireCurrent(); this.simulatorVisible = true;
  }

  toggleEditor(): void {
    try { requireBusinessOpen(this.closingIntent); this.editorVisible = !this.editorVisible; this.error = ''; }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); }
  }

  requestSimulator(): void {
    try { this.openSimulator(); this.error = ''; }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); }
  }

  closeProject(): Promise<void> {
    this.closingIntent.project = true;
    if (this.projectClose) return this.projectClose;
    const original = Promise.resolve().then(async () => {
      // Close this injector's presentations and owned Coder document only.
      // An external Blockly project is borrowed and stays with its real owner.
      for (const registration of this.registry.list('simulator')) {
        const result = await this.registry.control('simulator', 'close', { instanceId: registration.instanceId, strictLifecycle: true });
        if (result['ok'] !== true) throw new Error(String(result['message'] ?? 'Original Simulator cleanup remains unconfirmed.'));
      }
      this.simulatorVisible = false;
      await this.documents.closeDocument();
      this.closingIntent.project = false;
    }).finally(() => { if (this.projectClose === original) this.projectClose = null; });
    this.projectClose = original;
    void original.catch(() => { /* Failed cleanup keeps its intent; only original close may retry. */ });
    return original;
  }

  requestCloseProject(): void {
    if (this.closingIntent.application) { this.error = 'Application cleanup remains requested; retry the original application close.'; return; }
    void this.closeProject().then(() => { this.error = ''; }, error => { this.error = error instanceof Error ? error.message : String(error); });
  }
}

/** A small normal Web composition, independently loadable with its own Angular
 * compiler/zone. It shares production adapters and the original Shell; it is
 * deliberately separate from the still-unaccepted complete Main/App AOT. */
export async function mountNormalBrowserApplication(deployment: NormalBrowserApplicationDeployment) {
  const container = deployment.container;
  if (!container || container.ownerDocument !== document || document.defaultView !== window || !container.isConnected) {
    throw new TypeError('The application needs a connected container in its original document.');
  }
  const externalProject = deployment.project ?? null;
  if (externalProject !== null && deployment.editor != null) throw new TypeError('Choose the original external project or the owned Coder document, not both.');
  if (externalProject !== null && (typeof externalProject !== 'object' || typeof externalProject.captureCurrentProjectActivation !== 'function'
    || typeof externalProject.projectActivation$?.subscribe !== 'function'
    || typeof externalProject.currentProjectPath$?.subscribe !== 'function')) {
    throw new TypeError('The original external project activation port is required.');
  }
  const editor = deployment.editor == null ? null : captureCoderBrowserEmbedConfiguration(deployment.editor, window.location.origin);
  const createPublication = deployment.createPublication ?? null;
  if (createPublication !== null && typeof createPublication !== 'function') throw new TypeError('An explicit trusted publication factory is required.');
  let publicationConfigured = false;
  const closingIntent: ClosingIntent = { application: false, project: false };
  const application = await createApplication({ providers: [
    provideZoneChangeDetection({ eventCoalescing: true, runCoalescing: true }),
    { provide: CODER_BROWSER_EMBED_CONFIGURATION, useValue: editor },
    { provide: CLOSING_INTENT, useValue: closingIntent },
    externalProject !== null ? { provide: SIMULATOR_WEB_PROJECT_ACTIVATION, useValue: externalProject }
      : { provide: SIMULATOR_WEB_PROJECT_ACTIVATION, useExisting: BrowserProjectInputService },
    { provide: SIMULATOR_WEB_PROJECT_PUBLICATION,
      useFactory: (project: SimulatorProjectActivationPort, documents: BrowserProjectDocumentService) => {
        const publication = createPublication?.(Object.freeze({ project, documents,
          getClient: () => captureCurrentCoderBrowserDocumentClient(documents) })) ?? null;
        if (publication !== null && typeof publication.readPublication !== 'function') throw new TypeError('The original publication port is required.');
        publicationConfigured = publication !== null;
        return publication;
      }, deps: [SIMULATOR_WEB_PROJECT_ACTIVATION, BrowserProjectDocumentService] },
    provideSimulatorWebApplication(),
  ] });
  const rootElement = document.createElement('app-normal-browser-application');
  let created: ReturnType<typeof createComponent<NormalBrowserApplicationRoot>> | null = null;
  try {
    created = createComponent(NormalBrowserApplicationRoot, { hostElement: rootElement, environmentInjector: application.injector });
    container.appendChild(rootElement); application.attachView(created.hostView);
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    for (const cleanup of [() => created?.destroy(), () => application.destroy(), () => rootElement.remove()]) {
      try { cleanup(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    }
    if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'Web application creation failed and cleanup remains unconfirmed.');
    throw error;
  }
  const component = created;
  const documents = application.injector.get(BrowserProjectDocumentService);
  const project = application.injector.get(BrowserProjectInputService);
  const registry = application.injector.get(ChildAppHostRegistryService);
  const source = application.injector.get(SIMULATOR_WEB_PRODUCT_SOURCE);
  let closed = false, cleanup: Promise<void> | null = null, waiting: Promise<NormalBrowserCloseResult> | null = null;
  let lastFailure: string | null = null;
  const callerCloseWaitMs = 3000;
  const ready = Promise.resolve().then(() => { component.changeDetectorRef.detectChanges(); });
  void ready.catch(error => { lastFailure = error instanceof Error ? error.message : String(error); });

  function snapshot() {
    return { closed, editorConfigured: editor !== null, publicationConfigured, cleanupPending: cleanup !== null,
      projectSource: externalProject !== null ? 'borrowed-external' : 'browser-input',
      applicationCloseRequested: closingIntent.application, projectCloseRequested: closingIntent.project,
      callerCloseWaitMs, lastFailure, document: documents.snapshot(), input: project.snapshot(),
      tools: registry.list().map(value => ({ ...value, status: registry.getStatus(value.toolId, value.instanceId) })),
      retainedCleanupResponsibility: !closed, WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false };
  }

  function close(): Promise<NormalBrowserCloseResult> {
    closingIntent.application = true;
    if (closed) return Promise.resolve({ ok: true, closeSettled: true, snapshot: snapshot() });
    if (waiting) return waiting;
    if (!cleanup) {
      const original = Promise.resolve().then(async () => {
        await ready.catch(() => undefined);
        await component.instance.closeProject();
        const ownedSource = source as (typeof source & { close?(): Promise<void> });
        await ownedSource?.close?.();
        component.destroy(); application.destroy(); rootElement.remove(); closed = true;
      }).finally(() => { if (cleanup === original) cleanup = null; });
      cleanup = original;
      void original.catch(() => { /* Keep this same application available for retry. */ });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const original = cleanup;
    const task = Promise.race([original, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Original Web application cleanup remains unconfirmed after the caller close budget.')), callerCloseWaitMs);
    })]).then(() => ({ ok: true, closeSettled: true, snapshot: snapshot() }), error => {
      lastFailure = error instanceof Error ? error.message : String(error);
      return { ok: false, closeSettled: false, message: lastFailure, snapshot: snapshot() };
    }).finally(() => { clearTimeout(timer); if (waiting === task) waiting = null; });
    waiting = task;
    return task;
  }

  return Object.freeze({ ready, snapshot, close,
    openSimulator(): void {
      if (closed) throw new Error('The original Web application is closed.');
      requireBusinessOpen(closingIntent);
      component.instance.openSimulator(); component.changeDetectorRef.detectChanges();
    },
    async closeProject(): Promise<void> {
      // For a borrowed external project this closes only this presentation.
      // Failure keeps the same cleanup intent; successful retry may reopen it.
      if (closed || closingIntent.application) throw new Error('The original Web application is closing or closed.');
      await component.instance.closeProject(); component.changeDetectorRef.detectChanges();
    },
  });
}
