import { Component, ChangeDetectorRef, OnDestroy, ViewChild } from '@angular/core';
import { FooterComponent } from './components/footer/footer.component';
import { HeaderComponent } from './components/header/header.component';
import { CommonModule } from '@angular/common';
import { NzLayoutModule } from 'ng-zorro-antd/layout';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { TerminalComponent } from '../tools/terminal/terminal.component';
import { LogComponent } from '../tools/log/log.component';
import { UiService, UpdateService, OnboardingService } from '@core/app-shell/public-api';
import { SerialMonitorComponent } from '../tools/serial-monitor/serial-monitor.component';
import { ChildToolHostComponent } from '../tools/child-tool-host/child-tool-host.component';
import { CodeViewerComponent } from '../editors/blockly-editor/tools/code-viewer/code-viewer.component';
import { ProjectService } from '@domain/project/public-api';
import { SimplebarAngularModule } from 'simplebar-angular';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AppStoreComponent } from '../tools/app-store/app-store.component';
import { AppStoreService } from '../tools/app-store/app-store.service';
import { NzModalModule, NzModalRef, NzModalService } from 'ng-zorro-antd/modal';
import { NpmService } from '@domain/dependencies/public-api';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { distinctUntilChanged, filter, merge, Subscription, take } from 'rxjs';
import { ConfigService, ToolI18nService } from '@core/preferences/public-api';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { CloudSpaceComponent } from '../tools/cloud-space/cloud-space.component';
import { UserCenterComponent } from '../tools/user-center/user-center.component';
import { OnboardingComponent } from '../components/onboarding/onboarding.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { isChildTool } from '../configs/tool.config';
import {
  AuthService,
  type AuthSessionInvalidationRequest,
  type LoginDialogRequestState,
  runAuthSessionInvalidation,
  registerAilyChatHostAuthRuntimeBridge,
} from '@core/auth/public-api';
import { extractApiErrorDetails } from '../utils/api-error.utils';
import { ElectronService } from '@core/platform/public-api';
import {
  SubappManagerService,
  ChildToolProcessService,
  bootstrapDefaultAilyChatSubapp,
  DEFAULT_AILY_CHAT_SUBAPP_BOOTSTRAP_KEY,
  DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID,
} from '@integration/subapps/public-api';
import { LoginComponent } from '../components/login/login.component';
import { LibManagerToolComponent } from '../tools/lib-manager-tool/lib-manager-tool.component';
import { SimulatorSubappHostComponent } from '../tools/simulator/simulator-subapp-host.component';
import { buildChildAuthStateSnapshot } from '../tools/child-tool-host/child-auth-state';
import { CoderSubappInstallNoticeComponent } from '../components/coder-subapp-install-notice/coder-subapp-install-notice.component';

const RIGHT_SIDER_WIDTH_STORAGE_KEY = 'aily-main-window.right-sider-width';
const RIGHT_SIDER_DEFAULT_WIDTH = 450;
const RIGHT_SIDER_MIN_WIDTH = 400;
const RIGHT_SIDER_MAX_WIDTH = 800;

@Component({
  selector: 'app-main-window',
  imports: [
    CommonModule,
    HeaderComponent,
    FooterComponent,
    NzLayoutModule,
    NzResizableModule,
    NzTabsModule,
    TerminalComponent,
    LogComponent,
    SerialMonitorComponent,
    ChildToolHostComponent,
    CodeViewerComponent,
    SimplebarAngularModule,
    AppStoreComponent,
    NzModalModule,
    RouterModule,
    NzToolTipModule,
    CloudSpaceComponent,
    UserCenterComponent,
    OnboardingComponent,
    TranslateModule,
    LibManagerToolComponent,
    SimulatorSubappHostComponent,
    CoderSubappInstallNoticeComponent,
  ],
  templateUrl: './main-window.component.html',
  styleUrl: './main-window.component.scss',
})
export class MainWindowComponent implements OnDestroy {
  @ViewChild('logComponent') logComponent!: LogComponent;
  @ViewChild('terminalComponent') terminalComponent!: TerminalComponent;

  showRbox = false;
  showBbox = false;
  terminalTab = 'log';
  selectedTabIndex = 0;

