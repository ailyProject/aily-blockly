import { Component, ChangeDetectorRef, OnDestroy, ViewChild } from '@angular/core';
import { FooterComponent } from './components/footer/footer.component';
import { HeaderComponent } from './components/header/header.component';
import { CommonModule } from '@angular/common';
import { NzLayoutModule } from 'ng-zorro-antd/layout';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { AilyChatComponent } from '../tools/aily-chat/aily-chat.component';
import { TerminalComponent } from '../tools/terminal/terminal.component';
import { LogComponent } from '../tools/log/log.component';
import { UiService } from '../services/ui.service';
import { SerialMonitorComponent } from '../tools/serial-monitor/serial-monitor.component';
import { ChildToolHostComponent } from '../tools/child-tool-host/child-tool-host.component';
import { CodeViewerComponent } from '../editors/blockly-editor/tools/code-viewer/code-viewer.component';
import { ProjectService } from '../services/project.service';
import { SimplebarAngularModule } from 'simplebar-angular';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AppStoreComponent } from '../tools/app-store/app-store.component';
import { AppStoreService } from '../tools/app-store/app-store.service';
import { UpdateService } from '../services/update.service';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NpmService } from '../services/npm.service';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { distinctUntilChanged, filter, Subscription } from 'rxjs';
import { ConfigService } from '../services/config.service';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { CloudSpaceComponent } from '../tools/cloud-space/cloud-space.component';
import { UserCenterComponent } from '../tools/user-center/user-center.component';
import { OnboardingComponent } from '../components/onboarding/onboarding.component';
import { OnboardingService } from '../services/onboarding.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { isChildTool } from '../configs/tool.config';
import { AuthService, type LoginDialogRequestState } from '../services/auth.service';
import { ElectronService } from '../services/electron.service';
import { SubappManagerService } from '../services/subapp-manager.service';
import { LoginComponent } from '../components/login/login.component';
import { resolveTranslatedApiErrorMessage } from '../utils/api-error.utils';
import { ToolI18nService } from '../services/tool-i18n.service';
import { LibManagerToolComponent } from '../tools/lib-manager-tool/lib-manager-tool.component';
import { ModeWelcomeComponent } from '../components/mode-welcome/mode-welcome.component';
import { SimulatorSubappHostComponent } from '../tools/simulator/simulator-subapp-host.component';
import type { DevelopmentModePreference } from '../services/config.service';
import { ChatRuntimeHostResourceOperationHandlerService } from '../tools/aily-chat/services/chat-runtime-host-resource-operation-handler.service';
import { AilyChatChildProtocolService } from '../tools/aily-chat/services/aily-chat-child-protocol.service';
import {
  bootstrapDefaultAilyChatSubapp,
  DEFAULT_AILY_CHAT_SUBAPP_BOOTSTRAP_KEY,
  DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID,
} from '../services/default-aily-chat-bootstrap';

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
    AilyChatComponent,
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
    NzModalModule,
    CloudSpaceComponent,
    UserCenterComponent,
    OnboardingComponent,
    TranslateModule,
    LibManagerToolComponent,
    ModeWelcomeComponent,
    SimulatorSubappHostComponent,
    LoginComponent,
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
    return toolId !== 'simulator' && isChildTool(toolId);
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
  private developmentModePreferencePromptOpen = false;
  private loginDialogSubscription: Subscription | null = null;
  private unregisterApplicationUpdatePreparation: (() => void) | null = null;
  private projectStatusMessageTimer: ReturnType<typeof setTimeout> | null = null;
  private projectStatusHost: HTMLDivElement | null = null;

  loginDialogState: LoginDialogRequestState | null = null;

  // 首次开发模式选择（全屏引导）
  showModeWelcome = false;

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
    private toolI18n: ToolI18nService,
    private readonly chatRuntimeHostResourceOperationHandler: ChatRuntimeHostResourceOperationHandlerService,
    private readonly ailyChatChildProtocol: AilyChatChildProtocolService
  ) { }

  async ngOnInit(): Promise<void> {
    this.unregisterApplicationUpdatePreparation = this.updateService.registerInstallPreparationHook(
      'host-aily-chat-session',
      () => this.ailyChatChildProtocol.prepareForApplicationUpdate(),
    );
    this.loginDialogSubscription = this.authService.loginDialogRequest$.subscribe((state) => {
      this.loginDialogState = state;
    });
    void this.chatRuntimeHostResourceOperationHandler.start().catch(error => {
        console.error('[AilyChat][RuntimeHostResourceOperationHandler] Failed to start:', error);
    });
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

    setTimeout(() => {
      void this.promptDevelopmentModePreferenceIfNeeded();
    }, 0);
  }

  closeLoginDialog(): void {
    this.authService.dismissLoginDialog();
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
    } catch (error) {
      console.warn('[Subapp] Default Aily Chat installation failed:', error);
    }
  }

  private async promptDevelopmentModePreferenceIfNeeded(): Promise<void> {
    if (this.developmentModePreferencePromptOpen || this.showModeWelcome) {
      return;
    }

    if (!this.configService.data || Object.keys(this.configService.data).length === 0) {
      await this.configService.init();
    }

    if (!this.configService.shouldPromptDevelopmentModePreference()) {
      return;
    }

    this.developmentModePreferencePromptOpen = true;
    this.showModeWelcome = true;
    this.cd.detectChanges();
  }

  // 用户在全屏引导中选择了某个开发模式
  async onModeWelcomeSelect(preference: DevelopmentModePreference): Promise<void> {
    await this.configService.setDevelopmentModePreference(preference, 'onboarding');
    this.closeModeWelcome();
  }

  // 用户选择「稍后再说」
  async onModeWelcomeSkip(): Promise<void> {
    await this.configService.markDevelopmentModePreferencePrompted();
    this.closeModeWelcome();
  }

  private closeModeWelcome(): void {
    this.showModeWelcome = false;
    this.developmentModePreferencePromptOpen = false;
    this.cd.detectChanges();
  }

  ngOnDestroy(): void {
    this.unregisterApplicationUpdatePreparation?.();
    this.unregisterApplicationUpdatePreparation = null;
    this.loginDialogSubscription?.unsubscribe();
    this.loginDialogSubscription = null;
    this.configNoticeSubscription?.unsubscribe();
    this.configNoticeSubscription = null;
    this.projectContextSubscription?.unsubscribe();
    this.projectContextSubscription = null;
    this.projectStateSubscription?.unsubscribe();
    this.projectStateSubscription = null;
    this.clearProjectStatusMessage();
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

  private setupGlobalOAuthListener() {
    if (window['oauth'] && window['oauth'].onCallback) {
      this.oauthResultListener = window['oauth'].onCallback(async (callbackData: any) => {
        try {
          const result = await this.authService.handleOAuthCallback(callbackData);

          if (result.success) {
            const successMessage = result.purpose === 'bind'
              ? 'GitHub 绑定成功'
              : result.purpose === 'library_pr_submit'
                ? 'GitHub PR 提交授权成功'
                : 'GitHub 登录成功';
            this.message.success(successMessage);
          } else {
            let errorMessage = 'GitHub 登录超时，请重试';

            switch (result.error) {
              case 'needs_wechat_bind':
                this.authService.emitNeedsWechatBind(result.data?.pending_ticket);
                return;
              case 'timeout':
              case 'invalid_state':
                errorMessage = '登录状态无效或已超时，请重试';
                break;
              case 'missing_parameters':
                errorMessage = '授权参数缺失，请重试';
                break;
              case 'access_denied':
                errorMessage = '您取消了授权';
                break;
              case 'callback_processing_failed':
                errorMessage = resolveTranslatedApiErrorMessage(result, this.translate, {
                  fallbackMessage: result.message || '处理授权回调失败',
                });
                break;
              default:
                errorMessage = resolveTranslatedApiErrorMessage(result, this.translate, {
                  fallbackMessage: result.message || 'GitHub 登录超时，请重试',
                });
            }

            this.message.error(errorMessage);
          }
        } catch (error) {
          console.error('处理OAuth回调异常:', error);
          this.message.error(resolveTranslatedApiErrorMessage(error, this.translate, {
            fallbackMessage: '登录处理失败，请重试',
          }));
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
          // 延迟一帧再挂 loading，避免与路由切换的同步重绘抢同一帧。
          this.scheduleProjectStatusMessage(this.translate.instant('MAIN_WINDOW.PROJECT_LOADING'));
          break;
        case 'loaded':
          this.clearProjectStatusMessage();
          this.message.success(this.translate.instant('MAIN_WINDOW.PROJECT_LOADED'));
          void this.reloadTerminalAfterProjectOpen();
          this.cd.detectChanges();
          break;
        case 'saving':
          this.scheduleProjectStatusMessage(this.translate.instant('MAIN_WINDOW.PROJECT_SAVING'));
          break;
        case 'saved':
          this.clearProjectStatusMessage();
          this.message.success(this.translate.instant('MAIN_WINDOW.PROJECT_SAVED'));
          break;
        case 'default':
        case 'error':
          this.clearProjectStatusMessage();
          break;
        default:
          break;
      }
    });

  }

  private scheduleProjectStatusMessage(content: string): void {
    if (this.projectStatusMessageTimer) {
      clearTimeout(this.projectStatusMessageTimer);
      this.projectStatusMessageTimer = null;
    }
    this.projectStatusMessageTimer = setTimeout(() => {
      this.projectStatusMessageTimer = null;
      this.showProjectStatusMessage(content);
    }, 20);
  }

  private showProjectStatusMessage(content: string): void {
    this.clearProjectStatusMessage(false);
    // 不用 nz-message loading：加载中会刷新 Blockly toolbox DOM，
    // 容易打断 overlay 合成层。改为挂到 body 的独立 CSS 转圈。
    this.mountIsolatedProjectStatus(content);
  }

  private clearProjectStatusMessage(cancelScheduled = true): void {
    if (cancelScheduled && this.projectStatusMessageTimer) {
      clearTimeout(this.projectStatusMessageTimer);
      this.projectStatusMessageTimer = null;
    }
    this.unmountIsolatedProjectStatus();
  }

  private mountIsolatedProjectStatus(content: string): void {
    this.unmountIsolatedProjectStatus();
    const host = document.createElement('div');
    host.className = 'aily-project-status';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    host.innerHTML = `<span class="aily-project-status__spinner" aria-hidden="true"></span><span class="aily-project-status__text"></span>`;
    const textEl = host.querySelector('.aily-project-status__text');
    if (textEl) {
      textEl.textContent = content;
    }
    document.body.appendChild(host);
    this.projectStatusHost = host;
  }

  private unmountIsolatedProjectStatus(): void {
    if (this.projectStatusHost) {
      this.projectStatusHost.remove();
      this.projectStatusHost = null;
    }
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
