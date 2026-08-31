import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { Connection, WindowMessenger, connect } from 'penpal';
import { Subscription } from 'rxjs';

import {
  ChildToolUiSurfaceConfig,
  getChildToolConfig,
} from '../../configs/tool.config';
import {
  ChildAppHostRegistryService,
  type ChildAppWindowPlacement,
  ChildToolProcessService,
  type ChildToolHostInfo,
  type ChildToolRuntimeSnapshot,
  SubappActivityService,
  type SubappActivitySummaryState,
} from '@integration/subapps/public-api';
import { ElectronService } from '@core/platform/public-api';
import { MainUiAutomationService } from '@integration/automation/public-api';
import { ProjectService } from '@domain/project/public-api';
import { ThemeService } from '@core/preferences/public-api';
import { resolveRuntimeSurfaceEntry } from './child-tool-surface-url';

type CompactHostStatus = 'idle' | 'starting' | 'connecting' | 'ready' | 'stopped' | 'error';

@Component({
  selector: 'app-child-tool-surface-host',
  imports: [CommonModule],
  templateUrl: './child-tool-surface-host.component.html',
  styleUrl: './child-tool-surface-host.component.scss',
})
export class ChildToolSurfaceHostComponent implements OnInit, OnChanges, OnDestroy {
  @Input() toolId = '';
  @Input() surface = 'compact';
  @Input() placement = 'chat-dock';
  @Input() instanceId = '';
  @Input() sessionId = '';
  @Input() active = true;
  @Output() readonly closeRequested = new EventEmitter<void>();

  hostStatus: CompactHostStatus = 'idle';
  iframeSrc: SafeResourceUrl | null = null;
  frameLoaded = false;
  errorMessage = '';
  interactive = true;

  private initialized = false;
  private runtimeSubscription: Subscription | null = null;
  private langSubscription: Subscription | null = null;
  private themeSubscription: Subscription | null = null;
  private projectSubscription: Subscription | null = null;
  private unregisterHostController: (() => void) | null = null;
  private penpalConnection: Connection | null = null;
  private remoteApi: any = null;
  private remoteWindow: Window | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private currentUrl = '';
  private hostInfo: ChildToolHostInfo | null = null;
  private contextVersion = 0;
  private readonly contextId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  constructor(
    private readonly sanitizer: DomSanitizer,
    private readonly processService: ChildToolProcessService,
    private readonly electronService: ElectronService,
    private readonly hostRegistry: ChildAppHostRegistryService,
    private readonly mainUiAutomation: MainUiAutomationService,
    private readonly projectService: ProjectService,
    private readonly activityService: SubappActivityService,
    private readonly translate: TranslateService,
    private readonly themeService: ThemeService,
    private readonly ngZone: NgZone,
  ) {}

  get isLoading(): boolean {
    return this.hostStatus === 'starting'
      || this.hostStatus === 'connecting'
      || (this.hostStatus === 'ready' && !this.frameLoaded);
  }

  ngOnInit(): void {
    this.initialized = true;
    this.langSubscription = this.translate.onLangChange.subscribe(() => this.syncHostContext());
    this.themeSubscription = this.themeService.themeChanged$.subscribe(() => this.syncHostContext());
    this.projectSubscription = this.projectService.currentProjectPath$.subscribe(() => {
      if (this.initialized) this.syncHostContext(true);
    });
    this.bindTool();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.initialized) return;

    if (changes['toolId'] || changes['surface'] || changes['instanceId']) {
      this.bindTool();
      return;
    }

