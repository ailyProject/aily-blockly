import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, merge, Subscription } from 'rxjs';
import { ProjectService } from '@domain/project/public-api';
import { SubappHostProviderProductRegistryService } from './subapp-host-provider-product-registry.service';
import {
  SubappWorkspaceHostProviderController,
  type WorkspaceProviderRuntime,
} from './subapp-workspace-host-provider-controller';

/** Started only by the main workspace, never by detached tool renderers. */
@Injectable({ providedIn: 'root' })
export class SubappWorkspaceHostProviderService implements OnDestroy {
  private controller: SubappWorkspaceHostProviderController | null = null;
  private subscriptions = new Subscription();
  private readonly removeListeners: Array<() => void> = [];
  private runtimes: readonly WorkspaceProviderRuntime[] = [];
  private discoveryRevision = 0;
  private readinessRevision = 0;
  private readinessKey = '';
  private projectionKey = '';
  private readonly readyBaseWorkspaceSubject = new BehaviorSubject<string | null>(null);
  readonly readyBaseWorkspace$ = this.readyBaseWorkspaceSubject.asObservable();
  private readonly readyWorkspaceChangesSubject = new BehaviorSubject<void>(undefined);
  readonly readyWorkspaceChanges$ = this.readyWorkspaceChangesSubject.asObservable();

  get readyBaseWorkspace(): string | null {
    const workspace = this.readyBaseWorkspaceSubject.value;
    return workspace === this.readLoadedWorkspace() ? workspace : null;
  }

  /** Registered products only receive a root after their exact stream has been bound. */
  readReadyWorkspace(toolId: string): string | null {
    if (!this.registry.hasRegistration(toolId)) return this.project.currentProjectPath || null;
    const workspace = this.readyBaseWorkspace;
    if (!workspace || !this.controller || this.project.isAilyCodeProject(workspace)) return null;
    return this.isProviderReady(toolId, workspace) ? workspace : null;
  }

  constructor(
    private readonly registry: SubappHostProviderProductRegistryService,
    private readonly project: ProjectService,
  ) {}

  start(): void {
    if (this.controller) return;
    const api = (window as any).electronAPI?.childToolSession;
    if (!api?.bindMessageController || !api?.onStateChanged || !api?.onMessage) return;
    const controller = this.controller = new SubappWorkspaceHostProviderController({
      port: api, registry: this.registry,
      instanceId: `workspace:${Date.now()}-${Math.random().toString(16).slice(2)}`,
      onError: toolId => console.warn('[SubappHostProvider] workspace binding failed', { toolId }),
    });
    this.removeListeners.push(api.onMessage((event: Parameters<typeof controller.receive>[0]) => controller.receive(event)));
    this.removeListeners.push(api.onStateChanged((runtimes: WorkspaceProviderRuntime[]) => {
      if (this.controller !== controller) return;
      this.discoveryRevision++;
      this.runtimes = runtimes;
      this.refresh();
    }));
    this.removeListeners.push(api.onHostShutdown(() => { void this.stop(); }));
    this.subscriptions.add(merge(
      this.project.currentProjectPath$, this.project.projectActivation$, this.project.stateSubject,
      this.project.projectOpeningChanged$,
    ).subscribe(() => this.refresh()));
    const discoveryRevision = this.discoveryRevision;
    void api.list().then((runtimes: WorkspaceProviderRuntime[]) => {
      if (this.controller !== controller || this.discoveryRevision !== discoveryRevision) return;
      this.runtimes = runtimes;
      this.refresh();
    }).catch(() => console.warn('[SubappHostProvider] runtime discovery failed'));
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    this.controller = null;
    this.readinessRevision++;
    this.readinessKey = '';
    this.readyBaseWorkspaceSubject.next(null);
    this.subscriptions.unsubscribe();
    this.subscriptions = new Subscription();
    for (const remove of this.removeListeners.splice(0)) remove();
    this.runtimes = [];
    this.publishProjectionChange();
    await controller?.close();
  }

  ngOnDestroy(): void { void this.stop(); }

  private refresh(): void {
    const controller = this.controller;
    if (!controller) return;
    const root = this.project.currentProjectPath;
    const workspace = this.readLoadedWorkspace();
    const scope = workspace && !this.project.isAilyCodeProject(workspace) ? workspace : null;
    const key = JSON.stringify([root, workspace, scope]);
    if (key !== this.readinessKey) {
      this.readinessKey = key;
      this.readinessRevision++;
      if (this.readyBaseWorkspaceSubject.value !== workspace) this.readyBaseWorkspaceSubject.next(null);
    }
    const revision = this.readinessRevision;
    const update = controller.update(scope, this.runtimes);
    this.publishProjectionChange();
    void update.then(() => {
      if (this.controller !== controller || this.readinessRevision !== revision
        || this.readLoadedWorkspace() !== workspace) return;
      const providersReady = this.runtimes.filter(runtime => this.isRegisteredRuntime(runtime))
        .every(runtime => this.isProviderReady(runtime.toolId, scope));
      if (providersReady && this.readyBaseWorkspaceSubject.value !== workspace) {
        this.readyBaseWorkspaceSubject.next(workspace);
      }
      this.publishProjectionChange();
    }).catch(() => console.warn('[SubappHostProvider] workspace reconciliation failed'));
  }

  private readLoadedWorkspace(): string | null {
    const root = this.project.currentProjectPath;
    if (!root || this.project.isProjectOpening) return null;
    return this.project.isAilyCodeProject(root) || this.project.getBlocklyProjectLoadStatus(root).ready
      ? root : null;
  }

  private isRegisteredRuntime(runtime: WorkspaceProviderRuntime): boolean {
    return !!(runtime.running && runtime.streamId && runtime.messagePort
      && this.registry.hasRegistration(runtime.toolId));
  }

  private isProviderReady(toolId: string, scope: string | null): boolean {
    const runtime = this.runtimes.find(value => value.toolId === toolId && this.isRegisteredRuntime(value));
    return !!runtime && !!this.controller?.snapshot().some(binding => binding.toolId === toolId
      && binding.streamId === runtime.streamId && binding.scope === scope && binding.ready);
  }

  private publishProjectionChange(): void {
    const key = JSON.stringify([this.readyBaseWorkspace, this.runtimes
      .filter(runtime => this.registry.hasRegistration(runtime.toolId))
      .map(runtime => [runtime.toolId, runtime.streamId, this.readReadyWorkspace(runtime.toolId)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
    if (key === this.projectionKey) return;
    this.projectionKey = key;
    this.readyWorkspaceChangesSubject.next();
  }
}
