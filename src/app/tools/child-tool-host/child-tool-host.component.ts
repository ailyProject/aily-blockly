import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, Input, NgZone, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { Connection, WindowMessenger, connect } from 'penpal';
import { combineLatest, firstValueFrom, Subscription } from 'rxjs';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { ChildToolConfig, getChildToolConfig } from '../../configs/tool.config';
import { ChildToolHostInfo, ChildToolProcessService } from '../../services/child-tool-process.service';
import {
  type SubappCatalogItem,
  type SubappInstallProgress,
  SubappManagerService,
} from '../../services/subapp-manager.service';
import {
  ChildAppHostRegistryService,
  type ChildAppWindowPlacement,
} from '../../services/child-app-host-registry.service';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { ElectronService } from '../../services/electron.service';
import { LogService } from '../../services/log.service';
import { MainUiAutomationService } from '../../services/main-ui-automation.service';
import { NoticeService } from '../../services/notice.service';
import { ProjectService } from '../../services/project.service';
import { ThemeService } from '../../services/theme.service';
import { ToolI18nService } from '../../services/tool-i18n.service';
import { UiService } from '../../services/ui.service';
import { toHostResourceLifecycleRequest } from '../../services/subapp-resource-lifecycle-adapter';
import {
  SubappActivityService,
  type SubappActivity,
} from '../../services/subapp-activity.service';
import { ChatSubappDockComponent } from '../aily-chat/components/subapp-activity/chat-subapp-dock.component';

type HostStatus = 'idle' | 'starting' | 'ready' | 'error' | 'closed';
type HostMessageState = 'success' | 'info' | 'warning' | 'error' | 'loading';
type ChildLifecycleReason = 'close' | 'restart' | 'destroy';

interface HostProjectContext {
  workspace?: string | null;
  version?: number;
}

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

interface ChildSurfaceWindowRequest {
  surface?: string;
  params?: Record<string, string | number | boolean>;
  title?: string;
  width?: number;
  height?: number;
  alwaysOnTop?: boolean;
}