    if ((changes['placement'] || changes['active']) && this.active) {
      this.syncHostContext(true);
    }
  }

  ngOnDestroy(): void {
    this.initialized = false;
    this.runtimeSubscription?.unsubscribe();
    this.runtimeSubscription = null;
    this.langSubscription?.unsubscribe();
    this.langSubscription = null;
    this.themeSubscription?.unsubscribe();
    this.themeSubscription = null;
    this.projectSubscription?.unsubscribe();
    this.projectSubscription = null;
    this.unregisterHostController?.();
    this.unregisterHostController = null;
    this.destroyConnection();
  }

  onFrameLoad(event: Event): void {
    const iframe = event.target as HTMLIFrameElement;
    if (!iframe.contentWindow) {
      this.setError('Compact surface iframe did not expose contentWindow');
      return;
    }

    if (this.remoteWindow === iframe.contentWindow && this.penpalConnection) {
      return;
    }
    this.connectToSurface(iframe);
  }

  private bindTool(): void {
    this.runtimeSubscription?.unsubscribe();
    this.runtimeSubscription = null;
    this.unregisterHostController?.();
    this.unregisterHostController = null;
    this.destroyConnection();
    this.clearFrame();

    const toolId = String(this.toolId || '').trim();
    if (!toolId) {
      this.setError('Child tool id is required');
      return;
    }

    const instanceId = String(this.instanceId || '').trim() || `compact:${this.contextId}`;
    this.unregisterHostController = this.hostRegistry.register(toolId, {
      status: () => this.hostAutomationStatus(),
      prepareUpdate: async () => ({
        ok: true,
        toolId,
        instanceId,
        action: 'prepareUpdate',
        surface: this.surface,
      }),
      restart: async () => ({
        ok: false,
        toolId,
        instanceId,
        message: 'Compact surfaces observe the shared Runtime and cannot restart it.',
      }),
      close: async () => {
        this.closeRequested.emit();
        return { ok: true, toolId, instanceId, action: 'close', surface: this.surface };
      },
      detach: options => this.openFull('window', options),
      embed: () => this.openFull('embedded'),
    }, {
      instanceId,
      surface: this.surface,
      primary: false,
    });

    this.runtimeSubscription = this.processService.observeRuntime(toolId)
      .subscribe(snapshot => this.ngZone.run(() => this.applyRuntimeSnapshot(snapshot)));
  }

  private applyRuntimeSnapshot(snapshot: ChildToolRuntimeSnapshot): void {
    if (snapshot.state === 'ready' && snapshot.hostInfo?.url) {
      this.hostInfo = snapshot.hostInfo;
      const surfaceConfig = this.resolveSurfaceConfig();
      if (!surfaceConfig) return;

      this.interactive = surfaceConfig.interactive !== false;
      const url = this.buildSurfaceUrl(snapshot.hostInfo, surfaceConfig);
      if (url === this.currentUrl) {
        return;
      }

      this.destroyConnection();
      this.currentUrl = url;
      this.frameLoaded = false;
      this.errorMessage = '';
      this.hostStatus = 'connecting';
      this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(url);
      return;
    }

    this.hostInfo = null;
    this.destroyConnection();
    this.clearFrame();

    switch (snapshot.state) {
      case 'starting':
        this.hostStatus = 'starting';
        break;
      case 'error':
        this.setError(snapshot.error || 'Child tool Runtime failed');
        break;
      case 'stopped':
        this.hostStatus = 'stopped';
        break;
      default:
        this.hostStatus = 'idle';
        break;
    }
  }

  private resolveSurfaceConfig(): ChildToolUiSurfaceConfig | null {
    const config = getChildToolConfig(this.toolId);
    const surfaceName = String(this.surface || 'compact').trim() || 'compact';
    const surfaceConfig = config?.ui?.surfaces?.[surfaceName];
    if (!surfaceConfig?.entry) {
      this.destroyConnection();
      this.clearFrame();
      this.setError(`Subapp does not declare the "${surfaceName}" UI surface`);
      return null;
    }
    return surfaceConfig;
  }

  private buildSurfaceUrl(
    hostInfo: ChildToolHostInfo,
    surfaceConfig: ChildToolUiSurfaceConfig,
  ): string {
    const baseUrl = new URL(hostInfo.url);
    const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
    const runtimeEntry = resolveRuntimeSurfaceEntry(
      surfaceConfig.entry,
      getChildToolConfig(this.toolId)?.uiIndex || '',
    );
    const targetUrl = new URL(
      runtimeEntry,
      `${baseUrl.origin}${basePath}`,
    );

    baseUrl.searchParams.forEach((value, key) => {
      if (!targetUrl.searchParams.has(key)) targetUrl.searchParams.set(key, value);
    });
    const context = this.createHostContext();
    targetUrl.searchParams.set('lang', String(context['lang']));
    targetUrl.searchParams.set('surface', String(context['surface']));
    targetUrl.searchParams.set('placement', String(context['placement']));
    targetUrl.searchParams.set('density', 'compact');
    return targetUrl.toString();
  }

  private connectToSurface(iframe: HTMLIFrameElement): void {
    this.destroyConnection();
    this.remoteWindow = iframe.contentWindow;
    this.hostStatus = 'connecting';

    const allowedOrigin = this.hostInfo?.origin || this.resolveOrigin(this.hostInfo?.url);
    const messenger = new WindowMessenger({
      remoteWindow: iframe.contentWindow!,
      allowedOrigins: allowedOrigin ? [allowedOrigin] : ['*'],
    });

    this.readyTimer = setTimeout(() => {
      if (!this.frameLoaded) {
        this.ngZone.run(() => this.setError(`${this.toolId} compact surface did not report ready`));
      }
    }, 10000);

    try {
      this.penpalConnection = connect({
        messenger,
        methods: {
          getHostContext: () => this.createHostContext(),
          childReady: () => {
            this.ngZone.run(() => {
              this.frameLoaded = true;
              this.hostStatus = 'ready';
              this.errorMessage = '';
              this.clearReadyTimer();
            });
          },
          childError: (error: unknown) => {
            this.ngZone.run(() => this.setError(this.errorText(error) || 'Compact surface failed'));
          },
          notifyUserInteraction: (payload: unknown) => this.electronService.notifyUserInteraction(
            payload && typeof payload === 'object'
              ? payload as Record<string, unknown>
              : {},
          ),
          requestClose: () => {
            this.ngZone.run(() => this.closeRequested.emit());
            return { ok: true };
          },
          requestRestart: () => ({
            ok: false,
            message: 'Compact surfaces cannot restart the shared Runtime.',
          }),
          reportHostMessage: (payload: unknown) => {
            console.info(`[child-tool-surface:${this.toolId}]`, payload);
            return { ok: true };
          },
          reportActivity: (payload: unknown) => this.ngZone.run(() => this.reportActivity(payload)),
          openFull: (mode: unknown = 'embedded') => this.ngZone.run(() => this.openFull(
            mode === 'window' ? 'window' : 'embedded',
          )),
          openExternal: (url: string) => this.openExternal(url),
        },
      });
    } catch (error) {
      this.setError(this.errorText(error) || 'Unable to connect compact surface');
      return;
    }

    void this.penpalConnection.promise
      .then(remote => {
        this.remoteApi = remote;
        this.syncHostContext();
      })
      .catch(error => {
        this.ngZone.run(() => this.setError(this.errorText(error) || 'Compact surface connection failed'));
      });
  }

  private createHostContext(): Record<string, unknown> {
    const surfaceConfig = getChildToolConfig(this.toolId)?.ui?.surfaces?.[this.surface];
    return {
      toolId: this.toolId,
      contextId: this.contextId,
      version: String(++this.contextVersion),
      lang: this.normalizeLang(this.translate.currentLang || this.translate.defaultLang || 'en'),
      theme: this.themeService.theme(),
      platform: (window as any).electronAPI?.platform?.type || 'browser',
      embedded: true,
      workspace: this.projectService.currentProjectPath || null,
      surface: this.surface || 'compact',
      placement: this.placement || 'chat-dock',
      density: 'compact',
      interactive: surfaceConfig?.interactive !== false,
      capabilities: {
        snapshotRefresh: true,
        userInteractionNotifications: true,
        compactSurface: true,
        runtimeControl: false,
      },
    };
  }

  private syncHostContext(refreshSnapshot = false): void {
    if (!this.remoteApi?.setHostContext) return;
    const context = this.createHostContext();
    void Promise.resolve(this.remoteApi.setHostContext(context))
      .then(() => {
        if (refreshSnapshot && typeof this.remoteApi?.refreshHostSnapshot === 'function') {
          return Promise.resolve(this.remoteApi.refreshHostSnapshot());
        }
        return undefined;
      })
      .catch(() => undefined);
  }

  private async openFull(
    mode: 'embedded' | 'window',
    options: ChildAppWindowPlacement = {},
  ): Promise<Record<string, unknown>> {
    return this.mainUiAutomation.openChildApp({
      toolId: this.toolId,
      mode,
      ...options,
    });
  }

  private openExternal(url: string): { ok: boolean; message?: string } {
    try {
      const parsed = new URL(String(url || ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, message: 'Only http and https URLs are supported.' };
      }
      (window as any).electronAPI?.other?.openByBrowser?.(parsed.toString());
      return { ok: true };
    } catch {
      return { ok: false, message: 'Invalid URL' };
    }
  }

  private reportActivity(payload: unknown): { ok: boolean; message?: string } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, message: 'Activity summary must be an object.' };
    }
    const record = payload as Record<string, unknown>;
    const allowedKeys = new Set(['state', 'label', 'detail', 'badge']);
    if (Object.keys(record).some(key => !allowedKeys.has(key))) {
      return { ok: false, message: 'Activity summary contains unsupported fields.' };
    }
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 1024) {
      return { ok: false, message: 'Activity summary exceeds the 1KB budget.' };
    }
    const state = String(record['state'] || 'idle') as SubappActivitySummaryState;
    if (!['idle', 'active', 'warning', 'error'].includes(state)) {
      return { ok: false, message: 'Activity summary state is invalid.' };
    }
    const values = {
      label: this.summaryText(record['label'], 160),
      detail: this.summaryText(record['detail'], 160),
      badge: this.summaryText(record['badge'], 80),
    };
    if (Object.values(values).some(value => value.includes('<') || value.includes('>'))) {
      return { ok: false, message: 'Activity summary cannot contain HTML.' };
    }

    const activity = this.activityService.recordActivitySummary(
      this.sessionId,
      this.toolId,
      { state, ...values },
    );
    return activity
      ? { ok: true }
      : { ok: false, message: 'Activity is no longer available.' };
  }

  private summaryText(value: unknown, maxLength: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  private hostAutomationStatus(): Record<string, unknown> {
    return {
      status: this.hostStatus,
      frameLoaded: this.frameLoaded,
      surface: this.surface,
      placement: this.placement,
      interactive: this.interactive,
      error: this.errorMessage || null,
      pid: this.hostInfo?.pid ?? null,
      port: this.hostInfo?.port ?? null,
      observesRuntime: true,
    };
  }

  private clearFrame(): void {
    this.currentUrl = '';
    this.iframeSrc = null;
    this.frameLoaded = false;
  }

  private setError(message: string): void {
    this.hostStatus = 'error';
    this.errorMessage = message;
    this.clearReadyTimer();
  }

  private destroyConnection(): void {
    this.clearReadyTimer();
    this.remoteApi = null;
    this.remoteWindow = null;
    this.penpalConnection?.destroy();
    this.penpalConnection = null;
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private resolveOrigin(url?: string): string {
    if (!url) return '';
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  private normalizeLang(lang: string): string {
    const normalized = String(lang || 'en').trim().toLowerCase().replace(/-/g, '_');
    if (normalized === 'zh' || normalized.startsWith('zh_cn')) return 'zh_cn';
    if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
    return normalized || 'en';
  }

  private errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object' && 'message' in error) {
      return String((error as { message?: unknown }).message || '');
    }
    return String(error || '');
  }
}