  get topTool() {
    return this.uiService.topTool;
  }

  get openToolList() {
    return this.uiService.openToolList;
  }

  isChildTool(toolId: string): boolean {
    // Simulator is installed as a Subapp package, but its UI is owned by the
    // dedicated exact-origin host instead of the generic Penpal child host.
    // Aily Chat no longer has an Angular fallback. Keep the canonical id on
    // the child-host path while the default package is being installed so a
    // stale toolbar entry can never remount the retired implementation.
    return toolId !== 'simulator' && (toolId === DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID || isChildTool(toolId));
  }

  options = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 50,
  };

  // 新手引导相关
  showOnboarding = false;
  onboardingConfig = null;
  private oauthResultListener: (() => void) | null = null;
  private exampleListListener: (() => void) | null = null;
  private configNoticeSubscription: Subscription | null = null;
  private projectContextSubscription: Subscription | null = null;
  private projectStateSubscription: Subscription | null = null;
  private loginDialogSubscription: Subscription | null = null;
  private loginModalRef: NzModalRef<LoginComponent> | null = null;
  private authSessionInvalidationSubscription: Subscription | null = null;
  private authStateBroadcastSubscription: Subscription | null = null;
  private authSessionInvalidationPromise: Promise<void> | null = null;
  private cancelAilyChatPrewarm: (() => void) | null = null;
  private ailyChatPrewarmAuthSubscription: Subscription | null = null;
  private unregisterAilyChatHostAuthRuntimeBridge: (() => void) | null = null;

  requestStatsScope: 'default' | 'eu' | null = null;

  constructor(
    private uiService: UiService,
    private projectService: ProjectService,
    private message: NzMessageService,
    private translate: TranslateService,
    private cd: ChangeDetectorRef,
    private updateService: UpdateService,
    private npmService: NpmService,
    private router: Router,
    private configService: ConfigService,
    private modal: NzModalService,
    private onboardingService: OnboardingService,
    private authService: AuthService,
    private electronService: ElectronService,
    private appStoreService: AppStoreService,
    private subappManager: SubappManagerService,
    private childToolProcessService: ChildToolProcessService,
    private toolI18n: ToolI18nService,
  ) { }

  async ngOnInit(): Promise<void> {
    void this.electronService.currentRegion().then(region => {
      this.requestStatsScope = region.toLowerCase() === 'eu' ? 'eu' : 'default';
    });
    this.unregisterAilyChatHostAuthRuntimeBridge = registerAilyChatHostAuthRuntimeBridge(
      this.authService,
      window['ipcRenderer'],
    );
    this.loginDialogSubscription = this.authService.loginDialogRequest$.subscribe((state) => {
      this.handleLoginDialogRequest(state);
    });
    this.authSessionInvalidationSubscription = this.authService.authSessionInvalidationRequest$
      .subscribe((request) => this.handleAuthSessionInvalidation(request));
    this.authStateBroadcastSubscription = merge(
      this.authService.isLoggedIn$,
      this.authService.authChanged$,
    ).subscribe(() => this.broadcastHostAuthState());
    this.watchConfigNotices();
    await Promise.all([
      this.toolI18n.loadChildTools(),
      this.toolI18n.load('aily-chat'),
    ]);
    this.uiService.init();
    this.projectService.init();
    this.projectContextSubscription = this.projectService.currentProjectPath$.subscribe(workspace => {
      window['ipcRenderer']?.send?.('host-project-context-changed', {
        workspace: workspace || null
      });
    });
    this.updateService.init();
    this.npmService.init();
    this.setupGlobalOAuthListener();
    this.setupExampleListListener();
    void this.electronService.sendRendererReady();
    void this.initializeAuthAndPromptIfNeeded();
    void this.ensureDefaultAilyChatSubapp();
    // 重置 footer 状态
    this.uiService.updateFooterState({ text: '', timeout: 0 });

    // 监听路由变化，重置 footer 状态
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe(() => {
      this.uiService.updateFooterState({ text: '', timeout: 0 });
    });

    // 订阅 onboarding 服务
    this.onboardingService.show$.subscribe((show) => {
      this.showOnboarding = show;
      this.cd.detectChanges();
    });
    this.onboardingService.config$.subscribe((config) => {
      this.onboardingConfig = config;
      this.cd.detectChanges();
    });

    // 语言设置变化后，重新加载项目
    window['ipcRenderer']?.on?.('setting-changed', async (event, data) => {
      await this.configService.load();
      if (data.action == 'language-changed' && this.router.url.includes('/main/blockly-editor')) {
        console.log('mainwindow setLanguage', data);
        this.projectService.save();
        setTimeout(() => {
          this.projectService.projectOpen();
        }, 100);
      }
    });
  }

  private handleLoginDialogRequest(state: LoginDialogRequestState | null): void {
    if (!state) {
      this.destroyLoginModal();
      return;
    }

    if (this.loginModalRef) {
      return;
    }

    const lang = (this.translate.currentLang || this.translate.defaultLang || 'en').toLowerCase();
    const modalRef = this.modal.create<LoginComponent, LoginDialogRequestState, void>({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzMaskClosable: false,
      nzKeyboard: false,
      nzCentered: true,
      nzWrapClassName: 'login-modal-wrap',
      nzBodyStyle: { padding: '0' },
      nzMaskStyle: {
        background: 'var(--aily-bg-overlay)',
        backdropFilter: 'blur(6px)',
      },
      nzContent: LoginComponent,
      nzWidth: '900px',
      nzDirection: lang.startsWith('ar') ? 'rtl' : 'ltr',
      nzData: state,
    });

    this.loginModalRef = modalRef;
    modalRef.afterClose.pipe(take(1)).subscribe(() => {
      if (this.loginModalRef !== modalRef) {
        return;
      }
      this.loginModalRef = null;
      this.authService.dismissLoginDialog();
    });
  }

  private destroyLoginModal(): void {
    const modalRef = this.loginModalRef;
    this.loginModalRef = null;
    modalRef?.destroy();
  }

  private async initializeAuthAndPromptIfNeeded(): Promise<void> {
    try {
      await this.authService.initializeAuth();
      if (this.authService.getAuthInitializationState() === 'signed_out') {
        this.authService.requestLogin('startup', { allowSkip: true });
      }
    } catch (error) {
      console.warn('[Auth] Background authentication initialization failed:', error);
    }
  }

  private broadcastHostAuthState(): void {
    if (!this.electronService.isElectron) return;

    window['ipcRenderer']?.send?.(
      'host-auth-state-changed',
      buildChildAuthStateSnapshot(
        this.authService.isLoggedIn,
        this.authService.currentUser,
        this.authService.getAuthSnapshot(),
      ),
    );
  }

  private async ensureDefaultAilyChatSubapp(): Promise<void> {
    try {
      await bootstrapDefaultAilyChatSubapp({
        completed: !!this.configService.data?.[DEFAULT_AILY_CHAT_SUBAPP_BOOTSTRAP_KEY],
        initialize: () => this.subappManager.initialize(),
        readCatalog: () => this.subappManager.state.apps,
        install: catalogId => this.subappManager.install(catalogId),
        isPinned: () => this.appStoreService.isAppInZone('header', DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID),
        pin: () => this.appStoreService.addAppToZone('header', DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID),
        markCompleted: async () => {
          this.configService.data[DEFAULT_AILY_CHAT_SUBAPP_BOOTSTRAP_KEY] = Date.now();
          await this.configService.save();
        },
      });
      this.scheduleAilyChatPrewarm();
    } catch (error) {
      console.warn('[Subapp] Default Aily Chat installation failed:', error);
    }
  }

  private handleAuthSessionInvalidation(request: AuthSessionInvalidationRequest): void {
    if (
      request.errorCode !== 'AUTH_TOKEN_INVALID'
      || !this.authService.isSessionInvalidating
      || this.authSessionInvalidationPromise
    ) {
      return;
    }

    const operation = this.performAuthSessionInvalidation(request);
    this.authSessionInvalidationPromise = operation;
    void operation.finally(() => {
      if (this.authSessionInvalidationPromise === operation) {
        this.authSessionInvalidationPromise = null;
      }
    });
  }

  private async performAuthSessionInvalidation(
    request: AuthSessionInvalidationRequest,
  ): Promise<void> {
    const protectedToolIds = this.uiService.getOpenAuthRequiredToolIds();
    console.warn('[Auth] Invalid token reported; invalidating local session immediately.', {
      errorCode: request.errorCode,
      source: request.source,
      protectedToolIds,
    });

    await runAuthSessionInvalidation({
      closeProtectedTools: () => this.uiService.closeAuthRequiredTools(protectedToolIds),
      forceCloseProtectedTools: async () => {
        for (const toolId of protectedToolIds) {
          const closed = await this.uiService.forceCloseToolEverywhere(toolId);
          if (!closed) {
            throw new Error(`Unable to force close protected tool: ${toolId}`);
          }
        }
      },
      stopProtectedRuntime: async () => {
        this.cancelAilyChatPrewarm?.();
        this.cancelAilyChatPrewarm = null;
        this.ailyChatPrewarmAuthSubscription?.unsubscribe();
        this.ailyChatPrewarmAuthSubscription = null;
        if (this.electronService.isElectron) {
          await this.childToolProcessService.forceStop(DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID);
        }
      },
      clearLocalAuthSession: () => this.authService.clearLocalAuthSession(),
      completeInvalidation: () => {
        this.authService.completeSessionInvalidation();
        // Re-arm prewarming for the next successful host login.
        this.scheduleAilyChatPrewarm();
      },
      showSessionReplacedNotice: () => {
        this.message.warning(
          this.translate.instant('COMMON.AUTH_SESSION_REPLACED_NOTICE'),
          { nzDuration: 8000 },
        );
      },
      requestLogin: () => {
        this.authService.requestLogin('auth-token-invalid', { allowSkip: true });
      },
      reportFailure: (stage, error) => {
        console.error(`[Auth] Session invalidation stage failed: ${stage}`, error);
      },
    });
  }

  private scheduleAilyChatPrewarm(): void {
    if (this.cancelAilyChatPrewarm) return;
    if (!this.authService.isLoggedIn) {
      if (!this.ailyChatPrewarmAuthSubscription) {
        this.ailyChatPrewarmAuthSubscription = this.authService.isLoggedIn$
          .pipe(filter(Boolean), take(1))
          .subscribe(() => {
            this.ailyChatPrewarmAuthSubscription = null;
            this.scheduleAilyChatPrewarm();
          });
      }
      return;
    }
    const installed = this.subappManager.state.apps.some(
      item => item.toolId === DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID && item.installed && item.config,
    );
    if (!installed) return;

    const run = () => {
      this.cancelAilyChatPrewarm = null;

      if (!this.authService.isLoggedIn) {
        this.scheduleAilyChatPrewarm();
        return;
      }

      void this.childToolProcessService.prewarm(DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID, 90000).catch(error => {
        console.warn('[Subapp] Aily Chat prewarm failed:', error);
      });
    };

    if (typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(run, { timeout: 3000 });
      this.cancelAilyChatPrewarm = () => window.cancelIdleCallback(idleId);
      return;
    }

    const timer = setTimeout(run, 1000);
    this.cancelAilyChatPrewarm = () => clearTimeout(timer);
  }

  ngOnDestroy(): void {
    this.unregisterAilyChatHostAuthRuntimeBridge?.();
    this.unregisterAilyChatHostAuthRuntimeBridge = null;
    this.cancelAilyChatPrewarm?.();
    this.cancelAilyChatPrewarm = null;
    this.ailyChatPrewarmAuthSubscription?.unsubscribe();
    this.ailyChatPrewarmAuthSubscription = null;
    this.loginDialogSubscription?.unsubscribe();
    this.loginDialogSubscription = null;
    this.destroyLoginModal();
    this.authSessionInvalidationSubscription?.unsubscribe();
    this.authSessionInvalidationSubscription = null;
    this.authStateBroadcastSubscription?.unsubscribe();
    this.authStateBroadcastSubscription = null;
    this.configNoticeSubscription?.unsubscribe();
    this.configNoticeSubscription = null;
    this.projectContextSubscription?.unsubscribe();
    this.projectContextSubscription = null;
    this.projectStateSubscription?.unsubscribe();
    this.projectStateSubscription = null;
    this.oauthResultListener?.();
    this.oauthResultListener = null;
    this.exampleListListener?.();
    this.exampleListListener = null;
  }

  private watchConfigNotices() {
    this.configNoticeSubscription = this.configService.configNotice$.subscribe((notice) => {
      if (notice.type === 'error') {
        this.message.error(notice.message);
      }
    });
  }

  private resolveOAuthErrorMessage(source: unknown, fallbackKey: string): string {
    const { errorCode, errorArgs } = extractApiErrorDetails(source);
    if (errorCode) {
      const translationKey = `AUTH_ERRORS.${errorCode}`;
      const translated = this.translate.instant(translationKey, errorArgs);
      if (typeof translated === 'string' && translated.trim() && translated !== translationKey) {
        return translated;
      }
    }

    return this.translate.instant(fallbackKey);
  }

  private setupGlobalOAuthListener() {
    if (window['oauth'] && window['oauth'].onCallback) {
      this.oauthResultListener = window['oauth'].onCallback(async (callbackData: any) => {
        try {
          const result = await this.authService.handleOAuthCallback(callbackData);

          if (result.success) {
            const successMessageKey = result.purpose === 'bind'
              ? 'LOGIN.GITHUB_BIND_SUCCESS'
              : result.purpose === 'library_pr_submit'
                ? 'LOGIN.GITHUB_PR_AUTH_SUCCESS'
                : 'LOGIN.GITHUB_LOGIN_SUCCESS';
            this.message.success(this.translate.instant(successMessageKey));
          } else {
            let errorMessage = this.resolveOAuthErrorMessage(result, 'LOGIN.GITHUB_ERROR');

            switch (result.error) {
              case 'needs_wechat_bind':
                this.authService.emitNeedsWechatBind(result.data?.pending_ticket);
                return;
              case 'timeout':
                errorMessage = this.translate.instant('LOGIN.GITHUB_LOGIN_TIMEOUT');
                break;
              case 'invalid_state':
                errorMessage = this.translate.instant('LOGIN.GITHUB_LOGIN_STATE_INVALID');
                break;
              case 'missing_parameters':
                errorMessage = this.translate.instant('LOGIN.GITHUB_AUTH_PARAMETERS_MISSING');
                break;
              case 'access_denied':
                errorMessage = this.translate.instant('LOGIN.GITHUB_AUTH_CANCELLED');
                break;
              case 'callback_processing_failed':
                errorMessage = this.resolveOAuthErrorMessage(result, 'LOGIN.GITHUB_CALLBACK_FAILED');
                break;
            }

            this.message.error(errorMessage);
          }
        } catch (error) {
          console.error('处理OAuth回调异常:', error);
          this.message.error(this.translate.instant('LOGIN.LOGIN_PROCESSING_FAILED'));
        }
      });
    }
  }

  private setupExampleListListener() {
    if (window['exampleList'] && window['exampleList'].onOpen) {
      this.exampleListListener = window['exampleList'].onOpen((data: any) => {
        console.log('收到打开示例列表请求:', data);

        this.router.navigate(['/main/playground'], {
          queryParams: {
            keyword: data.keyword || '',
            id: data.id || '',
            sessionId: data.sessionId || '',
            params: data.params || '',
            version: data.version || ''
          }
        });
      });
    }
  }

  ngAfterViewInit(): void {
    this.uiService.actionSubject.subscribe((e: any) => {
      // console.log(e);
      switch (e.type) {
        case 'tool':
          if (e.action === 'open') {
            this.showRbox = true;
          } else {
            if (this.topTool === null) {
              this.showRbox = false;
            }
          }
          break;
        case 'bottom-sider':
          if (e.action === 'open') {
            this.showBbox = true;
            this.terminalTab = e.data;
            this.uiService.currentBottomTab = e.data;
            // 根据数据设置选中的tab
            if (e.data === 'log') {
              this.selectedTabIndex = 0;
            } else if (e.data === 'terminal') {
              this.selectedTabIndex = 1;
            }
          } else if (e.action === 'switch-tab') {
            // 切换tab，不改变面板的显示状态
            this.terminalTab = e.data;
            this.uiService.currentBottomTab = e.data;
            if (e.data === 'log') {
              this.selectedTabIndex = 0;
            } else if (e.data === 'terminal') {
              this.selectedTabIndex = 1;
            }
          } else {
            this.showBbox = false;
            this.uiService.currentBottomTab = '';
          }
          break;
        default:
          break;
      }
      this.cd.detectChanges();
    });

    this.projectStateSubscription = this.projectService.stateSubject.pipe(
      distinctUntilChanged(),
    ).subscribe((state) => {
      switch (state) {
        case 'loading':
          // this.loaded = false;
          setTimeout(() => {
            this.message.loading(this.translate.instant('MAIN_WINDOW.PROJECT_LOADING'));
            // this.loaded = true;
          }, 20);
          break;
        case 'loaded':
          this.message.remove();
          this.message.success(this.translate.instant('MAIN_WINDOW.PROJECT_LOADED'));
          void this.reloadTerminalAfterProjectOpen();
          break;
        case 'saving':
          this.message.loading(this.translate.instant('MAIN_WINDOW.PROJECT_SAVING'));
          break;
        case 'saved':
          this.message.remove();
          this.message.success(this.translate.instant('MAIN_WINDOW.PROJECT_SAVED'));
          break;
        case 'default':
          // this.message.success(this.translate.instant('MAIN_WINDOW.PROJECT_CLOSED'));
          // this.loaded = false;
          break;
        default:
          break;
      }
      this.cd.detectChanges();
    });

  }

  closeRightBox() {
    this.showRbox = false;
  }

  bottomHeight = 210;
  siderWidth = this.readPersistedSiderWidth();

  onSideResize({ width }: NzResizeEvent): void {
    if (!Number.isFinite(width)) {
      return;
    }
    this.siderWidth = this.normalizeSiderWidth(width!);
    try {
      localStorage.setItem(RIGHT_SIDER_WIDTH_STORAGE_KEY, String(this.siderWidth));
    } catch (error) {
      console.warn('[MainWindow] Failed to persist right sider width:', error);
    }
  }

  private readPersistedSiderWidth(): number {
    try {
      const persistedWidth = Number(localStorage.getItem(RIGHT_SIDER_WIDTH_STORAGE_KEY));
      return Number.isFinite(persistedWidth) && persistedWidth > 0
        ? this.normalizeSiderWidth(persistedWidth)
        : RIGHT_SIDER_DEFAULT_WIDTH;
    } catch (error) {
      console.warn('[MainWindow] Failed to restore right sider width:', error);
      return RIGHT_SIDER_DEFAULT_WIDTH;
    }
  }

  private normalizeSiderWidth(width: number): number {
    return Math.min(RIGHT_SIDER_MAX_WIDTH, Math.max(RIGHT_SIDER_MIN_WIDTH, Math.round(width)));
  }

  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  // 处理底部tab的切换
  onTabChange(index: number): void {
    this.selectedTabIndex = index;
    if (index === 0) {
      this.terminalTab = 'log';
      this.uiService.currentBottomTab = 'log';
    } else if (index === 1) {
      this.terminalTab = 'terminal';
      this.uiService.currentBottomTab = 'terminal';
    }
  }

  // 关闭底部面板
  closeBottomPanel(): void {
    this.showBbox = false;
    this.uiService.terminalIsOpen = false;
    this.uiService.currentBottomTab = '';
  }

  private async reloadTerminalAfterProjectOpen(): Promise<void> {
    if (!this.showBbox || !this.terminalComponent) {
      return;
    }

    try {
      await this.terminalComponent.reload();
    } catch (error) {
      console.error('Failed to reload terminal after opening project:', error);
    }
  }

  // 清空当前选中的组件
  clearCurrentComponent(): void {
    if (this.selectedTabIndex === 0) {
      // 清空日志
      this.logComponent?.clear();
    } else if (this.selectedTabIndex === 1) {
      // 清空终端
      this.terminalComponent?.clear();
    }
  }

  exportLog() {
    this.logComponent?.exportData();
  }

  toggleLogSearchToolbar() {
    this.logComponent?.toggleSearchToolbar();
  }

  // 新手引导关闭事件
  onOnboardingClosed() {
    this.onboardingService.close();
  }

  // 新手引导完成事件
  onOnboardingCompleted() {
    this.onboardingService.complete();
  }

}
