import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';

import { ProjectService } from '../../services/project.service';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import {
  SimulatorSubappFrameAdapter,
  type SimulatorSubappDebugLocationHint,
  type SimulatorSubappSurface,
  type SimulatorSubappFrameState,
} from './simulator-subapp-frame-adapter';
import { SimulatorProjectRebuildBridgeService } from '../../services/simulator-project-rebuild-bridge.service';

interface SimulatorSubappElectronApi {
  openProjectScene(options: {
    projectPath: string;
    ownerId: string;
    sceneId: string;
  }): Promise<SimulatorSubappSurface | ProjectSceneRegenerationRequired>;
  resolveProjectSceneRegeneration(options: {
    ownerId: string;
    regenerationId: string;
    resolution: 'cancel' | 'commit';
    proposal?: Record<string, unknown>;
  }): Promise<SimulatorSubappSurface | {
    schemaVersion: 1;
    kind: 'aily-simulator-subapp-project-scene-regeneration-result';
    state: 'cancelled';
    regenerationId: string;
  }>;
  applyProjectSceneAgentProposal(options: {
    ownerId: string;
    proposal: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  requestProjectSceneGeneration?(options: {
    ownerId: string;
    regenerationId: string;
  }): Promise<{
    schemaVersion: 1;
    kind: 'aily-simulator-subapp-project-scene-generation-request-result';
    state: 'accepted';
    regenerationId: string;
  }>;
  attachProjectSceneSession(ownerId?: string): Promise<unknown>;
  close(ownerId?: string): Promise<unknown>;
  onStateChanged?(callback: (event: {
    state: string;
    unexpected?: boolean;
    surface?: SimulatorSubappSurface;
    failure?: { message?: string };
  }) => void): () => void;
}

interface ProjectSceneRegenerationRequirement {
  schemaVersion: 1;
  kind: 'aily-project-scene-legacy-regeneration-required';
  regenerationId: string;
  projectIdentity: string;
  sceneId: string;
  legacySourceKind: 'connection-output-v1';
  legacySourceRevision: string;
  legacySourceBytes: number;
  catalogRevision: string;
  draftVisualRevision: string;
  draftGraphSemanticRevision: string;
  expiresAtUnixMs: number;
}

interface ProjectSceneRegenerationRequired {
  schemaVersion: 1;
  kind: 'aily-simulator-subapp-project-scene-regeneration-required';
  state: 'legacy-scene-regeneration-required';
  tool: 'scene';
  initialization: 'legacy-detected';
  requirement: ProjectSceneRegenerationRequirement;
  runtimeSource: string;
  runtimePackId?: string;
  runtimeMode?: string;
}

@Component({
  selector: 'app-simulator-subapp-host',
  imports: [CommonModule],
  templateUrl: './simulator-subapp-host.component.html',
  styleUrl: './simulator-subapp-host.component.scss',
})
export class SimulatorSubappHostComponent
implements AfterViewInit, OnDestroy {
  @ViewChild('subappFrame') private frame?: ElementRef<HTMLIFrameElement>;

  state: SimulatorSubappFrameState = 'idle';
  errorMessage = '';
  runtimeSource = '';
  regenerationRequirement: ProjectSceneRegenerationRequirement | null = null;
  generationRequestPending = false;

  private readonly ownerId = createOwnerId();
  private adapter: SimulatorSubappFrameAdapter | null = null;
  private projectActivationSubscription: Subscription | null = null;
  private removeHostStateListener: (() => void) | null = null;
  private launchGeneration = 0;
  private destroyed = false;

  constructor(
    private readonly projectService: ProjectService,
    private readonly blocklyService: BlocklyService,
    private readonly ngZone: NgZone,
    rebuildBridge: SimulatorProjectRebuildBridgeService,
  ) {
    rebuildBridge.start();
    this.projectActivationSubscription =
      this.projectService.projectActivation$.subscribe(() => {
        if (!this.destroyed) void this.restart();
      });
    this.removeHostStateListener =
      (window as any).electronAPI?.simulatorSubapp?.onStateChanged((event: {
        state: string;
        unexpected?: boolean;
        surface?: SimulatorSubappSurface;
        failure?: { message?: string };
      }) => {
        if (event.state === 'scene-generation-failed' && !this.destroyed) {
          this.ngZone.run(() => {
            this.errorMessage = event.failure?.message
              || 'Project Scene generation failed.';
            this.generationRequestPending = false;
          });
          return;
        }
        if (
          event.state === 'ready'
          && event.surface?.kind === 'aily-simulator-subapp-surface'
          && this.regenerationRequirement
          && !this.destroyed
        ) {
          this.ngZone.run(() => {
            this.regenerationRequirement = null;
            void this.presentResolvedRegenerationSurface(event.surface!);
          });
          return;
        }
        if (
          !event.unexpected
          || (event.state !== 'failed' && event.state !== 'stopped')
          || this.destroyed
        ) {
          return;
        }
        this.ngZone.run(() => {
          this.errorMessage = event.failure?.message
            || '独立仿真服务意外退出，请重新启动。';
          this.state = 'failed';
        });
      }) ?? null;
  }

  ngAfterViewInit(): void {
    void this.launch();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.launchGeneration += 1;
    this.projectActivationSubscription?.unsubscribe();
    this.projectActivationSubscription = null;
    this.removeHostStateListener?.();
    this.removeHostStateListener = null;
    const adapter = this.adapter;
    this.adapter = null;
    this.blocklyService.clearDebugExecutionMarker();
    if (adapter) {
      void adapter.close();
    } else {
      void this.simulatorApi()?.close(this.ownerId);
    }
  }

  retry(): void {
    void this.restart();
  }

  cancelLegacyRegeneration(): void {
    const requirement = this.regenerationRequirement;
    const api = this.simulatorApi();
    if (!requirement || !api) return;
    this.state = 'closing';
    void api.resolveProjectSceneRegeneration({
      ownerId: this.ownerId,
      regenerationId: requirement.regenerationId,
      resolution: 'cancel',
    }).then(() => {
      if (this.destroyed) return;
      this.ngZone.run(() => {
        this.regenerationRequirement = null;
        this.state = 'closed';
      });
    }).catch((error) => {
      this.applyLaunchError(error, this.launchGeneration);
    });
  }

  requestProjectSceneGeneration(): void {
    const requirement = this.regenerationRequirement;
    const request = this.simulatorApi()?.requestProjectSceneGeneration;
    if (!requirement || this.generationRequestPending) return;
    if (typeof request !== 'function') {
      this.errorMessage = 'Scene Generation Broker 尚未连接；已阻止旧连线图生成通道。';
      return;
    }
    this.errorMessage = '';
    this.generationRequestPending = true;
    void request({
      ownerId: this.ownerId,
      regenerationId: requirement.regenerationId,
    }).catch((error) => {
      if (this.destroyed) return;
      this.ngZone.run(() => {
        this.errorMessage = error instanceof Error ? error.message : String(error);
      });
    }).finally(() => {
      if (this.destroyed) return;
      this.ngZone.run(() => {
        this.generationRequestPending = false;
      });
    });
  }

  private async restart(): Promise<void> {
    const generation = ++this.launchGeneration;
    const previous = this.adapter;
    this.adapter = null;
    this.regenerationRequirement = null;
    this.blocklyService.clearDebugExecutionMarker();
    if (previous) {
      await previous.close();
    } else {
      await this.simulatorApi()?.close(this.ownerId);
    }
    if (this.destroyed || generation !== this.launchGeneration) return;
    await this.launch(generation);
  }

  private async launch(generation = ++this.launchGeneration): Promise<void> {
    const frame = this.frame?.nativeElement;
    const api = this.simulatorApi();
    if (!frame || this.destroyed) return;
    if (!api) {
      this.applyLaunchError(
        new Error('独立仿真服务接口不可用，请重启主程序后重试。'),
        generation,
      );
      return;
    }

    this.errorMessage = '';
    this.runtimeSource = '';
    this.regenerationRequirement = null;
    this.state = 'acquiring';
    let projectPath: string;
    try {
      projectPath = this.projectService.currentProjectPath;
      if (!projectPath) {
        throw new Error('请先打开一个项目，再启动仿真。');
      }
    } catch (error) {
      this.applyLaunchError(error, generation);
      return;
    }
    if (
      this.destroyed
      || generation !== this.launchGeneration
      || projectPath !== this.projectService.currentProjectPath
    ) {
      return;
    }

    let initialSurface: SimulatorSubappSurface | null;
    try {
      const openResult = await api.openProjectScene({
        projectPath,
        ownerId: this.ownerId,
        sceneId: 'main',
      });
      if (
        this.destroyed
        || generation !== this.launchGeneration
        || projectPath !== this.projectService.currentProjectPath
      ) {
        await api.close(this.ownerId);
        return;
      }
      this.runtimeSource = openResult.runtimePackId
        ? `${openResult.runtimePackId} (${openResult.runtimeMode || 'unknown'})`
        : openResult.runtimeSource;
      if (isProjectSceneRegenerationRequired(openResult)) {
        this.ngZone.run(() => {
          this.regenerationRequirement = openResult.requirement;
          this.state = 'idle';
        });
        return;
      }
      initialSurface = openResult;
    } catch (error) {
      this.applyLaunchError(error, generation);
      return;
    }

    await this.startSurfaceAdapter(api, projectPath, initialSurface, generation);
  }

  private async presentResolvedRegenerationSurface(
    surface: SimulatorSubappSurface,
  ): Promise<void> {
    const api = this.simulatorApi();
    const projectPath = this.projectService.currentProjectPath;
    const generation = this.launchGeneration;
    if (
      !api
      || !projectPath
      || this.destroyed
      || this.adapter
    ) {
      return;
    }
    this.runtimeSource = surface.runtimePackId
      ? `${surface.runtimePackId} (${surface.runtimeMode || 'unknown'})`
      : surface.runtimeSource;
    await this.startSurfaceAdapter(api, projectPath, surface, generation);
  }

  private async startSurfaceAdapter(
    api: SimulatorSubappElectronApi,
    projectPath: string,
    surface: SimulatorSubappSurface,
    generation: number,
  ): Promise<void> {
    const frame = this.frame?.nativeElement;
    if (
      !frame
      || this.destroyed
      || generation !== this.launchGeneration
      || projectPath !== this.projectService.currentProjectPath
    ) {
      return;
    }
    let initialSurface: SimulatorSubappSurface | null = surface;
    const adapter = new SimulatorSubappFrameAdapter({
      window,
      frame,
      acquireSurface: async () => {
        const result = initialSurface ?? await api.openProjectScene({
          projectPath, ownerId: this.ownerId, sceneId: 'main',
        });
        initialSurface = null;
        if (isProjectSceneRegenerationRequired(result)) {
          throw new Error('Project Scene requires Agent regeneration before opening.');
        }
        const surface = result;
        try {
          await api.attachProjectSceneSession(this.ownerId);
        } catch {
          // Wiring remains available when the fixed .build Artifact is absent
          // or stale. The independent Subapp exposes the detached state.
        }
        this.ngZone.run(() => {
          this.runtimeSource = surface.runtimePackId
            ? `${surface.runtimePackId} (${surface.runtimeMode || 'unknown'})`
            : surface.runtimeSource;
        });
        return surface;
      },
      releaseSurface: () => api.close(this.ownerId),
      onStateChange: (state, error) => {
        this.ngZone.run(() => {
          if (this.adapter !== adapter || this.destroyed) return;
          this.state = state;
          if (error) this.errorMessage = publicErrorMessage(error);
        });
      },
      onDebugLocationHint: (hint) => {
        this.applyDebugLocationHint(adapter, projectPath, hint);
      },
    });
    this.adapter = adapter;
    try {
      await adapter.start();
    } catch (error) {
      this.applyLaunchError(error, generation);
    }
  }

  private applyDebugLocationHint(
    adapter: SimulatorSubappFrameAdapter,
    projectPath: string,
    hint: SimulatorSubappDebugLocationHint,
  ): void {
    this.ngZone.run(() => {
      if (
        this.adapter !== adapter
        || this.destroyed
        || this.projectService.currentProjectPath !== projectPath
      ) {
        return;
      }
      if (hint.status === 'available' && hint.primaryBlockId) {
        this.blocklyService.setDebugExecutionMarker(
          projectPath,
          hint.primaryBlockId,
        );
      } else {
        this.blocklyService.clearDebugExecutionMarker(projectPath);
      }
    });
  }

  private applyLaunchError(error: unknown, generation: number): void {
    if (this.destroyed || generation !== this.launchGeneration) return;
    this.ngZone.run(() => {
      this.blocklyService.clearDebugExecutionMarker();
      this.state = 'failed';
      this.errorMessage = publicErrorMessage(error);
    });
  }

  private simulatorApi(): SimulatorSubappElectronApi | undefined {
    return (window as any).electronAPI?.simulatorSubapp as
      | SimulatorSubappElectronApi
      | undefined;
  }
}

function isProjectSceneRegenerationRequired(
  value: SimulatorSubappSurface | ProjectSceneRegenerationRequired,
): value is ProjectSceneRegenerationRequired {
  return value.kind === 'aily-simulator-subapp-project-scene-regeneration-required';
}

function createOwnerId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `simulator-subapp-host:${random}`;
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/explicit HTTP\(S\) renderer origin|opaque file origins/i.test(message)) {
    return '当前打包版仍使用 file:// 页面，无法建立安全 iframe origin；请先在开发环境运行，打包版将在本地 HTTP 渲染入口完成后启用。';
  }
  return message || '独立仿真服务启动失败。';
}