@Component({
  selector: 'app-child-tool-host',
  imports: [
    CommonModule,
    TranslateModule,
    NzToolTipModule,
    SubWindowComponent,
    ToolContainerComponent,
    ChatSubappDockComponent,
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
  childVersion = '';
  closing = false;
  subappUpdateInProgress = false;
  subappUpdateProgress = 0;
  subappRestartInProgress = false;
  uiHealthFailed = false;

  private config: ChildToolConfig | null = null;
  private initialized = false;
  private acquired = false;
  private penpalConnection: Connection | null = null;
  private remoteApi: any = null;
  private childReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private childToolUrl = '';
  private penpalRemoteWindow: Window | null = null;
  private penpalState: 'idle' | 'connecting' | 'connected' | 'failed' = 'idle';
  private readonly hostContextId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  private hostContextVersion = 0;
  private beforeCloseNotified = false;
  private beforeCloseTask: Promise<boolean> | null = null;
  private restartTask: Promise<Record<string, unknown>> | null = null;
  private langSubscription: Subscription | null = null;
  private themeSubscription: Subscription | null = null;
  private projectPathSubscription: Subscription | null = null;
  private blockSelectionSubscription: Subscription | null = null;
  private toolSignalSubscription: Subscription | null = null;
  private subappActivitySubscription: Subscription | null = null;
  private configReloadSubscription: Subscription | null = null;
  private aiWritingStateSubscription: Subscription | null = null;
  private subappCatalogSubscription: Subscription | null = null;
  private subappProgressSubscription: Subscription | null = null;
  private subappRestartRequired = false;
  private lastKnownApiServer = '';
  private standaloneWorkspace: string | null | undefined;
  private standaloneWorkspaceVersion = -1;
  private projectContextListenerRegistered = false;
  private projectContextListenerCleanup: (() => void) | null = null;
  private unregisterHostController: (() => void) | null = null;
  private ailyChatOperationActive = false;
  private ailyChatOperationSessionId = '';
  private aiOperationNoticeShown = false;
  ailyChatSessionId = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private uiService: UiService,
    private toolI18n: ToolI18nService,
    private sanitizer: DomSanitizer,
    private processService: ChildToolProcessService,
    private projectService: ProjectService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService,
    private themeService: ThemeService,
    private message: NzMessageService,
    private modal: NzModalService,
    private logService: LogService,
    private childHostRegistry: ChildAppHostRegistryService,
    private authService: AuthService,
    private configService: ConfigService,
    private blocklyService: BlocklyService,
    private electronService: ElectronService,
    private mainUiAutomation: MainUiAutomationService,
    private subappManager: SubappManagerService,
    private noticeService: NoticeService,
    private subappActivityService: SubappActivityService,
  ) {
    this.langSubscription = this.translate.onLangChange.subscribe(() => this.syncHostContext());
    this.themeSubscription = this.themeService.themeChanged$.subscribe(() => this.syncHostContext());
    this.projectPathSubscription = this.projectService.currentProjectPath$.subscribe(() => {
      if (this.initialized) {
        this.syncHostContext(true);
      }
    });
    this.blockSelectionSubscription = combineLatest([
      this.blocklyService.selectedBlockIdsSubject,
      this.blocklyService.blockCodeMapSubject,
    ]).subscribe(() => {
      if (this.initialized && this.isAilyChatTool()) {
        this.syncHostContext();
      }
    });
    this.aiWritingStateSubscription = combineLatest([
      this.blocklyService.aiWriting$,
      this.blocklyService.aiWaitWriting$,
    ]).subscribe(([writing, waitWriting]) => {
      if (!writing && !waitWriting && !this.ailyChatOperationActive) {
        this.clearAiOperationNotice();
      }
    });
    this.lastKnownApiServer = this.normalizeApiServer(this.configService.getCurrentApiServer());
    this.configReloadSubscription = this.configService.configReloaded$.subscribe(() => {
      this.handleApiServerChange();
    });
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

  get childUiUnavailableText(): string {
    return this.translateWithFallback(this.key('UI_UNRESPONSIVE'), {
      zh_cn: '子应用界面无响应，后台任务仍会继续运行。',
      zh_hk: '子應用介面沒有回應，背景任務仍會繼續執行。',
      default: 'The child interface is not responding. Background tasks will continue.'
    });
  }

  get childUiUnavailableTitle(): string {
    return this.translateWithFallback(this.key('UI_UNAVAILABLE'), {
      zh_cn: '子应用界面暂时不可用',
      zh_hk: '子應用介面暫時不可用',
      default: 'Child interface is temporarily unavailable'
    });
  }

  get canReloadChildUi(): boolean {
    return !!this.childToolUrl && this.acquired;
  }

  get reloadChildUiText(): string {
    return this.translateWithFallback(this.key('RELOAD_UI'), {
      zh_cn: '重新加载界面',
      zh_hk: '重新載入介面',
      default: 'Reload interface'
    });
  }

  get isAilyChat(): boolean {
    return this.isAilyChatTool();
  }

  get showSubappVersionAction(): boolean {
    return !!this.currentSubappCatalogItem
      && (this.subappUpdateInProgress
        || this.subappRestartInProgress
        || this.currentSubappCatalogItem.updateAvailable
        || this.isSubappRestartRequired);
  }

  get subappVersionActionLabel(): string {
    if (this.subappUpdateInProgress) {
      const progress = this.subappUpdateProgress > 0 ? ` ${this.subappUpdateProgress}%` : '';
      return `${this.translate.instant('APP_STORE.DOWNLOADING_UPDATE')}${progress}`;
    }
    if (this.subappRestartInProgress) {
      return this.translate.instant('APP_STORE.RESTARTING');
    }
    if (this.currentSubappCatalogItem?.updateAvailable) {
      return this.translate.instant('APP_STORE.UPDATE');
    }
    return this.translate.instant('APP_STORE.RESTART');
  }

  get subappVersionActionTooltip(): string {
    const item = this.currentSubappCatalogItem;
    if (!this.subappVersionActionBusy && item?.updateAvailable) {
      return this.translate.instant('APP_STORE.UPDATE_TOOLTIP', {
        available: item.availableVersion,
      });
    }
    return this.subappVersionActionLabel;
  }

  get subappVersionActionBusy(): boolean {
    return this.subappUpdateInProgress || this.subappRestartInProgress;
  }

  get isSubappRestartRequired(): boolean {
    const installedVersion = String(this.currentSubappCatalogItem?.installedVersion || '').trim();
    const runningVersion = String(this.childVersion || '').trim();
    return this.subappRestartRequired
      || (!!installedVersion && !!runningVersion && installedVersion !== runningVersion);
  }

  ngOnInit(): void {
    this.initialized = true;
    this.subappCatalogSubscription = this.subappManager.state$.subscribe(() => {
      this.syncSubappRestartRequirement();
      this.cdr.markForCheck();
    });
    this.subappProgressSubscription = this.subappManager.progress$.subscribe((progress) => {
      this.applySubappUpdateProgress(progress);
      this.cdr.markForCheck();
    });
    this.toolSignalSubscription = this.uiService.actionSubject.subscribe((action: any) => this.forwardToolSignal(action));
    this.subappActivitySubscription = this.subappActivityService.activities$.subscribe(() => {
      if (this.initialized && this.isAilyChatTool()) {
        this.pushChatSubappActivities();
        this.cdr.markForCheck();
      }
    });
    void this.initTool();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.initialized && changes['toolId'] && !changes['toolId'].firstChange) {
      void this.initTool();
    }

    if (this.initialized && changes['active']) {
      this.syncHostContext(true);
    }
  }

  ngOnDestroy(): void {
    this.langSubscription?.unsubscribe();
    this.langSubscription = null;
    this.themeSubscription?.unsubscribe();
    this.themeSubscription = null;
    this.projectPathSubscription?.unsubscribe();
    this.projectPathSubscription = null;
    this.blockSelectionSubscription?.unsubscribe();
    this.blockSelectionSubscription = null;
    this.toolSignalSubscription?.unsubscribe();
    this.toolSignalSubscription = null;
    this.subappActivitySubscription?.unsubscribe();
    this.subappActivitySubscription = null;
    this.configReloadSubscription?.unsubscribe();
    this.configReloadSubscription = null;
    this.aiWritingStateSubscription?.unsubscribe();
    this.aiWritingStateSubscription = null;
    this.subappCatalogSubscription?.unsubscribe();
    this.subappCatalogSubscription = null;
    this.subappProgressSubscription?.unsubscribe();
    this.subappProgressSubscription = null;
    this.clearAiOperationNotice();
    this.projectContextListenerCleanup?.();
    this.projectContextListenerCleanup = null;
    this.projectContextListenerRegistered = false;
    this.unregisterHostController?.();
    this.unregisterHostController = null;
    const releaseToolId = this.acquired ? this.resolvedToolId : '';
    this.acquired = false;
    const finishDestroy = () => {
      this.destroyPenpalConnection();
      if (releaseToolId) {
        void this.processService.release(releaseToolId);
      }
    };
    void this.notifyChildBeforeClose('destroy').then(finishDestroy, finishDestroy);
  }

  async close(): Promise<Record<string, unknown>> {
    if (this.closing) return { ok: false, message: '子应用正在关闭' };
    this.closing = true;

    const canClose = await this.notifyChildBeforeClose('close');
    if (!canClose) {
      this.closing = false;
      return { ok: false, message: '子应用拒绝关闭，可能存在未完成操作。' };
    }

    if (this.isStandalone) {
      window['iWindow']?.close?.();
      return { ok: true, toolId: this.resolvedToolId, action: 'close', mode: 'window' };
    }

    if (this.resolvedToolId) {
      this.uiService.closeTool(this.resolvedToolId);
    } else {
      this.closing = false;
    }
    return { ok: true, toolId: this.resolvedToolId, action: 'close', mode: 'embedded' };
  }

  restart(): Promise<Record<string, unknown>> {
    if (this.restartTask) {
      return this.restartTask;
    }

    const task = this.performRestart();
    this.restartTask = task;
    const clearRestartTask = () => {
      if (this.restartTask === task) {
        this.restartTask = null;
      }
    };
    void task.then(clearRestartTask, clearRestartTask);
    return task;
  }

  async runSubappVersionAction(event: Event): Promise<void> {
    event.stopPropagation();
    if (this.subappVersionActionBusy) return;

    const item = this.currentSubappCatalogItem;
    if (!item) return;

    if (item.updateAvailable) {
      await this.downloadSubappUpdate(item);
      return;
    }

    if (this.isSubappRestartRequired) {
      this.confirmUpdatedSubappRestart();
    }
  }

  async reloadChildUi(): Promise<void> {
    this.uiHealthFailed = false;
    await this.reloadChildFrame('manual');
  }

  private handleApiServerChange(): void {
    const nextApiServer = this.normalizeApiServer(this.configService.getCurrentApiServer());
    if (!nextApiServer || nextApiServer === this.lastKnownApiServer) {
      return;
    }

    const previousApiServer = this.lastKnownApiServer;
    this.lastKnownApiServer = nextApiServer;
    if (!this.initialized || !this.acquired || !this.isAilyChatTool()) {
      return;
    }

    this.log('service region changed', {
      previousApiServer,
      nextApiServer,
    });
    void this.restartForApiServerChange();
  }

  private restartForApiServerChange(): Promise<Record<string, unknown>> {
    if (this.restartTask) {
      return this.restartTask;
    }

    // A region change invalidates the old authentication endpoint. It is a
    // host-owned runtime transition, so it must not remain on the old endpoint
    // when a child beforeClose hook declines a normal user restart.
    const task = this.performRestart(true);
    this.restartTask = task;
    const clearRestartTask = () => {
      if (this.restartTask === task) {
        this.restartTask = null;
      }
    };
    void task.then(clearRestartTask, clearRestartTask);
    return task;
  }

  private async performRestart(force = false): Promise<Record<string, unknown>> {
    if (!this.config) return { ok: false, message: '子应用配置未就绪' };
    if (!force && !await this.notifyChildBeforeClose('restart')) {
      return { ok: false, message: '子应用拒绝重启，可能存在未完成操作。' };
    }

    const updatedConfig = getChildToolConfig(this.resolvedToolId);
    if (!updatedConfig) {
      return { ok: false, message: `子应用配置未找到: ${this.resolvedToolId}` };
    }
    this.config = updatedConfig;
    this.childVersion = updatedConfig.version || '';
    this.titleKey = updatedConfig.titleKey;
    this.routePath = updatedConfig.routePath || `/child-tool/${updatedConfig.id}`;

    this.destroyPenpalConnection();
    this.serverInfo = null;
    this.iframeSrc = null;
    this.frameLoaded = false;
    this.hostStatus = 'closed';
    await this.startServer(true);
    const restartedStatus = this.hostStatus as HostStatus;
    if (restartedStatus === 'ready') {
      this.subappRestartRequired = false;
      return { ok: true, toolId: this.resolvedToolId, action: 'restart', host: this.hostAutomationStatus() };
    }
    return { ok: false, toolId: this.resolvedToolId, action: 'restart', message: this.errorMessage || '子应用重启失败' };
  }

  async detach(options: ChildAppWindowPlacement = {}): Promise<Record<string, unknown>> {
    if (!this.config) return { ok: false, message: '子应用配置未就绪' };
    if (this.isStandalone) {
      return { ok: true, toolId: this.resolvedToolId, action: 'detach', message: '子应用已经处于独立窗口模式。' };
    }
    if (!await this.notifyChildBeforeClose('close')) {
      return { ok: false, message: '子应用拒绝切换到独立窗口，可能存在未完成操作。' };
    }

    const opened = this.uiService.openToolWindow(this.resolvedToolId, {
      title: this.getToolDisplayName(),
      ...options,
    });
    if (!opened) {
      return { ok: false, message: `无法为子应用创建独立窗口: ${this.resolvedToolId}` };
    }
    this.uiService.closeTool(this.resolvedToolId);
    return { ok: true, toolId: this.resolvedToolId, action: 'detach', mode: 'window' };
  }

  async embed(): Promise<Record<string, unknown>> {
    if (!this.isStandalone) {
      return { ok: true, toolId: this.resolvedToolId, action: 'embed', message: '子应用已经处于内嵌模式。' };
    }
    if (!await this.notifyChildBeforeClose('close')) {
      return { ok: false, message: '子应用拒绝放回内嵌，可能存在未完成操作。' };
    }

    window['iWindow']?.goMain?.(this.routePath);
    return { ok: true, toolId: this.resolvedToolId, action: 'embed', mode: 'embedded' };
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
    await this.subappManager.initialize();
    const nextToolId = this.resolveToolId();
    if (!nextToolId) {
      this.showConfigError('Child tool id is missing');
      return;
    }

    if (this.resolvedToolId !== nextToolId) {
      this.ailyChatSessionId = '';
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
    this.childVersion = config.version || '';
    this.subappRestartRequired = false;
    this.titleKey = config.titleKey;
    this.routePath = config.routePath || `/child-tool/${config.id}`;
    this.currentUrl = this.router.url;
    this.registerHostController();

    await this.initializeStandaloneProjectContext();

    this.log('config loaded', {
      id: config.id,
      childDir: config.childDir,
      entry: config.entry || 'index.js',
      uiIndex: config.uiIndex || 'ui/index.html'
    });

    await Promise.all([
      this.toolI18n.load(config.id),
      this.toolI18n.load('app-store'),
    ]);
    this.log('i18n loaded');
    this.syncSubappRestartRequirement();
    await this.startServer(false);
  }

  private get currentSubappCatalogItem(): SubappCatalogItem | null {
    if (!this.resolvedToolId) return null;
    return this.subappManager.state.apps.find((item) => item.toolId === this.resolvedToolId) || null;
  }

  private syncSubappRestartRequirement(): void {
    const item = this.currentSubappCatalogItem;
    const installedVersion = String(item?.installedVersion || '').trim();
    const runningVersion = String(this.childVersion || '').trim();
    if (item?.installed && installedVersion && runningVersion && installedVersion !== runningVersion) {
      this.subappRestartRequired = true;
    }
  }

  private applySubappUpdateProgress(progress: SubappInstallProgress | null): void {
    const catalogId = this.currentSubappCatalogItem?.id;
    if (!catalogId || progress?.id !== catalogId || progress.action !== 'update') {
      if (!progress || progress?.id !== catalogId) {
        this.subappUpdateInProgress = false;
        this.subappUpdateProgress = 0;
      }
      return;
    }

    this.subappUpdateInProgress = progress.phase !== 'complete' && progress.phase !== 'error';
    this.subappUpdateProgress = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
  }

  private async downloadSubappUpdate(item: SubappCatalogItem): Promise<void> {
    const previousInstalledVersion = String(item.installedVersion || '').trim();
    const processRunning = this.hostStatus === 'ready' || this.hostStatus === 'starting';
    let forceClose = false;

    if (processRunning) {
      const confirmed = await this.confirmBusyForceClose('update');
      if (!confirmed) return;
      forceClose = true;
    }

    this.subappUpdateInProgress = true;
    this.subappUpdateProgress = 1;
    this.cdr.markForCheck();
    try {
      // 宿主内更新：先停进程，界面保留并显示「正在更新」，完成后自动重启。
      if (this.resolvedToolId) {
        await this.processService.stop(this.resolvedToolId);
      }
      try {
        await this.subappManager.update(item.id, { forceClose });
      } catch (error) {
        if (forceClose || !this.isBusyForceRequiredError(error)) {
          throw error;
        }
        const confirmed = await this.confirmBusyForceClose('update');
        if (!confirmed) return;
        forceClose = true;
        this.subappUpdateInProgress = true;
        this.cdr.markForCheck();
        await this.subappManager.update(item.id, { forceClose: true });
      }

      const updatedItem = this.currentSubappCatalogItem;
      const updatedInstalledVersion = String(updatedItem?.installedVersion || '').trim();
      const shouldRestart = !!updatedItem?.installed
        && !!updatedInstalledVersion
        && updatedInstalledVersion !== previousInstalledVersion;
      this.message.success(this.translate.instant('APP_STORE.UPDATE_SUCCESS', {
        name: this.getToolDisplayName(),
      }));
      if (shouldRestart || forceClose || processRunning) {
        this.subappRestartRequired = false;
        await this.restartUpdatedSubapp();
      }
    } catch (error) {
      if (!this.isBusyCancelledError(error)) {
        this.showSubappActionError(error);
      }
    } finally {
      this.subappUpdateInProgress = false;
      this.cdr.markForCheck();
    }
  }

  private confirmBusyForceClose(action: 'update' | 'uninstall' | string): Promise<boolean> {
    const name = this.getToolDisplayName();
    const actionLabel = action === 'uninstall'
      ? this.translate.instant('APP_STORE.UNINSTALL')
      : this.translate.instant('APP_STORE.UPDATE');
    return new Promise((resolve) => {
      this.modal.confirm({
        nzClassName: 'subapp-service-confirm-modal',
        nzTitle: this.translate.instant('APP_STORE.BUSY_TITLE'),
        nzContent: this.translate.instant('APP_STORE.BUSY_MESSAGE', {
          name,
          action: actionLabel,
        }),
        nzOkText: this.translate.instant('APP_STORE.FORCE_CLOSE_CONTINUE'),
        nzCancelText: this.translate.instant('APP_STORE.CANCEL'),
        nzOkDanger: true,
        nzMaskClosable: false,
        nzOnOk: () => resolve(true),
        nzOnCancel: () => resolve(false),
      });
    });
  }

  private isBusyForceRequiredError(error: unknown): boolean {
    const err = error as { code?: string; requiresForceClose?: boolean; message?: string } | null;
    if (!err) return false;
    if (err.requiresForceClose === true || err.code === 'EBUSY') return true;
    return /EBUSY|resource busy|被占用/i.test(String(err.message || ''));
  }

  private isBusyCancelledError(error: unknown): boolean {
    const err = error as { code?: string; message?: string } | null;
    if (!err) return false;
    if (err.code === 'EBUSY_CANCELLED') return true;
    return /已取消强制关闭|BUSY_CANCELLED/i.test(String(err.message || ''));
  }

  private async restartUpdatedSubapp(): Promise<void> {
    this.subappRestartInProgress = true;
    try {
      const result = await this.mainUiAutomation.controlChildApp({
        toolId: this.resolvedToolId,
        action: 'restart',
      });
      if (result['ok'] !== true) {
        throw new Error(String(result['message'] || this.translate.instant('APP_STORE.RESTART_FAILED')));
      }
      this.subappRestartRequired = false;
      this.message.success(this.translate.instant('APP_STORE.RESTART_SUCCESS', {
        name: this.getToolDisplayName(),
      }));
    } catch (error) {
      this.subappRestartRequired = true;
      this.showSubappActionError(error);
    } finally {
      this.subappRestartInProgress = false;
      this.cdr.markForCheck();
    }
  }

  private confirmUpdatedSubappRestart(): void {
    const name = this.getToolDisplayName();
    this.modal.confirm({
      nzClassName: 'subapp-service-confirm-modal',
      nzTitle: this.translate.instant('APP_STORE.RESTART_CONFIRM', { name }),
      nzContent: this.translate.instant('APP_STORE.RESTART_HINT', { name }),
      nzOkText: this.translate.instant('APP_STORE.CONFIRM_RESTART'),
      nzCancelText: this.translate.instant('APP_STORE.CANCEL'),
      nzMaskClosable: false,
      nzOnOk: () => this.restartUpdatedSubapp(),
    });
  }

  private showSubappActionError(error: unknown): void {
    const actionError = error instanceof Error ? error.message : String(error || 'Unknown error');
    this.message.error(this.translate.instant('APP_STORE.ACTION_FAILED', { message: actionError }));
  }

  private registerHostController(): void {
    this.unregisterHostController?.();
    this.unregisterHostController = this.childHostRegistry.register(this.resolvedToolId, {
      status: () => this.hostAutomationStatus(),
      restart: () => this.restart(),
      close: () => this.close(),
      detach: options => this.detach(options),
      embed: () => this.embed(),
    }, {
      instanceId: this.hostContextId,
      surface: this.resolveLaunchContext().surface,
      primary: this.resolveLaunchContext().surface === 'default',
    });
  }

  private hostAutomationStatus(): Record<string, unknown> {
    return {
      status: this.hostStatus,
      frameLoaded: this.frameLoaded,
      penpalState: this.penpalState,
      closing: this.closing,
      error: this.errorMessage || null,
      version: this.childVersion || null,
      pid: this.serverInfo?.pid ?? null,
      port: this.serverInfo?.port ?? null,
    };
  }

  private async startServer(restart: boolean): Promise<void> {
    if (!this.config) return;
    if (!restart && (this.hostStatus === 'starting' || this.hostStatus === 'ready')) {
      return;
    }

    this.hostStatus = 'starting';
    this.errorMessage = '';
    this.frameLoaded = false;
    this.uiHealthFailed = false;
    this.childToolUrl = '';
    this.destroyPenpalConnection();
    this.log(restart ? 'restart server' : 'start server');

    try {
      this.serverInfo = restart
        ? await this.processService.restart(this.config.id)
        : await this.processService.acquire(this.config.id);
      this.acquired = true;
      const childToolUrl = this.buildChildToolUrl(this.serverInfo.url);
      this.childToolUrl = childToolUrl;
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
          this.uiHealthFailed = true;
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
            this.uiHealthFailed = false;
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
        notifyUserInteraction: (payload: any) => this.notifyUserInteraction(payload),
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
        startGithubLogin: (payload: { inviteCode?: string } = {}) => this.startGithubLogin(payload),
        selectChatResources: () => this.selectChatResources(),
        listChildApps: (payload: { limit?: number } = {}) => this.listChatChildApps(payload),
        openChildApp: (payload: { toolId?: string; mode?: 'embedded' | 'window' } = {}) => this.openChatChildApp(payload),
        openChildSurfaceWindow: (payload: ChildSurfaceWindowRequest = {}) => this.openChildSurfaceWindow(payload),
        focusChildFrame: () => this.focusChildFrame(),
        writeClipboardText: (payload: { text?: string } = {}) => this.writeClipboardText(payload),
        reportAiOperationState: (payload: { active?: boolean; sessionId?: string | null } = {}) => {
          return this.ngZone.run(() => this.reportAiOperationState(payload));
        },
        reportActiveChatSession: (payload: { sessionId?: string | null } = {}) => {
          return this.ngZone.run(() => this.reportActiveChatSession(payload));
        },
        setSubappSurfaceState: (payload: {
          sessionId?: string;
          toolId?: string;
          surfaceState?: 'collapsed' | 'expanded';
        } = {}) => this.ngZone.run(() => this.setSubappSurfaceState(payload)),
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
        this.pushChatSubappActivities();
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

    this.frameLoaded = false;
    this.uiHealthFailed = true;
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

  private normalizeApiServer(value: unknown): string {
    return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  }

  private isRecord(value: any): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private destroyPenpalConnection(): void {
    this.clearChildReadyTimer();
    this.setAilyChatOperationActive(false);
    this.remoteApi = null;
    if (this.penpalConnection) {
      this.penpalConnection.destroy();
      this.penpalConnection = null;
    }
    this.penpalRemoteWindow = null;
    this.penpalState = 'idle';
  }

  private async reloadChildFrame(reason: 'manual'): Promise<void> {
    if (!this.childToolUrl || this.hostStatus === 'closed') return;

    this.log('reload child UI', { reason });
    this.frameLoaded = false;
    this.uiHealthFailed = false;
    this.hostStatus = 'starting';
    this.errorMessage = '';
    this.destroyPenpalConnection();
    this.iframeSrc = null;
    this.cdr.detectChanges();

    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const reloadUrl = this.withReloadToken(this.childToolUrl);
    this.ngZone.run(() => {
      this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(reloadUrl);
      this.cdr.markForCheck();
    });
  }

  private withReloadToken(value: string): string {
    try {
      const url = new URL(value);
      url.searchParams.set('_ailyUiReload', String(Date.now()));
      return url.toString();
    } catch {
      const separator = value.includes('?') ? '&' : '?';
      return `${value}${separator}_ailyUiReload=${Date.now()}`;
    }
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

    if (this.beforeCloseTask) {
      return this.beforeCloseTask;
    }

    const task = this.runChildBeforeClose(reason);
    this.beforeCloseTask = task;
    const clearBeforeCloseTask = () => {
      if (this.beforeCloseTask === task) {
        this.beforeCloseTask = null;
      }
    };
    void task.then(clearBeforeCloseTask, clearBeforeCloseTask);
    return task;
  }

  private async runChildBeforeClose(reason: ChildLifecycleReason): Promise<boolean> {
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
      const errorRecord = this.isRecord(error) ? error : {};
      const errorMessage = this.stringifyHostMessageValue(errorRecord['message'] ?? error)
        || 'Unknown child lifecycle error';
      const errorCode = this.stringifyHostMessageValue(errorRecord['code'] ?? errorRecord['penpalCode']);
      this.logError(
        'beforeClose failed',
        `reason=${reason}${errorCode ? ` code=${errorCode}` : ''} error=${errorMessage}`
      );
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

  private async pushHostContext(refreshSnapshot = false): Promise<void> {
    if (!this.remoteApi?.setHostContext) {
      return;
    }

    const context = this.createHostContext();
    try {
      await Promise.resolve(this.remoteApi.setHostContext(context));
      if (refreshSnapshot && typeof this.remoteApi.refreshHostSnapshot === 'function') {
        await Promise.resolve(this.remoteApi.refreshHostSnapshot());
      }
    } catch {
      // Keep iframe usable; a later sync or active switch will retry.
    }
  }

  private syncHostContext(refreshSnapshot = false): void {
    if (this.remoteApi?.setHostContext) {
      void this.pushHostContext(refreshSnapshot);
    }
  }

  private forwardToolSignal(action: any): void {
    if (action?.action !== 'signal' || action?.type !== 'tool') return;
    if (action?.payload?.source === this.childSignalSource()) return;

    const payload = this.cloneSignalPayload(action.payload);
    const resourceRequest = toHostResourceLifecycleRequest(String(action.data || ''), payload);
    // Resource handoff is delivered directly to every compatible running
    // Runtime by SubappResourceLifecycleService. Keeping it out of the iframe
    // path makes the handoff independent of full/compact UI lifecycle.
    if (resourceRequest || typeof this.remoteApi?.handleToolSignal !== 'function') return;
    const task = Promise.resolve(this.remoteApi.handleToolSignal({
      action: action.action,
      type: action.type,
      data: action.data,
      payload
    })).then(() => undefined).catch(() => undefined);

    if (Array.isArray(action?.payload?.waitFor)) {
      action.payload.waitFor.push(task);
    } else {
      void task.catch(() => undefined);
    }
  }

  private async sendToolSignalFromChild(signal: string, payload: any = {}): Promise<{ ok: boolean; waitFor: number }> {
    const waitFor: Promise<void>[] = [];
    const nextPayload = {
      ...(payload || {}),
      source: this.childSignalSource(),
      senderToolId: this.resolvedToolId,
      senderContextId: this.hostContextId,
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
    const launch = this.resolveLaunchContext();

    try {
      const nextUrl = new URL(url);
      nextUrl.searchParams.set('lang', String(context['lang'] || 'en'));
      nextUrl.searchParams.set('surface', launch.surface);
      nextUrl.searchParams.set('launch', JSON.stringify(launch.params));
      return nextUrl.toString();
    } catch {
      const separator = url.includes('?') ? '&' : '?';
      const query = new URLSearchParams({
        lang: String(context['lang'] || 'en'),
        surface: launch.surface,
        launch: JSON.stringify(launch.params),
      });
      return `${url}${separator}${query.toString()}`;
    }
  }

  private createHostContext(): Record<string, unknown> {
    const isAilyChat = this.isAilyChatTool();
    const launch = this.resolveLaunchContext();
    return {
      toolId: this.resolvedToolId,
      contextId: this.hostContextId,
      version: String(++this.hostContextVersion),
      lang: this.normalizeLang(this.translate.currentLang || this.translate.defaultLang || 'en'),
      theme: this.normalizeTheme(this.themeService.theme()),
      platform: (window as any).electronAPI?.platform?.type || 'browser',
      embedded: !this.isStandalone,
      surface: launch.surface,
      surfaceParams: launch.params,
      workspace: this.resolveHostWorkspace(),
      blockResources: isAilyChat && this.active ? this.createSelectedBlockResources() : [],
      capabilities: {
        snapshotRefresh: true,
        userInteractionNotifications: true,
        hostGithubLogin: isAilyChat,
        resourcePicker: isAilyChat
          && typeof (window as any).dialog?.selectFiles === 'function',
        childAppMenu: isAilyChat,
        clipboardWrite: isAilyChat,
        blockSelectionContext: isAilyChat,
        childFrameFocus: isAilyChat,
        childSurfaceWindow: true,
        aiOperationState: isAilyChat,
        subappDock: isAilyChat
      }
    };
  }

  private resolveLaunchContext(): { surface: string; params: Record<string, string> } {
    const requestedSurface = String(this.route.snapshot.queryParamMap.get('surface') || 'default').trim();
    const surfaces = this.config?.ui?.surfaces || {};
    const surface = Object.hasOwn(surfaces, requestedSurface) ? requestedSurface : 'default';
    const rawLaunch = this.route.snapshot.queryParamMap.get('launch');
    if (!rawLaunch || rawLaunch.length > 4096) return { surface, params: {} };
    try {
      const parsed = JSON.parse(rawLaunch);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { surface, params: {} };
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed).slice(0, 20)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) continue;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
        const text = String(value);
        if (text.length <= 512) params[key] = text;
      }
      return { surface, params };
    } catch {
      return { surface, params: {} };
    }
  }

  private openChildSurfaceWindow(payload: ChildSurfaceWindowRequest): Record<string, unknown> {
    if (!this.config) return { ok: false, code: 'CHILD_CONFIG_UNAVAILABLE' };
    const surface = String(payload?.surface || '').trim();
    const surfaceConfig = this.config.ui?.surfaces?.[surface];
    if (!surface || !surfaceConfig) return { ok: false, code: 'SURFACE_NOT_AVAILABLE' };
    const params: Record<string, string> = {};
    if (payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)) {
      for (const [key, value] of Object.entries(payload.params).slice(0, 20)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) continue;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
        const text = String(value);
        if (text.length <= 512) params[key] = text;
      }
    }
    const query = new URLSearchParams({ surface, launch: JSON.stringify(params) });
    const path = `${this.config.routePath || `/child-tool/${this.config.id}`}?${query.toString()}`;
    const width = Math.max(surfaceConfig.minWidth || 400, Math.min(1800, Number(payload.width) || 1020));
    const height = Math.max(surfaceConfig.minHeight || 300, Math.min(1200, Number(payload.height) || surfaceConfig.preferredHeight || 720));
    this.uiService.openWindow({
      path: path.replace(/^\/+/, ''),
      title: typeof payload.title === 'string' ? payload.title.slice(0, 160) : this.titleKey,
      width,
      height,
      alwaysOnTop: payload.alwaysOnTop === true,
      relativeToDisplay: true,
      clampToWorkArea: true,
    });
    return { ok: true, state: 'opened', surface, path };
  }

  private reportActiveChatSession(
    payload: { sessionId?: string | null } = {},
  ): Record<string, unknown> {
    if (!this.isAilyChatTool()) {
      return { ok: false, message: 'Active chat session reporting is only available to Aily Chat' };
    }

    const sessionId = typeof payload.sessionId === 'string'
      ? payload.sessionId.trim().slice(0, 512)
      : '';
    if (sessionId === this.ailyChatSessionId) {
      this.pushChatSubappActivities();
      this.cdr.markForCheck();
      return { ok: true, sessionId: sessionId || null };
    }

    this.ailyChatSessionId = sessionId;
    this.pushChatSubappActivities();
    this.cdr.markForCheck();
    return { ok: true, sessionId: sessionId || null };
  }

  private setSubappSurfaceState(payload: {
    sessionId?: string;
    toolId?: string;
    surfaceState?: 'collapsed' | 'expanded';
  } = {}): Record<string, unknown> {
    if (!this.isAilyChatTool()) {
      return { ok: false, message: 'Subapp Dock controls are only available to Aily Chat' };
    }

    const sessionId = String(payload.sessionId || '').trim();
    const toolId = String(payload.toolId || '').trim();
    const surfaceState = payload.surfaceState;
    if (!sessionId || sessionId !== this.ailyChatSessionId || !toolId) {
      return { ok: false, message: 'Subapp Dock target does not match the active chat session' };
    }
    if (surfaceState !== 'collapsed' && surfaceState !== 'expanded') {
      return { ok: false, message: 'Subapp Dock surface state is invalid' };
    }

    const activity = this.subappActivityService.setSurfaceState(sessionId, toolId, surfaceState);
    return activity
      ? { ok: true, sessionId, toolId, surfaceState }
      : { ok: false, message: 'Subapp activity is unavailable for the active chat session' };
  }

  private pushChatSubappActivities(): void {
    if (!this.isAilyChatTool() || typeof this.remoteApi?.setSubappActivities !== 'function') {
      return;
    }

    const sessionId = this.ailyChatSessionId;
    const items = sessionId
      ? this.subappActivityService.getSessionActivities(sessionId).map(activity => this.projectSubappActivity(activity))
      : [];
    void Promise.resolve(this.remoteApi.setSubappActivities({ sessionId, items })).catch(() => undefined);
  }

  private projectSubappActivity(activity: SubappActivity): Record<string, unknown> {
    return {
      sessionId: activity.sessionId,
      toolId: activity.toolId,
      title: activity.title,
      icon: activity.icon,
      toolName: activity.toolName,
      invocationState: activity.invocationState,
      runtimeState: activity.runtimeState,
      surfaceState: activity.surfaceState,
      invocationCount: activity.invocationCount,
      activeInvocationCount: activity.activeInvocationCount,
      lastUsedAt: activity.lastUsedAt,
      ...(activity.summary ? { summary: { ...activity.summary } } : {}),
    };
  }

  private reportAiOperationState(
    payload: { active?: boolean; sessionId?: string | null } = {},
  ): Record<string, unknown> {
    if (!this.isAilyChatTool()) {
      return { ok: false, message: 'AI operation state is only available to Aily Chat' };
    }

    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (
      payload.active !== true &&
      sessionId &&
      this.ailyChatOperationSessionId &&
      sessionId !== this.ailyChatOperationSessionId
    ) {
      return {
        ok: true,
        active: this.ailyChatOperationActive,
        sessionId: this.ailyChatOperationSessionId,
      };
    }

    this.setAilyChatOperationActive(payload.active === true, sessionId);
    return {
      ok: true,
      active: this.ailyChatOperationActive,
      sessionId: this.ailyChatOperationSessionId || null,
    };
  }

  private setAilyChatOperationActive(active: boolean, sessionId = ''): void {
    if (this.ailyChatOperationActive === active) {
      if (active) {
        if (sessionId) {
          this.ailyChatOperationSessionId = sessionId;
        }
        // 已 active 时仍刷新通知，防止被其它 notice 覆盖后只剩 Blockly 遮罩。
        this.showAiOperationNotice();
      }
      return;
    }

    this.ailyChatOperationActive = active;
    this.ailyChatOperationSessionId = active ? sessionId : '';
    // 会话执行态用于预编译等宿主协调；视觉遮罩由 live Blockly 写入态精确驱动。
    this.blocklyService.setAiExecutionActive(`child-tool:${this.hostContextId}`, active);

    if (active) {
      this.showAiOperationNotice();
      return;
    }

    if (!this.blocklyService.aiWriting && !this.blocklyService.aiWaitWriting) {
      this.clearAiOperationNotice();
    }
  }

  private showAiOperationNotice(): void {
    const sessionId = this.ailyChatOperationSessionId;
    this.aiOperationNoticeShown = true;
    this.noticeService.update({
      title: 'AI正在操作',
      state: 'doing',
      showProgress: false,
      setTimeout: 0,
      sendToLog: false,
      stop: () => {
        void Promise.resolve(this.remoteApi?.stopActiveTurn?.({ sessionId: sessionId || undefined })).catch(error => {
          this.logError('stop active Aily Chat turn failed', error);
        });
      },
    });
  }

  private clearAiOperationNotice(): void {
    if (!this.aiOperationNoticeShown) {
      return;
    }
    this.aiOperationNoticeShown = false;
    this.noticeService.clear();
  }

  private createSelectedBlockResources(): Record<string, unknown>[] {
    return this.blocklyService.getSelectedBlockContextLabels().map(item => ({
      type: 'block',
      name: item.label,
      blockId: item.blockId,
      blockContext: item.formatted,
    }));
  }

  private isAilyChatTool(): boolean {
    return this.resolvedToolId === 'aily-chat' || this.resolvedToolId === 'aily-chat-react';
  }

  private async writeClipboardText(payload: { text?: string }): Promise<Record<string, unknown>> {
    if (!this.isAilyChatTool()) {
      return { ok: false, message: 'Clipboard access is only available to Aily Chat' };
    }
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!text) {
      return { ok: false, message: 'Clipboard text is empty' };
    }
    await this.electronService.clipboardWriteText(text);
    return { ok: true };
  }

  private focusChildFrame(): Record<string, unknown> {
    if (!this.isAilyChatTool() || !this.penpalRemoteWindow) {
      return { ok: false };
    }
    this.penpalRemoteWindow.focus();
    return { ok: true };
  }

  private async selectChatResources(): Promise<Record<string, unknown>> {
    if (!this.isAilyChatTool()) {
      return { ok: false, message: 'Resource selection is only available to Aily Chat' };
    }
    const dialog = (window as any).dialog;
    const fs = (window as any).fs;
    if (!dialog?.selectFiles || !fs?.isDirectory) {
      return { ok: false, message: 'Host file picker is unavailable' };
    }
    const result = await dialog.selectFiles({
      title: '选择文件或文件夹',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    if (result?.canceled || !Array.isArray(result?.filePaths)) {
      return { ok: true, resources: [] };
    }
    const resources = result.filePaths
      .slice(0, 12)
      .map((path: string) => this.createChatResource(path, fs));
    return { ok: true, resources };
  }

  private createChatResource(path: string, fs: any): Record<string, unknown> {
    const name = String(path).split(/[/\\]/).pop() || path;
    if (!fs.isDirectory(path)) {
      return this.createChatFileResource(path, name, fs);
    }

    return {
      type: 'folder',
      path,
      name,
      children: this.collectChatFolderFiles(path, fs),
    };
  }

  private collectChatFolderFiles(rootPath: string, fs: any): Record<string, unknown>[] {
    const resources: Record<string, unknown>[] = [];
    const pending = [rootPath];
    const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build']);

    while (pending.length && resources.length < 36) {
      const directory = pending.shift()!;
      let entries: Array<{ name: string; _isDirectory?: boolean; _isFile?: boolean }> = [];
      try {
        entries = fs.readDirSync(directory);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (resources.length >= 36) break;
        if (entry.name.startsWith('.') && entry.name !== '.env') continue;
        const separator = String(directory).includes('\\') ? '\\' : '/';
        const childPath = `${directory}${separator}${entry.name}`;
        if (entry._isDirectory) {
          if (!ignoredDirectories.has(entry.name)) pending.push(childPath);
          continue;
        }
        if (entry._isFile !== false) {
          resources.push(this.createChatFileResource(childPath, entry.name, fs));
        }
      }
    }

    return resources;
  }

  private createChatFileResource(path: string, name: string, fs: any): Record<string, unknown> {
    const maxInlineBytes = 96 * 1024;
    let size = 0;
    try {
      size = Number(fs.statSync(path)?.size) || 0;
    } catch {
      return { type: 'file', path, name, content: `[${name}: failed to inspect]` };
    }

    let content = `[${name}: binary, ${size} bytes]`;
    if (size > maxInlineBytes) {
      content = `[${name}: ${size} bytes, too large to inline]`;
    } else if (this.isChatTextFile(name)) {
      try {
        content = String(fs.readFileSync(path, 'utf8'));
      } catch {
        content = `[${name}: failed to read]`;
      }
    }

    return { type: 'file', path, name, size, content };
  }

  private isChatTextFile(name: string): boolean {
    const extension = String(name).toLowerCase().split('.').pop() || '';
    return new Set([
      'c', 'cc', 'cpp', 'css', 'csv', 'env', 'h', 'hpp', 'html', 'ino', 'java', 'js',
      'json', 'jsx', 'log', 'md', 'mjs', 'py', 'rs', 'scss', 'sh', 'svg', 'toml',
      'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml',
    ]).has(extension);
  }

  private async listChatChildApps(payload: { limit?: number } = {}): Promise<Record<string, unknown>> {
    if (!this.isAilyChatTool()) {
      return { ok: false, message: 'Child app listing is only available to Aily Chat' };
    }
    return this.mainUiAutomation.listChildApps({
      limit: Math.max(1, Math.min(100, Number(payload?.limit) || 100)),
    });
  }

  private async openChatChildApp(
    payload: { toolId?: string; mode?: 'embedded' | 'window' } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.isAilyChatTool()) {
      return { ok: false, message: 'Opening child apps is only available to Aily Chat' };
    }
    return this.mainUiAutomation.openChildApp({
      toolId: String(payload?.toolId || ''),
      mode: payload?.mode === 'window' ? 'window' : 'embedded',
    });
  }

  private async startGithubLogin(payload: { inviteCode?: string } = {}): Promise<Record<string, unknown>> {
    if (!this.isAilyChatTool()) {
      throw new Error('GitHub login is only available to Aily Chat');
    }

    const inviteCode = typeof payload?.inviteCode === 'string'
      ? payload.inviteCode.trim().slice(0, 11)
      : '';
    const response = await firstValueFrom(this.authService.startGitHubOAuth(inviteCode || undefined));
    if (!response?.authorization_url) {
      throw new Error('GitHub authorization URL is unavailable');
    }

    this.electronService.openUrl(response.authorization_url);
    return { ok: true, state: response.state };
  }

  private async notifyUserInteraction(payload: any): Promise<Record<string, unknown>> {
    return this.electronService.notifyUserInteraction(payload);
  }

  private async initializeStandaloneProjectContext(): Promise<void> {
    if (!this.isStandalone) {
      this.standaloneWorkspace = undefined;
      this.standaloneWorkspaceVersion = -1;
      this.projectContextListenerCleanup?.();
      this.projectContextListenerCleanup = null;
      this.projectContextListenerRegistered = false;
      return;
    }

    const ipcRenderer = window['ipcRenderer'] || (window as any).electronAPI?.ipcRenderer;
    if (!ipcRenderer?.invoke) {
      return;
    }

    if (!this.projectContextListenerRegistered && ipcRenderer.on) {
      const cleanup = ipcRenderer.on(
        'host-project-context-changed',
        (_event: unknown, context: HostProjectContext) => {
          this.ngZone.run(() => this.applyStandaloneProjectContext(context, true));
        }
      );
      if (typeof cleanup === 'function') {
        this.projectContextListenerCleanup = cleanup;
      }
      this.projectContextListenerRegistered = true;
    }

    try {
      const context = await ipcRenderer.invoke('host-project-context-get');
      this.applyStandaloneProjectContext(context, false);
    } catch {
      // Older hosts do not expose project context; keep the local service fallback.
    }
  }

  private applyStandaloneProjectContext(context: HostProjectContext, refreshSnapshot: boolean): void {
    const version = Number(context?.version);
    if (Number.isFinite(version) && version < this.standaloneWorkspaceVersion) {
      return;
    }

    const rawWorkspace = typeof context?.workspace === 'string' ? context.workspace : '';
    const workspace = rawWorkspace.trim() ? rawWorkspace : null;
    const changed = this.standaloneWorkspace !== workspace;

    this.standaloneWorkspace = workspace;
    if (Number.isFinite(version)) {
      this.standaloneWorkspaceVersion = version;
    }

    if (changed && refreshSnapshot) {
      this.syncHostContext(true);
    }
  }

  private resolveHostWorkspace(): string | null {
    if (this.isStandalone && this.standaloneWorkspace !== undefined) {
      return this.standaloneWorkspace;
    }
    return this.projectService.currentProjectPath || null;
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
