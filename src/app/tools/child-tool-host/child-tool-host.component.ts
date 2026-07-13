import { CommonModule } from '@angular/common';
import { Component, Input, NgZone, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { Connection, WindowMessenger, connect } from 'penpal';
import { Subscription } from 'rxjs';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { ChildToolConfig, getChildToolConfig } from '../../configs/tool.config';
import { ChildToolHostInfo, ChildToolProcessService } from '../../services/child-tool-process.service';
import { LogService } from '../../services/log.service';
import { ThemeService } from '../../services/theme.service';
import { ToolI18nService } from '../../services/tool-i18n.service';
import { UiService } from '../../services/ui.service';

type HostStatus = 'idle' | 'starting' | 'ready' | 'error' | 'closed';
type HostMessageState = 'success' | 'info' | 'warning' | 'error' | 'loading';
type ChildLifecycleReason = 'close' | 'restart' | 'destroy';

interface NormalizedHostMessage {
  title: string;
  text: string;
  detail: string;
  state: HostMessageState;
  logState: string;
  showMessage: boolean;
  sendToLog: boolean;
  duration?: number;
}

@Component({
  selector: 'app-child-tool-host',
  imports: [
    CommonModule,
    TranslateModule,
    NzToolTipModule,
    SubWindowComponent,
    ToolContainerComponent
  ],
  templateUrl: './child-tool-host.component.html',
  styleUrl: './child-tool-host.component.scss'
})
export class ChildToolHostComponent implements OnInit, OnChanges, OnDestroy {
  @Input() toolId = '';
  @Input() active = true;

  currentUrl = '';
  resolvedToolId = '';
  titleKey = '';
  routePath = '';
  hostStatus: HostStatus = 'idle';
  iframeSrc: SafeResourceUrl | null = null;
  frameLoaded = false;
  errorMessage = '';
  serverInfo: ChildToolHostInfo | null = null;
  closing = false;

  private config: ChildToolConfig | null = null;
  private initialized = false;
  private acquired = false;
  private penpalConnection: Connection | null = null;
  private remoteApi: any = null;
  private childReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private penpalRemoteWindow: Window | null = null;
  private penpalState: 'idle' | 'connecting' | 'connected' | 'failed' = 'idle';
  private readonly hostContextId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  private hostContextVersion = 0;
  private beforeCloseNotified = false;
  private langSubscription: Subscription | null = null;
  private themeSubscription: Subscription | null = null;
  private toolSignalSubscription: Subscription | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private uiService: UiService,
    private toolI18n: ToolI18nService,
    private sanitizer: DomSanitizer,
    private processService: ChildToolProcessService,
    private ngZone: NgZone,
    private translate: TranslateService,
    private themeService: ThemeService,
    private message: NzMessageService,
    private logService: LogService
  ) {
    this.langSubscription = this.translate.onLangChange.subscribe(() => this.syncHostContext());
    this.themeSubscription = this.themeService.themeChanged$.subscribe(() => this.syncHostContext());
  }

  get isStandalone(): boolean {
    return this.currentUrl.startsWith('/child-tool/');
  }

  get backendFailedKey(): string {
    return this.key('BACKEND_FAILED');
  }

  get backendFailedText(): string {
    return this.translateWithFallback(this.backendFailedKey, {
      zh_cn: '子应用启动失败',
      zh_hk: '子應用啟動失敗',
      default: 'Child app failed to start'
    });
  }

  get isLoading(): boolean {
    return this.hostStatus === 'starting' || (this.hostStatus === 'ready' && !this.frameLoaded);
  }

  ngOnInit(): void {
    this.initialized = true;
    this.toolSignalSubscription = this.uiService.actionSubject.subscribe((action: any) => this.forwardToolSignal(action));
    void this.initTool();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.initialized && changes['toolId'] && !changes['toolId'].firstChange) {
      void this.initTool();
    }

    if (this.initialized && changes['active'] && this.active) {
      this.syncHostContext();
    }
  }

  ngOnDestroy(): void {
    void this.notifyChildBeforeClose('destroy');
    this.langSubscription?.unsubscribe();
    this.langSubscription = null;
    this.themeSubscription?.unsubscribe();
    this.themeSubscription = null;
    this.toolSignalSubscription?.unsubscribe();
    this.toolSignalSubscription = null;
    this.destroyPenpalConnection();
    if (this.acquired && this.resolvedToolId) {
      void this.processService.release(this.resolvedToolId);
      this.acquired = false;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    const canClose = await this.notifyChildBeforeClose('close');
    if (!canClose) {
      this.closing = false;
      return;
    }

    if (this.isStandalone) {
      window['iWindow']?.close?.();
      return;
    }

    if (this.resolvedToolId) {
      this.uiService.closeTool(this.resolvedToolId);
    } else {
      this.closing = false;
    }
  }

  async restart(): Promise<void> {
    if (!this.config) return;
    if (!await this.notifyChildBeforeClose('restart')) return;

    this.destroyPenpalConnection();
    this.serverInfo = null;
    this.iframeSrc = null;
    this.frameLoaded = false;
    this.hostStatus = 'closed';
    await this.startServer(true);
  }

  onFrameLoad(event: Event): void {
    const iframe = event.target as HTMLIFrameElement;
    this.log('iframe load', {
      url: this.sanitizeUrl(this.serverInfo?.url),
      hasContentWindow: !!iframe.contentWindow,
      penpalState: this.penpalState
    });

    if (!iframe.contentWindow) {
      this.hostStatus = 'error';
      this.errorMessage = `${this.resolvedToolId} iframe did not expose contentWindow`;
      this.logError('iframe missing contentWindow', this.errorMessage);
      return;
    }

    if (this.shouldReusePenpalConnection(iframe.contentWindow)) {
      this.log('iframe load ignored for existing Penpal session', {
        penpalState: this.penpalState,
        url: this.sanitizeUrl(this.serverInfo?.url)
      });
      return;
    }

    this.startPenpalConnection(iframe);
  }

  private async initTool(): Promise<void> {
    const nextToolId = this.resolveToolId();
    if (!nextToolId) {
      this.showConfigError('Child tool id is missing');
      return;
    }

    this.log('init', {
      inputToolId: this.toolId,
      routeToolId: this.route.snapshot.paramMap.get('toolId'),
      resolvedToolId: nextToolId,
      currentUrl: this.router.url
    });

    if (this.acquired && this.resolvedToolId && this.resolvedToolId !== nextToolId) {
      await this.processService.release(this.resolvedToolId);
      this.acquired = false;
    }

    const config = getChildToolConfig(nextToolId);
    if (!config) {
      this.showConfigError(`Child tool is not registered: ${nextToolId}`);
      return;
    }

    this.config = config;
    this.resolvedToolId = config.id;
    this.titleKey = config.titleKey;
    this.routePath = config.routePath || `/child-tool/${config.id}`;
    this.currentUrl = this.router.url;

    this.log('config loaded', {
      id: config.id,
      childDir: config.childDir,
      entry: config.entry || 'index.js',
      uiIndex: config.uiIndex || 'ui/index.html'
    });

    await this.toolI18n.load(config.id);
    this.log('i18n loaded');
    await this.startServer(false);
  }

  private async startServer(restart: boolean): Promise<void> {
    if (!this.config) return;
    if (!restart && (this.hostStatus === 'starting' || this.hostStatus === 'ready')) {
      return;
    }

    this.hostStatus = 'starting';
    this.errorMessage = '';
    this.frameLoaded = false;
    this.destroyPenpalConnection();
    this.log(restart ? 'restart server' : 'start server');

    try {
      this.serverInfo = restart
        ? await this.processService.restart(this.config.id)
        : await this.processService.acquire(this.config.id);
      this.acquired = true;
      const childToolUrl = this.buildChildToolUrl(this.serverInfo.url);
      this.log('server acquired', this.sanitizeHostInfo(this.serverInfo));
      this.log('iframe url prepared', this.sanitizeUrl(childToolUrl));
      this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(childToolUrl);
      this.hostStatus = 'ready';
    } catch (error) {
      this.hostStatus = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error || '');
      this.logError('start failed', this.errorMessage);
    }
  }

  private startPenpalConnection(iframe: HTMLIFrameElement): void {
    this.destroyPenpalConnection();
    this.penpalRemoteWindow = iframe.contentWindow;
    this.penpalState = 'connecting';

    const allowedOrigin = this.serverInfo?.origin || this.resolveOrigin(this.serverInfo?.url);
    this.log('penpal connect', {
      allowedOrigin: allowedOrigin || '*',
      iframeUrl: this.sanitizeUrl(this.serverInfo?.url)
    });

    const messenger = new WindowMessenger({
      remoteWindow: iframe.contentWindow!,
      allowedOrigins: allowedOrigin ? [allowedOrigin] : ['*']
    });

    this.childReadyTimer = setTimeout(() => {
      if (!this.frameLoaded) {
        this.ngZone.run(() => {
          this.penpalState = 'failed';
          this.hostStatus = 'error';
          this.errorMessage = `${this.resolvedToolId} UI did not report ready`;
          this.logError('child ready timeout', this.errorMessage);
        });
      }
    }, 10000);

    this.penpalConnection = connect({
      messenger,
      methods: {
        getHostContext: () => this.createHostContext(),
        childReady: (payload: any) => {
          this.ngZone.run(() => {
            this.log('child ready', payload || {});
            this.frameLoaded = true;
            this.hostStatus = 'ready';
            this.errorMessage = '';
            if (payload?.pid && this.serverInfo) {
              this.serverInfo = { ...this.serverInfo, pid: Number(payload.pid) || this.serverInfo.pid };
            }
            this.clearChildReadyTimer();
          });
        },
        childError: (error: any) => {
          this.ngZone.run(() => this.handleChildError(error));
        },
        reportHostMessage: (payload: any) => this.ngZone.run(() => this.reportHostMessage(payload)),
        requestClose: () => {
          this.ngZone.run(() => {
            void this.close();
          });
        },
        requestRestart: () => {
          this.ngZone.run(() => {
            void this.restart();
          });
        },
        openExternal: (url: string) => {
          (window as any).electronAPI?.other?.openByBrowser?.(url);
        },
        sendToolSignal: async (signal: string, payload: any = {}) => {
          return await this.sendToolSignalFromChild(signal, payload);
        }
      }
    });

    void this.penpalConnection.promise
      .then(remote => {
        this.log('penpal connected');
        this.remoteApi = remote;
        this.penpalState = 'connected';
        this.beforeCloseNotified = false;
        this.syncHostContext();
      })
      .catch(error => {
        this.ngZone.run(() => {
          this.penpalState = 'failed';
          this.hostStatus = 'error';
          this.errorMessage = error instanceof Error ? error.message : String(error || 'Penpal connection failed');
          this.logError('penpal failed', this.errorMessage);
          this.clearChildReadyTimer();
        });
      });
  }

  private handleChildError(error: any): void {
    const message = this.stringifyHostMessageValue(error?.message ?? error) || `${this.resolvedToolId} child error`;
    const detail = this.stringifyHostMessageValue(error?.detail ?? error?.stack ?? error?.message ?? error) || message;

    this.hostStatus = 'error';
    this.errorMessage = message;
    this.logError('child error', this.errorMessage);
    this.reportHostMessage({
      state: 'error',
      title: this.getToolDisplayName(),
      message,
      detail
    });
    this.clearChildReadyTimer();
  }

  private reportHostMessage(payload: any): { ok: boolean; error?: string } {
    const hostMessage = this.normalizeHostMessage(payload);
    if (!hostMessage) {
      return { ok: false, error: 'message is required' };
    }

    this.emitHostMessage(hostMessage);
    return { ok: true };
  }

  private normalizeHostMessage(payload: any): NormalizedHostMessage | null {
    const data = this.isRecord(payload) ? payload : { message: payload };
    const title = this.stringifyHostMessageValue(data['title']) || this.getToolDisplayName();
    const text = this.stringifyHostMessageValue(data['message'] ?? data['text'] ?? data['detail']);
    const detail = this.stringifyHostMessageValue(data['detail'] ?? data['message'] ?? data['text']);

    if (!text && !detail) {
      return null;
    }

    const state = this.normalizeHostMessageState(data['state'] ?? data['level'] ?? data['type']);
    return {
      title,
      text: text || detail,
      detail: detail || text,
      state,
      logState: this.toLogState(state),
      showMessage: data['showMessage'] !== false,
      sendToLog: data['sendToLog'] !== false,
      duration: this.normalizeMessageDuration(data['duration'] ?? data['nzDuration'])
    };
  }

  private emitHostMessage(hostMessage: NormalizedHostMessage): void {
    if (hostMessage.showMessage) {
      const text = hostMessage.title
        ? `${hostMessage.title}: ${hostMessage.text}`
        : hostMessage.text;
      const options = hostMessage.duration === undefined ? undefined : { nzDuration: hostMessage.duration };

      switch (hostMessage.state) {
        case 'success':
          this.message.success(text, options);
          break;
        case 'warning':
          this.message.warning(text, options);
          break;
        case 'error':
          this.message.error(text, options);
          break;
        case 'loading':
          this.message.loading(text, options);
          break;
        default:
          this.message.info(text, options);
          break;
      }
    }

    if (hostMessage.sendToLog) {
      this.logService.update({
        title: hostMessage.title,
        detail: hostMessage.detail,
        state: hostMessage.logState
      });
    }
  }

  private normalizeHostMessageState(state: any): HostMessageState {
    const normalized = String(state || 'info').trim().toLowerCase();
    if (normalized === 'success' || normalized === 'done') return 'success';
    if (normalized === 'warn' || normalized === 'warning') return 'warning';
    if (normalized === 'error' || normalized === 'failed' || normalized === 'fatal') return 'error';
    if (normalized === 'loading' || normalized === 'doing') return 'loading';
    return 'info';
  }

  private toLogState(state: HostMessageState): string {
    if (state === 'success') return 'done';
    if (state === 'warning') return 'warn';
    if (state === 'loading') return 'doing';
    return state;
  }

  private normalizeMessageDuration(duration: any): number | undefined {
    if (duration === undefined || duration === null || duration === '') return undefined;
    const value = Number(duration);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  private getToolDisplayName(): string {
    const translated = this.titleKey ? this.translate.instant(this.titleKey) : '';
    if (typeof translated === 'string' && translated && translated !== this.titleKey) {
      return translated;
    }
    return this.resolvedToolId || this.toolId || 'Child tool';
  }

  private stringifyHostMessageValue(value: any): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value.trim();
    if (value instanceof Error) return value.message || String(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private isRecord(value: any): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private destroyPenpalConnection(): void {
    this.clearChildReadyTimer();
    this.remoteApi = null;
    if (this.penpalConnection) {
      this.penpalConnection.destroy();
      this.penpalConnection = null;
    }
    this.penpalRemoteWindow = null;
    this.penpalState = 'idle';
  }

  private shouldReusePenpalConnection(contentWindow: Window): boolean {
    return !!this.penpalConnection
      && this.penpalRemoteWindow === contentWindow
      && (this.penpalState === 'connecting' || this.penpalState === 'connected');
  }

  private async notifyChildBeforeClose(reason: ChildLifecycleReason): Promise<boolean> {
    if (this.beforeCloseNotified && reason === 'destroy') {
      return true;
    }

    const beforeClose = this.remoteApi?.beforeClose;
    if (typeof beforeClose !== 'function') {
      this.beforeCloseNotified = true;
      return true;
    }

    try {
      const result = await this.withTimeout(
        Promise.resolve(beforeClose({
          reason,
          toolId: this.resolvedToolId,
          context: this.createHostContext()
        })),
        1500
      );
      const canClose = result !== false && result?.canClose !== false;

      if (!canClose) {
        const message = this.stringifyHostMessageValue(result?.message || result?.reason)
          || this.translateWithFallback(this.key('CLOSE_BLOCKED'), {
            zh_cn: '子应用暂时不能关闭',
            zh_hk: '子應用暫時不能關閉',
            default: 'Child app is not ready to close'
          });
        this.message.warning(message);
        this.log('beforeClose blocked', {
          reason,
          message
        });
        return false;
      }

      this.beforeCloseNotified = true;
      this.log('beforeClose complete', {
        reason,
        result: this.sanitizeLifecycleResult(result)
      });
      return true;
    } catch (error) {
      this.beforeCloseNotified = true;
      this.logError('beforeClose failed', {
        reason,
        error: error instanceof Error ? error.message : String(error || '')
      });
      return true;
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      promise
        .then(value => resolve(value))
        .catch(error => reject(error))
        .finally(() => clearTimeout(timeout));
    });
  }

  private sanitizeLifecycleResult(result: any): any {
    if (!result || typeof result !== 'object') {
      return result;
    }

    return {
      ...result,
      context: undefined
    };
  }

  private clearChildReadyTimer(): void {
    if (this.childReadyTimer) {
      clearTimeout(this.childReadyTimer);
      this.childReadyTimer = null;
    }
  }

  private async pushHostContext(): Promise<void> {
    if (!this.remoteApi?.setHostContext) {
      return;
    }

    const context = this.createHostContext();
    try {
      await Promise.resolve(this.remoteApi.setHostContext(context));
    } catch {
      // Keep iframe usable; a later sync or active switch will retry.
    }
  }

  private syncHostContext(): void {
    if (this.remoteApi?.setHostContext) {
      void this.pushHostContext();
    }
  }

  private forwardToolSignal(action: any): void {
    if (!this.remoteApi?.handleToolSignal) return;
    if (action?.action !== 'signal' || action?.type !== 'tool') return;
    if (action?.payload?.source === this.childSignalSource()) return;

    const task = Promise.resolve(this.remoteApi.handleToolSignal({
      action: action.action,
      type: action.type,
      data: action.data,
      payload: this.cloneSignalPayload(action.payload)
    })).then(() => undefined).catch(() => undefined);

    if (Array.isArray(action?.payload?.waitFor)) {
      action.payload.waitFor.push(task);
    }
  }

  private async sendToolSignalFromChild(signal: string, payload: any = {}): Promise<{ ok: boolean; waitFor: number }> {
    const waitFor: Promise<void>[] = [];
    const nextPayload = {
      ...(payload || {}),
      source: payload?.source || this.childSignalSource()
    };

    if (signal === 'serial-monitor:disconnect') {
      nextPayload.waitFor = waitFor;
    }

    this.uiService.sendToolSignal(signal, nextPayload);

    if (waitFor.length) {
      await Promise.all(waitFor);
    }

    if (signal === 'serial-monitor:disconnect') {
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return { ok: true, waitFor: waitFor.length };
  }

  private cloneSignalPayload(payload: any): any {
    if (!payload || typeof payload !== 'object') return payload || {};
    const { waitFor: _waitFor, ...rest } = payload;
    return rest;
  }

  private childSignalSource(): string {
    return `child-tool:${this.resolvedToolId || this.toolId || 'unknown'}`;
  }

  private buildChildToolUrl(url: string): string {
    const context = this.createHostContext();

    try {
      const nextUrl = new URL(url);
      nextUrl.searchParams.set('lang', context['lang']);
      return nextUrl.toString();
    } catch {
      const separator = url.includes('?') ? '&' : '?';
      const query = new URLSearchParams({
        lang: context['lang']
      });
      return `${url}${separator}${query.toString()}`;
    }
  }

  private createHostContext(): Record<string, string> {
    return {
      toolId: this.resolvedToolId,
      contextId: this.hostContextId,
      version: String(++this.hostContextVersion),
      lang: this.normalizeLang(this.translate.currentLang || this.translate.defaultLang || 'en'),
      theme: this.normalizeTheme(this.themeService.theme()),
      platform: (window as any).electronAPI?.platform?.type || 'browser'
    };
  }

  private normalizeLang(lang: string): string {
    const normalized = String(lang || 'en').trim().toLowerCase().replace(/-/g, '_');
    if (normalized === 'zh' || normalized.startsWith('zh_cn')) return 'zh_cn';
    if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
    return normalized || 'en';
  }

  private normalizeTheme(theme: string): 'light' | 'dark' {
    return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
  }

  private resolveToolId(): string {
    return this.toolId || this.route.snapshot.paramMap.get('toolId') || this.route.snapshot.data['childToolId'] || '';
  }

  private resolveOrigin(url?: string): string {
    if (!url) return '';
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  private key(name: string): string {
    return this.config?.namespace ? `${this.config.namespace}.${name}` : name;
  }

  private translateWithFallback(key: string, fallback: { zh_cn: string; zh_hk: string; default: string }): string {
    const translated = this.translate.instant(key);
    if (typeof translated === 'string' && translated && translated !== key) {
      return translated;
    }

    const lang = this.normalizeLang(this.translate.currentLang || this.translate.defaultLang || 'en');
    if (lang === 'zh_cn') return fallback.zh_cn;
    if (lang === 'zh_hk') return fallback.zh_hk;
    return fallback.default;
  }

  private showConfigError(message: string): void {
    this.hostStatus = 'error';
    this.errorMessage = message;
    this.titleKey = 'MENU.TOOL';
    this.routePath = '';
    this.logError('config error', message);
  }

  private log(stage: string, details?: any): void {
    console.info(`[child-tool-host:${this.resolvedToolId || this.toolId || 'unknown'}] ${stage}`, details ?? '');
  }

  private logError(stage: string, details?: any): void {
    console.error(`[child-tool-host:${this.resolvedToolId || this.toolId || 'unknown'}] ${stage}`, details ?? '');
  }

  private sanitizeHostInfo(info: ChildToolHostInfo | null): any {
    if (!info) return info;

    return {
      ...info,
      url: this.sanitizeUrl(info.url),
      wsUrl: this.sanitizeUrl(info.wsUrl),
      shutdownUrl: this.sanitizeUrl(info.shutdownUrl)
    };
  }

  private sanitizeUrl(url: any): any {
    if (typeof url !== 'string' || !url) return url;

    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('token')) {
        parsed.searchParams.set('token', '<redacted>');
      }
      return parsed.toString();
    } catch {
      return url.replace(/([?&]token=)[^&]+/g, '$1<redacted>');
    }
  }
}
