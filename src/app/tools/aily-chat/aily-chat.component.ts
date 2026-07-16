import { Component, ElementRef, ViewChild, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy, AfterViewChecked, NgZone, effect } from '@angular/core';
import { Subscription } from 'rxjs';
import { NzInputModule } from 'ng-zorro-antd/input';
import { FormsModule } from '@angular/forms';
import type { NzResizeEvent } from 'ng-zorro-antd/resizable';
import type { ChatDialogItemHeightChange } from './components/x-dialog/x-dialog.component';
import { ChatTranscriptListRendererComponent } from './components/chat-transcript-list-renderer.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';
import { NzResizableModule } from 'ng-zorro-antd/resizable';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { CommonModule } from '@angular/common';
import { ChatService } from './services/chat.service';
import { NzToolTipModule, NzTooltipDirective } from 'ng-zorro-antd/tooltip';
import { NzNoAnimationDirective } from 'ng-zorro-antd/core/no-animation';
import { MenuComponent } from '../../components/menu/menu.component';
import { McpService } from './services/mcp.service';
import { ProjectService } from '../../services/project.service';
import { CmdService } from '../../services/cmd.service';
import { CrossPlatformCmdService } from '../../services/cross-platform-cmd.service';
import { PlatformService } from '../../services/platform.service';
import { ElectronService } from '../../services/electron.service';
import { BuilderService } from '../../services/builder.service';

import { ConnectionGraphService } from '../../services/connection-graph.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ConfigService } from '../../services/config.service';
import { AilyChatConfigService } from './services/aily-chat-config.service';
import { MERMAID_DARK_THEME, MermaidCodeComponent } from 'ngx-x-markdown';
import { AilyHost } from './core/host';
import { AilyChatHostInitializerService } from './services/aily-chat-host-initializer.service';
import { ScrollManagerService, type ChatRevealOptions, type ChatRevealTarget } from './services/scroll-manager.service';
import { ResourceManagerService } from './services/resource-manager.service';
import { MenuManagerService, type ChatSessionListItem } from './services/menu-manager.service';
import { ChatSessionActionsService } from './services/chat-session-actions.service';
import { ChatSessionItemsService } from './services/chat-session-items.service';
import { ChatSessionsControlService } from './services/chat-sessions-control.service';
import {
  ChatSetupSuggestionService,
} from './services/chat-setup-suggestion.service';
import { ChatViewService } from './services/chat-view.service';
import { ChatEngineService } from './services/chat-engine.service';
import { EditCheckpointService } from './services/edit-checkpoint.service';
import { GitWorkspaceCheckpointProviderService } from './services/git-workspace-checkpoint-provider.service';
import { ChatPerformanceTracer } from './services/chat-perf-tracer';
import { ChatSwitchShellCoordinator } from './helpers/chat-switch-shell-coordinator';
import { ChatEditResourceShellCoordinator } from './helpers/chat-edit-resource-shell-coordinator';
import { ChatSurfaceShellCoordinator } from './helpers/chat-surface-shell-coordinator';
import { ChatSubmitShellCoordinator } from './helpers/chat-submit-shell-coordinator';
import { ChatRequestController } from './helpers/chat-request-controller';
import type { ChatPendingRequestKind, PendingFollowupRequest } from './helpers/chat-pending-request';
import { AILY_CHAT_INPUT_MAX_CHARS, ChatComposerShellCoordinator } from './helpers/chat-composer-shell-coordinator';
import { ChatInputHistoryNavigator, type ChatInputHistoryEntry } from './helpers/chat-input-history-navigator';
import { ChatViewportShellCoordinator } from './helpers/chat-viewport-shell-coordinator';
import { ChatComponentLifecycleCoordinator } from './helpers/chat-component-lifecycle-coordinator';
import { ChatActionRegistry } from './helpers/chat-action-registry';
import { ChatComponentViewModel } from './helpers/chat-component-view-model';
import type {
  ChatVisibleTranscriptDialogItem,
  ChatVisibleTranscriptDialogItemPatch,
} from './core/chat-visible-transcript-model';
import { ChatTranscriptWindowModel } from './core/chat-transcript-window-model';
import type { ChatPart } from './core/chat-parts';
import { resolveChatDialogRevealTargetIndex } from './helpers/chat-dialog-reveal-target';
import { exposeAilyChatE2eHarness, type AilyChatE2eRenderingDiagnostics } from './helpers/aily-chat-e2e-harness';
import { importDebugSnapshotFromDialog } from './helpers/chat-debug-import.helper';
import { ChatMemoryShellCoordinator } from './helpers/chat-memory-shell-coordinator';
import { runChatTodoFocusAction } from './helpers/chat-todo-focus-action';
import { ChatProcessManagerDialogComponent } from './components/process-manager-dialog/chat-process-manager-dialog.component';
import { isSessionLifecycleSupersededError, readSessionLifecycleRestoreErrorDetails } from './helpers/session-lifecycle.helper';
import { openChatProcessWindow } from './helpers/chat-process-window';
import {
  buildChildToolProcessSummaries,
  collapseActiveChildToolServeProcesses,
  resolveChildToolIdFromProcess,
  type ChildToolSessionListItem,
} from './helpers/child-tool-process-summary';
import { getChildToolConfig } from '../../configs/tool.config';
import {
  listPersistedBlocklyCommandSessionSnapshots,
  listPersistedBlocklyProjectCommandSessionSnapshots,
} from './helpers/lex-agent-bootstrap';
import { setChatTranslateService } from './helpers/chat-i18n';
import { setToolApprovalTranslateService } from './helpers/tool-approval-ui';
import type { ChatTaskActionDetail } from './helpers/chat-task-action-coordinator';

import { NzMessageService } from 'ng-zorro-antd/message';
import { AuthService } from '../../services/auth.service';
import { FloatingTodoComponent } from './components/floating-todo/floating-todo.component';
import { AilyEditsViewerComponent } from './components/aily-edits-viewer/aily-edits-viewer.component';
import { TodoUpdateService } from './services/todoUpdate.service';
import { ArduinoLintService } from './services/arduino-lint.service';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LoginComponent } from '../../components/login/login.component';
import { NoticeService } from '../../services/notice.service';
import { AilyChatDebugHomeComponent } from './components/aily-chat-debug-home/aily-chat-debug-home.component';
import { AilyChatDebugCacheExplorerComponent } from './components/aily-chat-debug-cache/aily-chat-debug-cache.component';
import { AilyChatDebugFlowComponent } from './components/aily-chat-debug-flow/aily-chat-debug-flow.component';
import { AilyChatDebugLogsComponent } from './components/aily-chat-debug-logs/aily-chat-debug-logs.component';
import { AilyChatSettingsComponent } from './components/settings/settings.component';
import { AilyChatDebugViewerComponent } from './components/aily-chat-debug-viewer/aily-chat-debug-viewer.component';
import { ChatInputPartHostComponent } from './components/chat-input-part-host.component';
import { ChatRuntimeConfirmationCarouselComponent } from './components/chat-runtime-confirmation-carousel.component';
import { ChatRuntimeQuestionCarouselComponent } from './components/chat-runtime-question-carousel.component';
import { ChatRuntimePlanReviewComponent } from './components/chat-runtime-plan-review.component';
import { ChatSessionListComponent } from './components/chat-session-list.component';
import { ChatSessionPickerComponent } from './components/chat-session-picker.component';
import { ChatSessionTitleControlComponent } from './components/chat-session-title-control.component';
import { ChatContextToolbarComponent } from './components/chat-context-toolbar/chat-context-toolbar.component';
import {
  ChatPermissionConfirmDialogComponent,
  type ChatPermissionConfirmDialogResult,
} from './components/chat-permission-confirm-dialog.component';
import {
  ChatPendingRequestsDialogComponent,
  type ChatPendingRequestsDialogResult,
} from './components/chat-pending-requests-dialog.component';
import { OnboardingService } from '../../services/onboarding.service';
import { AbsAutoSyncService } from './services/abs-auto-sync.service';
import { RepetitionDetectionService } from './services/repetition-detection.service';
import { ChatHistoryService } from './services/chat-history.service';
import { ChatDebugBrowserService, ChatDebugBrowserViewState } from './services/chat-debug-browser.service';
import { ChatRuntimeInteractionHostService } from './services/chat-runtime-interaction-host.service';
import { ThemeService } from '../../services/theme.service';
import { ToolI18nService } from '../../services/tool-i18n.service';
import type {
  ChatPaneEntryInfoSurfaceModel,
  ChatPaneSessionPickerSurfaceModel,
  ChatPaneStageSurfaceModel,
  ChatPaneSurface,
  ChatPaneSessionListSurfaceModel,
} from './services/chat-view.service';
import type { ChatRuntimeHostSessionProcessSummary } from './core/chat-runtime-host-contract';

// 共享类型从 core/chat-types.ts 导入并重新导出（保持向后兼容）
import { Tool, ResourceItem, ChatMessage, ToolCallState, ToolCallInfo } from './core/chat-types';
import type { ChatHostHeaderActionRequest } from './core/chat-host-header-actions';
import type { ChatSessionTitleActionRequest, ChatSessionTitleSurfaceModel } from './core/chat-session-title-actions';
import type { IMenuItem } from '../../configs/menu.config';
export type { Tool, ResourceItem, ChatMessage, ToolCallInfo };
export { ToolCallState };

interface PendingFollowupSection {
  readonly kind: ChatPendingRequestKind;
  readonly title: string;
  readonly requests: readonly PendingFollowupRequest[];
}

function readUnpatchedAilyChatTimer<T extends (...args: any[]) => any>(name: 'setTimeout' | 'clearTimeout'): T | null {
  const runtime = globalThis as any;
  const zoneSymbol = typeof runtime.Zone?.__symbol__ === 'function'
    ? runtime.Zone.__symbol__(name)
    : `__zone_symbol__${name}`;
  const candidate = runtime[zoneSymbol];
  return typeof candidate === 'function' ? candidate.bind(runtime) as T : null;
}

function setTimeoutOutsideAngular(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const nativeSetTimeout = readUnpatchedAilyChatTimer<typeof setTimeout>('setTimeout');
  return (nativeSetTimeout ?? globalThis.setTimeout.bind(globalThis))(callback, delayMs);
}

function clearTimeoutOutsideAngular(handle: ReturnType<typeof setTimeout>): void {
  const nativeClearTimeout = readUnpatchedAilyChatTimer<typeof clearTimeout>('clearTimeout');
  (nativeClearTimeout ?? globalThis.clearTimeout.bind(globalThis))(handle);
}

// import { reloadAbiJsonTool, reloadAbiJsonToolSimple } from './tools';

@Component({
  selector: 'app-aily-chat',
  imports: [
    SubWindowComponent,
    NzInputModule,
    FormsModule,
    CommonModule,
    ChatTranscriptListRendererComponent,
    NzButtonModule,
    ToolContainerComponent,
    NzResizableModule,
    NzToolTipModule,
    MenuComponent,
    FloatingTodoComponent,
    AilyEditsViewerComponent,
    TranslateModule,
    LoginComponent,
    AilyChatDebugHomeComponent,
    AilyChatDebugCacheExplorerComponent,
    AilyChatDebugFlowComponent,
    AilyChatDebugLogsComponent,
    AilyChatSettingsComponent,
    AilyChatDebugViewerComponent,
    ChatInputPartHostComponent,
    ChatRuntimeConfirmationCarouselComponent,
    ChatRuntimeQuestionCarouselComponent,
    ChatRuntimePlanReviewComponent,
    ChatSessionListComponent,
    ChatSessionPickerComponent,
    ChatSessionTitleControlComponent,
    ChatContextToolbarComponent,
    NzNoAnimationDirective,
  ],
  templateUrl: './aily-chat.component.html',
  styleUrl: './aily-chat.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AilyChatComponent implements OnDestroy, AfterViewChecked {
  readonly chatInputMaxChars = AILY_CHAT_INPUT_MAX_CHARS;
  sessionOverflowMenuOpen = false;

  readonly debugBrowserViewState = {
    Home: ChatDebugBrowserViewState.Home,
    Overview: ChatDebugBrowserViewState.Overview,
    Logs: ChatDebugBrowserViewState.Logs,
    FlowChart: ChatDebugBrowserViewState.FlowChart,
    CacheExplorer: ChatDebugBrowserViewState.CacheExplorer,
  } as const;

  @ViewChild('chatContainer') chatContainer: ElementRef;
  private chatTextareaRef?: ElementRef;
  private chatTextareaSubmitCleanup: (() => void) | null = null;
  @ViewChild('chatTextarea')
  set chatTextarea(ref: ElementRef | undefined) {
    this.chatTextareaSubmitCleanup?.();
    this.chatTextareaSubmitCleanup = null;
    this.chatTextareaRef = ref;
    this.engine.bindChatTextareaRef(ref ?? null);
    const element = ref?.nativeElement as HTMLTextAreaElement | undefined;
    if (element && typeof element.addEventListener === 'function') {
      const listener = (event: KeyboardEvent) => {
        const legacyKeyCode = (event as KeyboardEvent & { keyCode?: number }).keyCode;
        if (event.key !== 'Enter' || event.isComposing || legacyKeyCode === 229) {
          return;
        }
        event.stopImmediatePropagation();
        void this.composerShellCoordinator.handleKeyDown(event);
      };
      this.ngZone.runOutsideAngular(() => {
        element.addEventListener('keydown', listener, { capture: true });
      });
      this.chatTextareaSubmitCleanup = () => element.removeEventListener('keydown', listener, { capture: true });
    }
  }
  get chatTextarea(): ElementRef | undefined {
    return this.chatTextareaRef;
  }
  private composerSendActionCleanup: (() => void) | null = null;
  @ViewChild('composerSendAction', { read: ElementRef })
  set composerSendAction(ref: ElementRef<HTMLElement> | undefined) {
    this.composerSendActionCleanup?.();
    this.composerSendActionCleanup = null;
    const element = ref?.nativeElement;
    if (!element) {
      return;
    }
    const listener = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.submitCurrentDraftAction();
    };
    this.ngZone.runOutsideAngular(() => {
      element.addEventListener('click', listener, { capture: true });
    });
    this.composerSendActionCleanup = () => element.removeEventListener('click', listener, { capture: true });
  }
  @ViewChild('windowBoxRoot')
  set windowBoxRoot(ref: ElementRef<HTMLElement> | undefined) {
    this.windowBoxElement = ref?.nativeElement ?? null;
    this.observeSessionViewport(this.windowBoxElement);
  }
  private windowBoxElement: HTMLElement | null = null;
  @ViewChild(ChatInputPartHostComponent) inputPartHost?: ChatInputPartHostComponent;
  @ViewChild(FloatingTodoComponent) floatingTodo?: FloatingTodoComponent;
  @ViewChild('inputPartHostElement', { read: ElementRef })
  set inputPartHostElement(ref: ElementRef<HTMLElement> | undefined) {
    this.observeInputPart(ref?.nativeElement ?? null);
  }
  @ViewChild(ChatTranscriptListRendererComponent) transcriptListRenderer?: ChatTranscriptListRendererComponent;
  @ViewChild('permissionModeTooltip', { read: NzTooltipDirective })
  private permissionModeTooltip?: NzTooltipDirective;
  @ViewChild('composerModelTooltip', { read: NzTooltipDirective })
  private composerModelTooltip?: NzTooltipDirective;

  public readonly vm: ChatComponentViewModel;
  reasoningMenuItems: IMenuItem[] = [];
  public isManualCompacting = false;
  public isComposerFocused = false;

  public readonly switchShellCoordinator: ChatSwitchShellCoordinator;
  public readonly editResourceShellCoordinator: ChatEditResourceShellCoordinator;
  public readonly surfaceShellCoordinator: ChatSurfaceShellCoordinator;
  public readonly submitShellCoordinator: ChatSubmitShellCoordinator;
  private readonly requestController: ChatRequestController;
  public readonly composerShellCoordinator: ChatComposerShellCoordinator;
  public readonly viewportShellCoordinator: ChatViewportShellCoordinator;
  public readonly memoryShellCoordinator: ChatMemoryShellCoordinator;
  public readonly actionRegistry: ChatActionRegistry;
  private readonly lifecycleCoordinator: ChatComponentLifecycleCoordinator;
  private sessionViewportResizeObserver: ResizeObserver | null = null;
  private inputPartResizeObserver: ResizeObserver | null = null;
  private observedSessionViewportElement: HTMLElement | null = null;
  private observedInputPartElement: HTMLElement | null = null;
  private readonly rememberedFullAccessSessions = new Set<string>();
  private readonly inputHistoryNavigator = new ChatInputHistoryNavigator([], entries => this.persistInputHistoryEntries(entries));
  private inputHistoryStorageKey: string | null = null;
  private readonly dialogWindowModel = new ChatTranscriptWindowModel();
  private dialogVirtualRefreshRaf: number | null = null;
  private dialogVirtualMeasureRaf: number | null = null;
  private dialogContentDeltaRaf: number | null = null;
  private readonly pendingDialogContentDeltaItemIds = new Set<string>();
  private dialogBottomFollowRaf: number | null = null;
  private dialogBottomFollowRequestId = 0;
  private syncViewRefreshRaf: number | null = null;
  private rendererStreamingSamplerActive = false;
  private rendererStreamingSamplerStopTimer: ReturnType<typeof setTimeout> | null = null;
  private rendererStreamingCounterBaseline: Readonly<Record<string, number>> = {};
  private submitToFirstRenderSamplerStopTimer: ReturnType<typeof setTimeout> | null = null;
  private rendererStreamingBudgetStartedAt = 0;
  private submitToFirstRenderStartedAt: number | null = null;
  private visibleTurnSubmitStartedAt: number | null = null;
  private visibleTurnLastContentAt: number | null = null;
  private visibleTurnCompletionTailOverrideMs: number | null = null;
  private visibleTurnResponseCompleteObservedAt: number | null = null;
  private visibleTurnCompletionFrameId: number | null = null;
  private visibleTurnObservedStreaming = false;
  private conversationScrollCleanup: (() => void) | null = null;
  private olderTurnPageLoadPromise: Promise<void> | null = null;
  private lastSessionListLayoutKey = '';
  public get dialogVirtualTopSpacerHeight(): number {
    return this.dialogWindowModel.snapshot.topSpacerHeight;
  }

  public get dialogVirtualBottomSpacerHeight(): number {
    return this.dialogWindowModel.snapshot.bottomSpacerHeight;
  }

  public get isLoadingOlderVisibleTurns(): boolean {
    return this.engine.isLoadingOlderVisibleTurns;
  }
  private readonly debugBrowserChangeSubscription: Subscription;
  private readonly sessionViewModelChangeSubscription: Subscription;
  private readonly runtimeProcessSnapshotSubscription: { dispose(): void };
  private childToolSessionStateCleanup: (() => void) | null = null;
  private childToolSessions: readonly ChildToolSessionListItem[] = [];
  private runtimeInteractionRevealEffect: { destroy(): void } | null = null;
  private runtimeInteractionRevealTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRuntimeInteractionRevealKey = '';
  private pendingFollowupEditState: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly kind: ChatPendingRequestKind;
  } | null = null;
  /** 用户消息重新编辑互斥：同时最多展开一条 */
  userMessageEditingTurnId: string | undefined;

  constructor(
    private uiService: UiService,
    private chatService: ChatService,
    private mcpService: McpService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private blocklyService: BlocklyService,
    private message: NzMessageService,
    private authService: AuthService,
    private modal: NzModalService,
    private configService: ConfigService,
    private ailyChatConfigService: AilyChatConfigService,
    private todoUpdateService: TodoUpdateService,
    private arduinoLintService: ArduinoLintService,
    private noticeService: NoticeService,
    private platformService: PlatformService,
    private electronService: ElectronService,
    private onboardingService: OnboardingService,
    private absAutoSyncService: AbsAutoSyncService,
    private connectionGraphService: ConnectionGraphService,
    private repetitionDetectionService: RepetitionDetectionService,
    private chatHistoryService: ChatHistoryService,
    public debugBrowser: ChatDebugBrowserService,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private builderService: BuilderService,
    private themeService: ThemeService,
    private toolI18n: ToolI18nService,
    private hostInitializer: AilyChatHostInitializerService,
    public runtimeInteractionHost: ChatRuntimeInteractionHostService,
    public engine: ChatEngineService,
    public scrollManager: ScrollManagerService,
    public resourceManager: ResourceManagerService,
    public sessionActions: ChatSessionActionsService,
    public menuManager: MenuManagerService,
    public viewState: ChatViewService,
  ) {
    setChatTranslateService(this.translate);
    setToolApprovalTranslateService(this.translate);
    ChatPerformanceTracer.increment('entry_open.component_constructor');
    ChatPerformanceTracer.mark('entry_open.component_constructor');
    this.vm = new ChatComponentViewModel({
      engine: this.engine,
      viewState: this.viewState,
    });
    this.scrollManager.setRevealHostDelegate?.({
      prepareRevealTarget: (target, options) => this.prepareDialogRevealTarget(target, options),
    });
    this.runtimeInteractionRevealEffect = effect(() => {
      this.trackRuntimeInteractionReveal();
    });
    exposeAilyChatE2eHarness({
      engine: this.engine,
      viewState: this.viewState,
      readRenderingDiagnostics: () => this.readRenderingDiagnostics(),
      readPerformanceDiagnostics: () => ({
        ...ChatPerformanceTracer.snapshotPerformanceState(),
        rendererStreamingBudget: ChatPerformanceTracer.snapshotRendererStreamingBudget(),
      }),
      runWorkspaceFinalizeBoundaryProbe: () => this.engine.runE2eWorkspaceFinalizeBoundaryProbe(),
    });
    this.engine.setPaneSessionCommandHandlers({
      requestNewChat: () => this.requestNewChat(),
    });
    this.engine.setSchematicIframeProgressTarget(this.connectionGraphService);
    this.debugBrowserChangeSubscription = this.debugBrowser.onDidChange.subscribe(() => {
      this.cdr.markForCheck();
    });
    this.runtimeProcessSnapshotSubscription = this.runtimeInteractionHost.onSnapshot((snapshot) => {
      if (!snapshot?.sessionId) {
        return;
      }
      this.cdr.markForCheck();
    });
    this.sessionViewModelChangeSubscription = this.viewState.sessionViewModelChanged$.subscribe(() => {
      this.syncSessionListDisplayState();
    });
    // 注册 OnPush CD 回调 — viewAdapter 每次 flush/appendImmediate 后调用 markForCheck
    this.engine.setCdCallback(() => {
      this.syncSessionListDisplayState();
    });
    // Stream/update paths can be very chatty; coalesce them to the browser frame
    // instead of forcing a synchronous component tree check for every event.
    this.engine.setSyncDetectChanges(() => {
      this.scheduleSyncViewRefresh();
    });
    this.engine.setVisibleTranscriptItemPatchCallback((patch) => this.applyVisibleTranscriptItemPatch(patch));
    this.engine.setVisibleResponseRevisionObservedCallback((event) => {
      if (event.sessionId !== this.vm.sessionId || this.visibleTurnSubmitStartedAt === null) {
        return;
      }
      if (event.sourceEventType === 'response_complete') {
        this.visibleTurnResponseCompleteObservedAt = performance.now();
        this.visibleTurnCompletionTailOverrideMs = typeof event.sourceGapMs === 'number'
          ? event.sourceGapMs
          : null;
        this.scheduleVisibleResponseCompletionObservation();
      } else {
        this.visibleTurnLastContentAt = performance.now();
      }
    });
    this.engine.setSubmittedRequestPaintObservedCallback((event) => {
      if (event.sessionId !== this.vm.sessionId || this.visibleTurnSubmitStartedAt === null) {
        return;
      }
      console.info(
        '[AilyChat][SubmittedRequestPaintScalar]',
        [
          `sessionId=${event.sessionId}`,
          `turnId=${event.turnId}`,
          `submitToPaintMs=${(performance.now() - this.visibleTurnSubmitStartedAt).toFixed(1)}`,
          `executionToPaintMs=${event.executionToPaintMs.toFixed(1)}`,
          `checkpointMs=${event.checkpointMs.toFixed(1)}`,
          `projectionMs=${event.projectionMs.toFixed(1)}`,
          `projectionToPaintMs=${event.projectionToPaintMs.toFixed(1)}`,
        ].join(' '),
      );
    });
    this.engine.setRuntimeRequestStatePatchCallback((patch) => this.applyRuntimeRequestStatePatch(patch));
    this.switchShellCoordinator = new ChatSwitchShellCoordinator({
      menuManager: this.menuManager,
      viewState: this.viewState,
      getCurrentMode: () => this.vm.currentMode,
      getCurrentModeId: () => this.engine.currentResolvedMode?.id,
      getCurrentCustomAgentTarget: () => this.vm.currentCustomAgentTarget,
      getCurrentModel: () => this.vm.currentModel,
    }, {
      switchToMode: (mode) => this.engine.switchToMode(mode),
      switchToCustomAgent: (selection) => this.engine.switchToCustomAgent(selection),
      configureCustomAgents: () => this.viewState.openSettings(),
      updatePermissionPreset: (preset) => this.updatePermissionPresetWithConfirmation(preset),
      switchToModel: (model) => this.engine.switchToModel(model),
      switchToModelConfiguration: (model, update) => this.engine.switchToModelConfiguration(model, update),
    });
    this.editResourceShellCoordinator = new ChatEditResourceShellCoordinator({
      getDialog: () => AilyHost.get().dialog,
      resolveTarget: ({ turnId }) => this.transcriptListRenderer?.findDialogByTurnId(turnId),
    });
    this.surfaceShellCoordinator = new ChatSurfaceShellCoordinator({
      editAndResendFromTurn: (target, newText, resources) => this.engine.editAndResendFromTurn(target, newText, resources),
      closeTool: (toolId) => AilyHost.get().ui?.closeTool(toolId),
      openUrl: (url) => this.electronService.openUrl(url),
    });
    this.requestController = new ChatRequestController({
      sendNow: (text, sessionId) => this.engine.submitUserText(text, { clearInput: true, sessionId }),
      queue: (text, sessionId, options) => this.engine.queueFollowupMessage(text, sessionId, options),
      stop: (sessionId) => this.engine.stopAndWait(sessionId),
      getPending: (sessionId) => this.engine.getPendingFollowupRequests?.(sessionId) ?? [],
      hasPending: (sessionId) => this.engine.hasPendingFollowupRequests?.(sessionId) === true,
      clearPending: (sessionId) => this.engine.clearPendingFollowupRequests?.(sessionId),
      removePending: (sessionId, requestId) => this.engine.removePendingFollowupRequest?.(sessionId, requestId) === true,
      runNext: (sessionId, requestId) => this.engine.sendPendingFollowupImmediately?.(sessionId, requestId) ?? Promise.resolve(false),
      getActionState: (sessionId) => this.engine.getSessionActionState?.(sessionId),
    });
    this.submitShellCoordinator = new ChatSubmitShellCoordinator({
      scrollManager: this.scrollManager,
      resourceManager: this.resourceManager,
      authQuota: this.engine.authQuotaStateService,
      inputNotice: this.engine.chatInputNoticeStateService,
      getSessionAllowedPaths: () => this.engine.sessionAllowedPaths,
      getSessionId: () => this.vm.sessionId,
      getInputValue: () => this.vm.inputValue,
      isWaiting: (sessionId) => this.requestController.getActionState(sessionId ?? this.vm.sessionId).canStop,
      ensureSession: () => this.engine.ensureSessionReadyForSubmit(),
      hasPendingRequests: (sessionId) => this.hasPendingFollowupRequests(sessionId),
      confirmPendingRequestsBeforeSend: (sessionId) => this.confirmPendingFollowupRequestsBeforeSend(sessionId),
      clearPendingRequests: (sessionId) => this.requestController.clearPending(sessionId ?? this.vm.sessionId),
      queueSend: (text, sessionId, options) => this.requestController.queue(text, sessionId, options),
      stop: (sessionId) => this.requestController.stop(sessionId, 'submit-shell'),
      send: (text, sessionId) => this.requestController.sendNow(text, sessionId),
    });
    this.composerShellCoordinator = new ChatComposerShellCoordinator({
      viewState: this.viewState,
      getInputValue: () => this.vm.inputValue,
      setInputValue: (value) => {
        this.engine.inputValue = value;
      },
      isWaiting: () => this.getCurrentSessionActionState().canStop,
      getEditingPendingKind: () => this.getCurrentPendingFollowupEditKind(),
      navigateInputHistory: (direction, currentValue) => this.navigateInputHistory(direction, currentValue),
      submitCurrentInput: (options) => this.submitCurrentDraftAction(options),
      getTextareaRef: () => this.chatTextarea,
      notifyInputTruncated: (maxChars) => {
        this.message.warning(`输入内容已截断到 ${maxChars.toLocaleString()} 个字符。请把大段内容作为文件或上下文添加。`);
      },
    });
    this.viewportShellCoordinator = new ChatViewportShellCoordinator({
      scrollManager: this.scrollManager,
      viewState: this.viewState,
      requestSessionListSummaryLoad: () => this.engine.requestSessionListRefresh({
        reason: 'shell',
        scope: 'summary',
        priority: 'after-paint',
      }),
    });
    this.memoryShellCoordinator = new ChatMemoryShellCoordinator({
      modal: this.modal,
      getHost: () => AilyHost.get(),
      getProjectPath: () => {
        const host = AilyHost.get();
        return host.project.currentProjectPath || host.project.projectRootPath || this.projectService.currentProjectPath || this.projectService.projectRootPath || '';
      },
      getSessionId: () => this.vm.sessionId,
      getRecentProjects: () => this.projectService.recentlyProjects ?? [],
      getSessionItems: () => this.sessionListItems,
      getRepositoryMemoryEnabled: () => this.ailyChatConfigService.repositoryMemoryEnabled === true,
      notifyInfo: (text) => this.message.info(text),
      notifyError: (text) => this.message.error(text),
    });
    this.actionRegistry = new ChatActionRegistry(() => ({
      currentMode: this.vm.currentMode,
      canRunManageModelsAction: () => Boolean(AilyHost.get().editor?.showTextDocument),
      runManageModelsAction: () => this.runManageModelsAction(),
      runShowMemoriesAction: () => this.memoryShellCoordinator.requestShowMemories(),
      runClearMemoriesAction: () => this.memoryShellCoordinator.requestClearMemories(),
      runConfigureCustomAgentsAction: () => {
        this.viewState.openSettings();
        return true;
      },
      runFocusTodosViewAction: () => this.runFocusTodosViewAction(),
      notifyManageModelsUnavailable: () => {
        this.message.warning('当前宿主无法打开模型配置文件');
      },
    }));
    this.viewState.bindPaneChromeActions({
      runNewChatAction: () => {
        this.requestNewChat();
        return true;
      },
      runToggleSettingsAction: () => {
        this.toggleSettings();
        return true;
      },
      runGoBackAction: () => {
        this.requestReturnToEntryInventory({
          saveCurrentSession: true,
        });
        return true;
      },
      runPickSessionAction: (event: MouseEvent) => {
        this.openSessionPicker(event);
        return true;
      },
    });
    this.lifecycleCoordinator = new ChatComponentLifecycleCoordinator({
      isHostInitialized: () => AilyHost.isInitialized(),
      initializeHost: () => {
        this.hostInitializer.ensureInitialized();
      },
      loadMermaid: () => import('mermaid'),
      setMermaidInstance: (instance) => {
        const mode = this.themeService.theme();
        const config =
          mode === 'dark'
            ? { startOnLoad: false, ...MERMAID_DARK_THEME }
            : { startOnLoad: false, theme: 'default' as const };
        MermaidCodeComponent.setMermaidInstance(instance, config);
      },
      initializeEngine: () => this.engine.init(this.chatTextarea ?? null),
      detachEngineView: () => this.engine.detachView(),
    });
    this.childToolSessionStateCleanup = window['childToolSession']?.onStateChanged?.((payload: unknown) => {
      this.updateChildToolSessions(payload);
    }) ?? null;
    void this.refreshChildToolSessions();
  }

  shouldShowStopPrimaryAction(): boolean {
    return this.getCurrentSessionActionState().canStop;
  }

  shouldShowSendPrimaryAction(): boolean {
    if (this.getCurrentPendingFollowupEditKind()) {
      return true;
    }

    const actionState = this.getCurrentSessionActionState();
    return actionState.canSend || actionState.canQueue || !actionState.canStop;
  }

  isSendPrimaryActionDisabled(): boolean {
    if (this.vm.authQuotaExhausted) {
      return true;
    }

    if (this.getCurrentPendingFollowupEditKind()) {
      return !this.hasDraftInput();
    }

    const actionState = this.getCurrentSessionActionState();
    return !actionState.canSend && !actionState.canQueue;
  }

  getSendPrimaryActionTooltip(): string {
    if (this.vm.authQuotaExhausted) {
      return 'Auth quota exhausted';
    }

    const pendingEditKind = this.getCurrentPendingFollowupEditKind();
    if (pendingEditKind === 'steering') {
      return 'Steer message (Alt+Enter to queue)';
    }

    if (pendingEditKind === 'queued') {
      return 'Queue message (Alt+Enter to steer)';
    }

    const actionState = this.getCurrentSessionActionState();
    if (actionState.canQueue) {
      return actionState.canSteer
        ? 'Send message (Alt+Enter to steer)'
        : 'Send message';
    }

    return actionState.tooltip;
  }

  getSendPrimaryActionIconClass(): string {
    if (this.getCurrentPendingFollowupEditKind() === 'steering') {
      return 'fa-light fa-arrow-up';
    }

    return this.getCurrentSessionActionState().primaryIcon === 'queue'
      ? 'fa-light fa-plus'
      : 'fa-light fa-paper-plane';
  }

  async submitCurrentDraftAction(options?: { queueKind?: ChatPendingRequestKind }): Promise<boolean> {
    if (this.isSendPrimaryActionDisabled()) {
      return false;
    }

    const submittedText = this.vm.inputValue.trim();
    this.startSubmitToFirstRenderPerformanceSampler();
    const queueKind = options?.queueKind ?? this.getCurrentPendingFollowupEditKind() ?? undefined;
    const submitted = await this.submitShellCoordinator.submitCurrentInput(
      queueKind ? { queueKind } : undefined,
    );

    if (submitted) {
      this.recordSubmittedInputHistory(submittedText);
      this.pendingFollowupEditState = null;
      this.cdr.markForCheck();
    }

    return submitted;
  }

  private navigateInputHistory(direction: 'previous' | 'next', currentValue: string): string | null {
    this.ensureInputHistoryLoaded();

    if ((currentValue || '').trim().length > 0) {
      this.inputHistoryNavigator.overlay({ inputText: currentValue });
    }

    const entry = direction === 'previous'
      ? this.inputHistoryNavigator.previous()
      : this.inputHistoryNavigator.next();
    return typeof entry?.inputText === 'string' ? entry.inputText : null;
  }

  private recordSubmittedInputHistory(inputText: string): void {
    const normalizedText = inputText.trim();
    if (!normalizedText) {
      return;
    }

    this.ensureInputHistoryLoaded();
    this.inputHistoryNavigator.append({ inputText: normalizedText });
  }

  private ensureInputHistoryLoaded(): void {
    const storageKey = this.resolveInputHistoryStorageKey();
    if (this.inputHistoryStorageKey === storageKey) {
      return;
    }

    this.inputHistoryStorageKey = storageKey;
    this.inputHistoryNavigator.replaceEntries(this.readInputHistoryEntries(storageKey));
  }

  private persistInputHistoryEntries(entries: readonly ChatInputHistoryEntry[]): void {
    const storageKey = this.inputHistoryStorageKey ?? this.resolveInputHistoryStorageKey();
    this.inputHistoryStorageKey = storageKey;

    try {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify(entries));
    } catch {
      // Input history is a UI convenience; storage failures must not block send.
    }
  }

  private readInputHistoryEntries(storageKey: string): ChatInputHistoryEntry[] {
    try {
      const raw = globalThis.localStorage?.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed
          .map(entry => ({
            inputText: typeof entry?.inputText === 'string' ? entry.inputText : '',
          }))
          .filter(entry => entry.inputText.trim().length > 0)
        : [];
    } catch {
      return [];
    }
  }

  private resolveInputHistoryStorageKey(): string {
    let hostProjectPath = '';
    let hostProjectRootPath = '';
    try {
      const host = AilyHost.get();
      hostProjectPath = host.project.currentProjectPath || '';
      hostProjectRootPath = host.project.projectRootPath || '';
    } catch {
      hostProjectPath = '';
      hostProjectRootPath = '';
    }

    const workspaceKey = hostProjectPath
      || hostProjectRootPath
      || this.projectService.currentProjectPath
      || this.projectService.projectRootPath
      || 'global';
    return `aily-chat.input-history:${workspaceKey}`;
  }

  private getCurrentSessionActionState() {
    return this.requestController.getActionState(this.vm.sessionId);
  }

  private getCurrentPendingFollowupEditKind(): ChatPendingRequestKind | null {
    const sessionId = typeof this.vm.sessionId === 'string' ? this.vm.sessionId.trim() : '';
    if (!sessionId || this.pendingFollowupEditState?.sessionId !== sessionId) {
      return null;
    }

    return this.pendingFollowupEditState.kind;
  }

  private hasDraftInput(): boolean {
    return this.vm.inputValue.trim().length > 0;
  }

  ngOnInit() {
    ChatPerformanceTracer.increment('entry_open.component_ng_on_init');
    ChatPerformanceTracer.mark('entry_open.component_ng_on_init');
    void this.toolI18n.load('aily-chat').then(() => {
      this.cdr.markForCheck();
    });
    this.lifecycleCoordinator.initialize();
    this.ailyChatConfigService.reloadRemoteModelCatalog('chat_view_open');
    this.syncSessionListDisplayState();
  }

  ngAfterViewInit(): void {
    ChatPerformanceTracer.increment('entry_open.pane_setup_complete');
    ChatPerformanceTracer.mark('entry_open.pane_setup_complete');
    this.viewportShellCoordinator.initialize(this.chatContainer);
    this.bindConversationScrollListener(this.chatContainer.nativeElement);
    this.scrollManager.handleContentHeightChange();
    this.syncSessionListDisplayState();
    this.scheduleChatInputFocusAfterSessionChange();
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => {
        ChatPerformanceTracer.increment('entry_open.first_stable_paint');
        ChatPerformanceTracer.mark('entry_open.first_stable_paint');
      });
    }
  }

  get activeImportedDebugView() {
    return this.debugBrowser.activeImportedDebugView;
  }

  get activeImportedResourceSummary() {
    return this.debugBrowser.activeImportedResourceSummary;
  }

  get activeImportedDebugEvents() {
    return this.debugBrowser.activeImportedDebugEvents;
  }

  get entrySessionItems(): ReadonlyArray<{ sessionId: string; title: string; current: boolean }> {
    return this.viewState.entrySessionItems;
  }

  get currentPaneTitle(): string {
    return this.viewState.currentPaneTitle;
  }

  get currentPaneSurface(): ChatPaneSurface {
    return this.viewState.currentPaneSurface;
  }

  get currentSessionTitle(): string {
    return this.viewState.currentSessionTitle;
  }

  get sessionListItems(): readonly ChatSessionListItem[] {
    return this.viewState.sessionListItems;
  }

  get selectedSessionId(): string {
    return this.viewState.selectedSessionId;
  }

  get sessionPickerRevealSessionId(): string {
    return this.viewState.pickerRevealSessionId;
  }

  get sessionListDisplayMode(): 'hidden' | 'stacked' | 'sidebar' {
    return this.viewState.sessionListDisplayMode;
  }

  get showSessionSidebar(): boolean {
    return this.viewState.showSessionSidebar;
  }

  get showStackedSessionList(): boolean {
    return this.viewState.showStackedSessionList;
  }

  get showLoginSurface(): boolean {
    return this.viewState.showLoginSurface;
  }

  get sessionSidebarWidth(): number {
    return this.viewState.sessionSidebarWidth;
  }

  get sessionSidebarResizeMinWidth(): number {
    return this.viewState.sessionSidebarResizeMinWidth;
  }

  get sessionSidebarMaxWidth(): number {
    return this.viewState.sessionSidebarMaxWidth;
  }

  get sessionTitleSurfaceModel(): ChatSessionTitleSurfaceModel {
    return this.viewState.sessionTitleSurfaceModel;
  }

  get hostHeaderActions() {
    return this.viewState.hostHeaderActions;
  }

  get sidebarSessionListSurfaceModel(): ChatPaneSessionListSurfaceModel {
    return this.viewState.sidebarSessionListSurfaceModel;
  }

  get stackedSessionListSurfaceModel(): ChatPaneSessionListSurfaceModel {
    return this.viewState.stackedSessionListSurfaceModel;
  }

  get entryInfoSurfaceModel(): ChatPaneEntryInfoSurfaceModel | null {
    return this.viewState.entryInfoSurfaceModel;
  }

  get paneStageSurfaceModel(): ChatPaneStageSurfaceModel | null {
    return this.viewState.paneStageSurfaceModel;
  }

  async onComposerAddFileOrFolderRequest(): Promise<void> {
    await this.resourceManager.addFileOrFolderResources();
  }

  get contextMenuItems(): IMenuItem[] {
    const runningProcessCount = this.getRunningProcessCount();
    return [
      {
        name: this.translate.instant('AILY_CHAT.ADD_FILE_OR_FOLDER'),
        action: 'context-add-file-or-folder',
        icon: 'fa-light fa-paperclip',
      },
      {
        name: this.translate.instant('AILY_CHAT.PROCESS_TITLE'),
        text: runningProcessCount > 0 ? String(runningProcessCount) : '',
        action: 'context-open-process-manager',
        icon: 'fa-light fa-square-terminal',
      },
      {
        name: this.translate.instant('AILY_CHAT.MEMORY_TITLE'),
        action: 'context-manage-memory',
        icon: 'fa-light fa-brain',
      },
    ];
  }

  toggleComposerContextMenu(event: MouseEvent): void {
    this.vm.closeSessionPicker();
    this.menuManager.toggleContextMenu(event, this.contextMenuItems);
  }

  handleContextMenuClick(item: IMenuItem): void {
    this.menuManager.closeAll();
    switch (item.action) {
      case 'context-add-file-or-folder':
        void this.onComposerAddFileOrFolderRequest();
        return;
      case 'context-open-process-manager':
        this.openProcessManagerDialog();
        return;
      case 'context-manage-memory':
        this.memoryShellCoordinator.requestManageMemories();
        return;
      default:
        return;
    }
  }

  get sessionPickerSurfaceModel(): ChatPaneSessionPickerSurfaceModel | null {
    return this.viewState.sessionPickerSurfaceModel;
  }

  handleSessionTitleActionRequested(request: ChatSessionTitleActionRequest): void {
    this.viewState.runSessionTitleAction(request);
  }

  focusChatInputFromTitleControl(): void {
    this.chatTextarea?.nativeElement?.focus();
  }

  handleHostHeaderActionRequested(request: ChatHostHeaderActionRequest): void {
    request.event.stopPropagation();
    this.viewState.runHostHeaderAction(request);
  }

  handleSessionListRetry(): void {
    this.viewState.retrySessionListLoad();
  }

  openDebugBrowserHome(): void {
    this.debugBrowser.openHome();
    this.cdr.markForCheck();
  }

  onSessionSidebarResize({ width }: NzResizeEvent): void {
    if (typeof width !== 'number' || !Number.isFinite(width)) {
      return;
    }

    this.viewState.setSessionSidebarWidth(width, { persist: false });
  }

  onSessionSidebarResizeEnd({ width }: NzResizeEvent): void {
    if (typeof width !== 'number' || !Number.isFinite(width)) {
      return;
    }

    this.viewState.setSessionSidebarWidth(width, { persist: true });
  }

  openImportedDebugSession(sessionId: string): void {
    if (!this.debugBrowser.openImportedSession(sessionId)) {
      return;
    }

    this.cdr.markForCheck();
  }

  openImportedDebugOverview(): void {
    this.debugBrowser.showView(ChatDebugBrowserViewState.Overview);
    this.cdr.markForCheck();
  }

  openImportedDebugLogs(): void {
    this.debugBrowser.showView(ChatDebugBrowserViewState.Logs);
    this.cdr.markForCheck();
  }

  openImportedDebugFlow(): void {
    this.debugBrowser.showView(ChatDebugBrowserViewState.FlowChart);
    this.cdr.markForCheck();
  }

  openImportedDebugCache(): void {
    this.debugBrowser.showView(ChatDebugBrowserViewState.CacheExplorer);
    this.cdr.markForCheck();
  }

  private async importDebugSnapshotFromDialog(): Promise<void> {
    const result = await importDebugSnapshotFromDialog({
      dialog: AilyHost.get().dialog,
      fs: AilyHost.get().fs,
      importDebugSnapshot: (data) => this.chatHistoryService.importDebugSnapshot(data),
    });

    if (result.kind === 'failed') {
      this.message.error('无法导入调试快照');
      return;
    }

    if (result.kind === 'imported') {
      this.debugBrowser.openImportedRecord(result.imported);
      this.cdr.markForCheck();
    }
  }

  closeDebugBrowser(): void {
    if (!this.debugBrowser.isOpen) {
      return;
    }

    this.debugBrowser.close();
    this.cdr.markForCheck();
  }

  async handleManualCompaction(event?: MouseEvent): Promise<void> {
    event?.stopPropagation();

    if (this.isManualCompacting || this.vm.isWaiting) {
      return;
    }

    this.isManualCompacting = true;
    this.cdr.markForCheck();

    try {
      const changed = await this.engine.compactConversation();
      if (changed) {
        this.engine.saveCurrentSession();
        this.engine.refreshHistoryList();
        this.message.success('对话已压缩');
      } else {
        this.message.info('当前没有可压缩的对话');
      }
    } catch (error) {
      console.error('[AilyChat] 手动压缩对话失败:', error);
      this.message.error('压缩对话失败');
    } finally {
      this.isManualCompacting = false;
      this.cdr.markForCheck();
    }
  }

  ngOnDestroy() {
    this.chatTextareaSubmitCleanup?.();
    this.chatTextareaSubmitCleanup = null;
    this.composerSendActionCleanup?.();
    this.composerSendActionCleanup = null;
    this.conversationScrollCleanup?.();
    this.conversationScrollCleanup = null;
    this.debugBrowserChangeSubscription.unsubscribe();
    this.sessionViewModelChangeSubscription.unsubscribe();
    this.runtimeProcessSnapshotSubscription.dispose();
    this.childToolSessionStateCleanup?.();
    this.childToolSessionStateCleanup = null;
    this.disconnectSessionViewportObserver();
    this.disconnectInputPartObserver();
    this.cancelDialogVirtualRafs();
    this.cancelVisibleResponseCompletionObservation();
    this.cancelDialogContentDeltaRaf();
    this.cancelSyncViewRefreshRaf();
    this.stopRendererStreamingPerformanceSampler();
    this.runtimeInteractionRevealEffect?.destroy();
    this.runtimeInteractionRevealEffect = null;
    this.cancelRuntimeInteractionReveal();
    this.scrollManager.setRevealHostDelegate?.(null);
    this.engine.setVisibleTranscriptItemPatchCallback(null);
    this.engine.setVisibleResponseRevisionObservedCallback(null);
    this.engine.setSubmittedRequestPaintObservedCallback(null);
    this.engine.setRuntimeRequestStatePatchCallback(null);
    this.lifecycleCoordinator.detachView();
  }

  private stopRendererStreamingPerformanceSampler(): void {
    if (this.rendererStreamingSamplerStopTimer !== null) {
      clearTimeoutOutsideAngular(this.rendererStreamingSamplerStopTimer);
      this.rendererStreamingSamplerStopTimer = null;
    }
    this.clearSubmitToFirstRenderSamplerStopTimer();
    if (!this.rendererStreamingSamplerActive) {
      ChatPerformanceTracer.stopEventLoopLagSampler();
      return;
    }
    this.rendererStreamingSamplerActive = false;
    ChatPerformanceTracer.stopEventLoopLagSampler();
  }

  getRunningProcessCount(): number {
    return this.readVisibleProcessScopeProcesses()
      .filter(process => process.removed !== true && process.running === true)
      .length;
  }

  openProcessManagerDialog(): void {
    const sessionScoped = this.useSessionScopedProcessUi();
    const sessionId = this.getCurrentSessionId();
    const projectPath = this.resolveCurrentProjectPathForProcessUi();
    if (sessionScoped && !sessionId) {
      return;
    }
    if (!sessionScoped && !projectPath) {
      return;
    }

    this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzCentered: true,
      nzBodyStyle: { padding: '0' },
      nzWidth: 1100,
      nzContent: ChatProcessManagerDialogComponent,
      nzData: {
        ...(sessionId ? { sessionId } : {}),
        ...(projectPath ? { projectPath } : {}),
      },
    });
  }

  openProcessWindowForCurrentSession(
    processId: string,
    outputSessionId?: string,
    outputFilePath?: string,
    command?: string,
    subappName?: string,
  ): void {
    const sessionId = this.getCurrentSessionId();
    if (!sessionId || !processId) {
      return;
    }
    const toolId = resolveChildToolIdFromProcess({ processId, command, subappName });
    const resolvedToolId = toolId || resolveChildToolIdFromProcess({
      processId,
      command,
      subappName,
      outputFilePath,
      cwd: this.resolveCurrentProjectPathForProcessUi(),
    });
    if (resolvedToolId) {
      const config = getChildToolConfig(resolvedToolId);
      this.uiService.openToolWindow(resolvedToolId, {
        title: this.resolveChildToolDisplayName(resolvedToolId, config),
      });
      return;
    }
    openChatProcessWindow({
      sessionId,
      processId,
      outputSessionId,
      outputFilePath,
      command,
    });
  }

  private getCurrentSessionId(): string {
    const viewModelSessionId = typeof this.vm.sessionId === 'string' ? this.vm.sessionId.trim() : '';
    if (viewModelSessionId) {
      return viewModelSessionId;
    }
    return this.resolvePermissionTargetSessionId();
  }

  private readCurrentSessionProcesses(): readonly ChatRuntimeHostSessionProcessSummary[] {
    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      return this.readActiveChildToolProcesses();
    }
    const snapshot = this.runtimeInteractionHost.readSnapshot(sessionId);
    const liveProcesses = Array.isArray(snapshot.processes) ? snapshot.processes : [];
    const projectPathHint = this.chatHistoryService.findEntry(sessionId)?.projectPath ?? null;
    const persistedProcesses = listPersistedBlocklyCommandSessionSnapshots(sessionId, projectPathHint);
    return this.mergeProcessSummaries(
      [...liveProcesses, ...this.readActiveChildToolProcesses()],
      persistedProcesses,
    );
  }

  private readCurrentProjectProcesses(): readonly ChatRuntimeHostSessionProcessSummary[] {
    const projectPath = this.resolveCurrentProjectPathForProcessUi();
    if (!projectPath) {
      return [];
    }

    const persistedProcesses = listPersistedBlocklyProjectCommandSessionSnapshots(projectPath);
    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      return this.mergeProcessSummaries(this.readActiveChildToolProcesses(), persistedProcesses);
    }

    const snapshot = this.runtimeInteractionHost.readSnapshot(sessionId);
    const liveProcesses = Array.isArray(snapshot.processes) ? snapshot.processes : [];
    return this.mergeProcessSummaries(
      [...liveProcesses, ...this.readActiveChildToolProcesses()],
      persistedProcesses,
    );
  }

  private readVisibleProcessScopeProcesses(): readonly ChatRuntimeHostSessionProcessSummary[] {
    if (this.useSessionScopedProcessUi()) {
      return this.readCurrentSessionProcesses();
    }
    return this.readCurrentProjectProcesses();
  }

  private useSessionScopedProcessUi(): boolean {
    return this.paneStageSurfaceModel?.showConversation === true;
  }

  private resolveCurrentProjectPathForProcessUi(): string {
    const host = AilyHost.get();
    return host.project.currentProjectPath
      || host.project.projectRootPath
      || this.projectService.currentProjectPath
      || this.projectService.projectRootPath
      || '';
  }

  private mergeProcessSummaries(
    liveProcesses: readonly ChatRuntimeHostSessionProcessSummary[],
    persistedProcesses: readonly ChatRuntimeHostSessionProcessSummary[],
  ): readonly ChatRuntimeHostSessionProcessSummary[] {
    const merged = new Map<string, ChatRuntimeHostSessionProcessSummary>();
    for (const process of persistedProcesses) {
      merged.set(process.processId, process);
    }
    for (const process of liveProcesses) {
      const existing = merged.get(process.processId);
      merged.set(process.processId, existing
        ? {
            ...existing,
            ...process,
            outputFilePath: process.outputFilePath ?? existing.outputFilePath,
          }
        : process);
    }
    return collapseActiveChildToolServeProcesses(
      [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
    );
  }

  private readActiveChildToolProcesses(): readonly ChatRuntimeHostSessionProcessSummary[] {
    return buildChildToolProcessSummaries(this.childToolSessions, {
      sessionId: this.getCurrentSessionId(),
      projectPath: this.resolveCurrentProjectPathForProcessUi(),
    });
  }

  private async refreshChildToolSessions(): Promise<void> {
    try {
      const sessions = await window['childToolSession']?.list?.();
      this.updateChildToolSessions(sessions);
    } catch (error) {
      console.warn('[AilyChat] Failed to refresh child tool sessions:', error);
    }
  }

  private updateChildToolSessions(payload: unknown): void {
    this.childToolSessions = Array.isArray(payload)
      ? payload as ChildToolSessionListItem[]
      : [];
    this.cdr.markForCheck();
  }

  private resolveChildToolDisplayName(toolId: string, config = getChildToolConfig(toolId)): string {
    if (!config) {
      return toolId;
    }

    const globalName = this.translate.instant(config.namespace);
    if (typeof globalName === 'string' && globalName && globalName !== config.namespace) {
      return globalName;
    }

    const title = this.translate.instant(config.titleKey);
    if (typeof title === 'string' && title && title !== config.titleKey) {
      return title;
    }

    return toolId;
  }

  returnStandaloneSurfaceToMain(): void {
    this.lifecycleCoordinator.detachView();
    const iWindow = window['iWindow'] as {
      returnMain?: (path: string) => Promise<unknown> | void;
    } | undefined;
    if (!iWindow?.returnMain) {
      return;
    }

    void Promise.resolve(iWindow.returnMain('/aily-chat')).catch((error) => {
      console.error('[AilyChat] Failed to return standalone chat surface to main window:', error);
    });
  }

  returnStandaloneSurfaceToEntryInventory(): void {
    this.requestReturnToEntryInventory({ saveCurrentSession: true });
  }

  focusTodosView(): boolean {
    if (!this.inputPartHost?.hasVisibleTodos()) {
      return false;
    }

    return this.inputPartHost.focusTodoList();
  }

  toggleTodosViewFocus(): boolean {
    if (!this.inputPartHost?.hasVisibleTodos()) {
      return false;
    }

    if (this.inputPartHost.isTodoListFocused()) {
      this.chatTextarea?.nativeElement?.focus();
      return true;
    }

    return this.inputPartHost.focusTodoList();
  }

  runFocusTodosViewAction(): boolean {
    return runChatTodoFocusAction({
      currentMode: this.vm.currentMode,
      toggleTodosViewFocus: () => this.toggleTodosViewFocus(),
      notifyUnavailable: () => this.message.info('当前没有可聚焦的 agent 待办事项'),
    });
  }

  runManageModelsAction(): boolean {
    const targetPath = this.engine.languageModelsService.prepareConfigurationFile();
    if (!targetPath) {
      this.message.error('无法准备聊天模型配置文件');
      return false;
    }

    const host = AilyHost.get();
    const projectPath = host.project.currentProjectPath || host.project.projectRootPath;
    const openResult = host.editor?.showTextDocument?.(targetPath, { projectPath });

    if (typeof (openResult as Promise<boolean> | undefined)?.then === 'function') {
      void (openResult as Promise<boolean>).then((opened) => {
        if (!opened) {
          this.message.error('无法打开聊天模型配置文件');
        }
      }).catch((err) => {
        console.error('打开聊天模型配置文件失败:', err);
        this.message.error('无法打开聊天模型配置文件');
      });
      return true;
    }

    if (!openResult) {
      this.message.error('无法打开聊天模型配置文件');
      return false;
    }

    return true;
  }

  get actionMenuItems() {
    return this.actionRegistry.getMenuItems();
  }

  get permissionMenuItems(): IMenuItem[] {
    const isFullAccess = this.engine.currentSessionPermissionProfile === 'danger-full-access';
    const isAutoReview = !isFullAccess && this.engine.currentSessionApprovalsReviewer === 'auto_review';
    const isDefault = !isAutoReview && !isFullAccess;

    return [
      {
        name: '默认权限',
        action: 'permission-default',
        icon: 'fa-light fa-shield-check',
        current: isDefault,
        tooltip: '使用默认权限。',
      },
      {
        name: '自动审查',
        action: 'permission-auto-review',
        icon: 'fa-light fa-robot',
        current: isAutoReview,
        tooltip: '将审批请求交给 Auto Review',
      },
      { sep: true },
      {
        name: '完全访问权限',
        action: 'permission-full-access',
        icon: 'fa-light fa-triangle-exclamation',
        current: isFullAccess,
        tooltip: '高风险：跳过权限拦截。仅在受控环境下使用。',
      },
    ];
  }

  get permissionButtonIconClass(): string {
    if (this.engine.currentSessionPermissionProfile === 'danger-full-access') {
      return 'fa-light fa-triangle-exclamation';
    }

    if (this.engine.currentSessionApprovalsReviewer === 'auto_review') {
      return 'fa-light fa-robot';
    }

    return 'fa-light fa-shield-check';
  }

  toggleActionMenu(event: MouseEvent): void {
    this.vm.closeSessionPicker();
    this.menuManager.toggleActionMenu(event, [...this.actionMenuItems]);
  }

  toggleReasoningMenu(event: MouseEvent): void {
    this.vm.closeSessionPicker();
    this.reasoningMenuItems = [...this.vm.currentReasoningEffortMenuItems];
    this.menuManager.toggleReasoningMenu(event, [...this.reasoningMenuItems]);
  }

  togglePermissionMenu(event: MouseEvent): void {
    this.permissionModeTooltip?.hide();
    this.switchShellCoordinator.togglePermissionMenu(event, this.permissionMenuItems);
  }

  onComposerModelMenuClick(event: MouseEvent): void {
    this.composerModelTooltip?.hide();
    this.switchShellCoordinator.toggleModelMenu(event, this.vm.modelMenuItems);
  }

  get permissionTooltipTrigger(): 'hover' | null {
    return this.menuManager.showPermissionMenu ? null : 'hover';
  }

  get composerModelTooltipTrigger(): 'hover' | null {
    return this.menuManager.showModelMenu ? null : 'hover';
  }

  handlePermissionMenuClick(item: IMenuItem): void {
    this.switchShellCoordinator.permissionMenuClick(item);
  }

  private async updatePermissionPresetWithConfirmation(preset: string): Promise<void> {
    const action = typeof preset === 'string' ? preset.trim() : '';
    if (!action) {
      return;
    }

    const sessionId = this.resolvePermissionTargetSessionId();
    if (action !== 'permission-full-access') {
      this.engine.applyComposerPermissionPreset(action, sessionId || undefined);
      this.notifyPermissionPresetApplied(action);
      return;
    }

    if (sessionId && this.rememberedFullAccessSessions.has(sessionId)) {
      this.engine.applyComposerPermissionPreset(action, sessionId);
      this.notifyPermissionPresetApplied(action);
      return;
    }

    const decision = await this.confirmFullAccessPermission();
    if (!decision.confirmed) {
      return;
    }

    if (decision.rememberForSession && sessionId) {
      this.rememberedFullAccessSessions.add(sessionId);
    }

    this.engine.applyComposerPermissionPreset(action, sessionId);
    this.notifyPermissionPresetApplied(action, { remembered: decision.rememberForSession });
  }

  private notifyPermissionPresetApplied(
    action: string,
    options?: {
      remembered?: boolean;
    },
  ): void {
    if (action === 'permission-auto-review') {
      this.message.success('已切换为自动审查');
      return;
    }

    if (action === 'permission-full-access') {
      if (options?.remembered) {
        this.message.success('已切换为完全访问权限（本会话已记住）');
        return;
      }

      this.message.success('已切换为完全访问权限');
      return;
    }

    this.message.success('已切换为默认审批/默认权限');
  }

  private resolvePermissionTargetSessionId(): string {
    const engineSessionId = typeof this.engine.sessionId === 'string' ? this.engine.sessionId.trim() : '';
    if (engineSessionId) {
      return engineSessionId;
    }

    return typeof this.chatService.currentSessionId === 'string' ? this.chatService.currentSessionId.trim() : '';
  }

  private confirmFullAccessPermission(): Promise<ChatPermissionConfirmDialogResult> {
    return new Promise<ChatPermissionConfirmDialogResult>((resolve) => {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzMaskClosable: false,
        nzKeyboard: false,
        nzWidth: 420,
        nzBodyStyle: { padding: '0' },
        nzContent: ChatPermissionConfirmDialogComponent,
        nzData: {
          title: '启用完全访问权限',
          message: '该设置会跳过权限拦截，允许执行高风险操作。请确认你正在受控环境中使用。',
          riskNote: '建议仅用于你完全信任的仓库与会话。',
          confirmLabel: '继续启用',
          cancelLabel: '取消',
          rememberLabel: '本会话内记住我的选择',
        },
      });

      modalRef.afterClose.subscribe((result: ChatPermissionConfirmDialogResult | undefined) => {
        resolve({
          confirmed: !!result?.confirmed,
          rememberForSession: !!result?.rememberForSession,
        });
      });
    });
  }

  private hasPendingFollowupRequests(sessionId?: string | null): boolean {
    return this.requestController.hasPending(sessionId ?? this.vm.sessionId);
  }

  getCurrentSessionPendingFollowupRequests(): readonly PendingFollowupRequest[] {
    return this.requestController.getPending(this.vm.sessionId);
  }

  getCurrentSessionPendingFollowupSections(): readonly PendingFollowupSection[] {
    const pendingRequests = this.getCurrentSessionPendingFollowupRequests();
    const steering = pendingRequests.filter(request => request.kind === 'steering');
    const queued = pendingRequests.filter(request => request.kind === 'queued');
    const sections: PendingFollowupSection[] = [];

    if (steering.length > 0) {
      sections.push({ kind: 'steering', title: 'Steering', requests: steering });
    }

    if (queued.length > 0) {
      sections.push({ kind: 'queued', title: 'Queued', requests: queued });
    }

    return sections;
  }

  getPendingFollowupDisplayText(request: PendingFollowupRequest): string {
    const displayText = typeof request?.prepared?.displayText === 'string'
      ? request.prepared.displayText.trim()
      : '';
    if (displayText) {
      return displayText;
    }

    const content = typeof request?.content === 'string' ? request.content.trim() : '';
    return content;
  }

  editPendingFollowup(request: PendingFollowupRequest): void {
    const sessionId = typeof this.vm.sessionId === 'string' ? this.vm.sessionId.trim() : '';
    const editText = this.getPendingFollowupEditableText(request);
    if (!sessionId || !editText) {
      return;
    }

    if (!this.requestController.removePending(sessionId, request.id)) {
      return;
    }

    this.pendingFollowupEditState = {
      sessionId,
      requestId: request.id,
      kind: request.kind,
    };
    this.resourceManager.items = this.clonePendingFollowupResourceItems(request.prepared?.resourceItems);
    this.engine.inputValue = editText;
    this.composerShellCoordinator.updateSuggestions();
    this.cdr.markForCheck();
    this.focusComposerAfterPendingEdit();
  }

  clearCurrentSessionPendingFollowupRequests(): void {
    this.requestController.clearPending(this.vm.sessionId);
    this.cdr.markForCheck();
  }

  removePendingFollowup(requestId: string): void {
    if (this.requestController.removePending(this.vm.sessionId, requestId)) {
      this.cdr.markForCheck();
    }
  }

  async runPendingFollowupNext(requestId: string): Promise<void> {
    await this.requestController.runNext(this.vm.sessionId, requestId);
    this.cdr.markForCheck();
  }

  private getPendingFollowupEditableText(request: PendingFollowupRequest): string {
    const preparedText = typeof request?.prepared?.text === 'string'
      ? request.prepared.text.trim()
      : '';
    if (preparedText) {
      return preparedText;
    }

    const content = typeof request?.content === 'string' ? request.content.trim() : '';
    return content;
  }

  private clonePendingFollowupResourceItems(items?: readonly ResourceItem[]): ResourceItem[] {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    return items.map(item => ({ ...item }));
  }

  private focusComposerAfterPendingEdit(): void {
    const focusComposer = () => {
      this.chatTextarea?.nativeElement?.focus();
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => focusComposer());
      return;
    }

    setTimeout(focusComposer, 0);
  }

  private confirmPendingFollowupRequestsBeforeSend(sessionId?: string | null): Promise<'keep' | 'remove' | false> {
    const targetSessionId = sessionId ?? this.vm.sessionId;
    if (!this.hasPendingFollowupRequests(targetSessionId)) {
      return Promise.resolve('keep');
    }

    return new Promise<'keep' | 'remove' | false>((resolve) => {
      const pendingCount = this.requestController.getPending(targetSessionId).length;
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzMaskClosable: false,
        nzKeyboard: false,
        nzWidth: 360,
        nzBodyStyle: { padding: '0' },
        nzContent: ChatPendingRequestsDialogComponent,
        nzData: { count: pendingCount },
      });

      modalRef.afterClose.subscribe((result: ChatPendingRequestsDialogResult | null | undefined) => {
        if (result === 'keep' || result === 'remove') {
          resolve(result);
          return;
        }

        resolve(false);
      });
    });
  }

  handleModelMenuActionClick(payload: {
    event?: MouseEvent;
    action?: string;
    item?: IMenuItem & {
      data?: {
        model?: { presetId?: string; model?: string };
        modelSelectionId?: string;
        reasoningMenuItems?: IMenuItem[];
        configurationMenuItemsByAction?: Record<string, IMenuItem[]>;
      };
    };
  }): void {
    if (!(payload.event instanceof MouseEvent) || typeof payload.action !== 'string' || !payload.action.trim()) {
      return;
    }

    if (payload.action === 'pin-model' || payload.action === 'unpin-model') {
      const modelSelectionId = typeof payload.item?.data?.modelSelectionId === 'string' && payload.item.data.modelSelectionId.trim()
        ? payload.item.data.modelSelectionId.trim()
        : typeof payload.item?.data?.model?.presetId === 'string' && payload.item.data.model.presetId.trim()
          ? payload.item.data.model.presetId.trim()
          : typeof payload.item?.data?.model?.model === 'string'
            ? payload.item.data.model.model.trim()
            : '';
      if (!modelSelectionId) {
        return;
      }

      if (payload.action === 'pin-model') {
        this.chatService.pinModelId(modelSelectionId);
      } else {
        this.chatService.unpinModelId(modelSelectionId);
      }

      this.vm.closeSessionPicker();
      this.reasoningMenuItems = [];
      this.menuManager.showReasoningMenu = false;
      this.menuManager.showModelMenu = true;
      return;
    }

    const configurationMenuItemsByAction = payload.item?.data?.configurationMenuItemsByAction;
    const reasoningMenuItems = configurationMenuItemsByAction && Array.isArray(configurationMenuItemsByAction[payload.action])
      ? configurationMenuItemsByAction[payload.action]
      : Array.isArray(payload.item?.data?.reasoningMenuItems)
        ? payload.item.data.reasoningMenuItems
        : [];
    const configurationMenuItems = Array.isArray(reasoningMenuItems)
      ? reasoningMenuItems
      : [];
    if (configurationMenuItems.length === 0) {
      return;
    }

    this.vm.closeSessionPicker();
    this.reasoningMenuItems = [...configurationMenuItems];
    this.menuManager.toggleReasoningMenu(payload.event, [...this.reasoningMenuItems]);
  }

  handleActionMenuClick(item: { action?: string }): void {
    this.menuManager.showActionMenu = false;
    this.actionRegistry.runMenuAction(item);
  }

  ngAfterViewChecked(): void {
    this.syncRendererStreamingPerformanceSampler();
    if (this.shouldUseDialogVirtualization(this.vm.dialogItems)) {
      this.scheduleDialogWindowMeasurement();
    }
  }

  private syncRendererStreamingPerformanceSampler(): void {
    const hasStreamingDialog = this.vm.dialogItems.some(item => item.doing);
    if (hasStreamingDialog) {
      this.visibleTurnObservedStreaming = true;
      this.reportSubmitToFirstRenderLatency();
      if (this.rendererStreamingSamplerStopTimer !== null) {
        clearTimeout(this.rendererStreamingSamplerStopTimer);
        this.rendererStreamingSamplerStopTimer = null;
      }
      if (!this.rendererStreamingSamplerActive) {
        this.rendererStreamingSamplerActive = true;
        this.rendererStreamingBudgetStartedAt = performance.now();
        this.rendererStreamingCounterBaseline = ChatPerformanceTracer.snapshotCounters();
        this.clearSubmitToFirstRenderSamplerStopTimer();
        this.ngZone.runOutsideAngular(() => {
          // Submit and streaming are separate VS Code-style response-model
          // phases. Reset the interval baseline so a delayed submit sample
          // cannot be attributed to list-item streaming work.
          ChatPerformanceTracer.stopEventLoopLagSampler();
          ChatPerformanceTracer.startEventLoopLagSampler({ intervalMs: 100, thresholdMs: 24, enableTrace: false });
          ChatPerformanceTracer.mark('renderer_streaming_sampler.start');
        });
      }
      return;
    }

    this.reportVisibleTurnCompletionLatency();

    if (!this.rendererStreamingSamplerActive || this.rendererStreamingSamplerStopTimer !== null) {
      return;
    }

    this.ngZone.runOutsideAngular(() => {
      this.rendererStreamingSamplerStopTimer = setTimeoutOutsideAngular(() => {
        this.rendererStreamingSamplerStopTimer = null;
        this.rendererStreamingSamplerActive = false;
        ChatPerformanceTracer.mark('renderer_streaming_sampler.stop');
        const rendererStreamingBudget = ChatPerformanceTracer.snapshotRendererStreamingBudget({
          recentSampleCount: 40,
          sinceT: this.rendererStreamingBudgetStartedAt,
          maxRecentEventLoopLagMs: 50,
          maxRecentEventLoopLagTotalMs: 120,
          maxRecentLongTaskMs: 50,
          maxRecentLongTaskTotalMs: 120,
        });
        const rendererStreamingCounters = ChatPerformanceTracer.snapshotCounters();
        if (!rendererStreamingBudget.ok) {
          console.warn(
            '[AilyChat][RendererStreamingJankScalar]',
            [
              `lagCount=${rendererStreamingBudget.recentEventLoopLag.count}`,
              `lagMaxMs=${rendererStreamingBudget.recentEventLoopLag.maxMs}`,
              `lagTotalMs=${rendererStreamingBudget.recentEventLoopLag.totalMs}`,
              `longTaskCount=${rendererStreamingBudget.recentLongTasks.count}`,
              `longTaskMaxMs=${rendererStreamingBudget.recentLongTasks.maxMs}`,
              `longTaskTotalMs=${rendererStreamingBudget.recentLongTasks.totalMs}`,
              `lagSurfaces=${summarizeLagSurfaces(rendererStreamingBudget.recentEventLoopLag.samples)}`,
              `lagDetails=${summarizeLagDetails(rendererStreamingBudget.recentEventLoopLag.samples)}`,
              `actualDurations=${summarizeDurationCounterDeltas(
                rendererStreamingCounters,
                this.rendererStreamingCounterBaseline,
                [
                  'message_parts_incremental_patch_actual',
                  'activity_group_refresh',
                  'dialog_content_delta_flush',
                  'scroll_height_update',
                  'activity_group_scroll_sync',
                ],
              )}`,
              `violations=${rendererStreamingBudget.violations.join('|')}`,
            ].join(' '),
          );
          console.warn('[AilyChat][RendererStreamingJank]', rendererStreamingBudget);
        }
        ChatPerformanceTracer.stopEventLoopLagSampler();
      }, 1000);
    });
  }

  private startSubmitToFirstRenderPerformanceSampler(): void {
    this.cancelVisibleResponseCompletionObservation();
    this.clearSubmitToFirstRenderSamplerStopTimer();
    const startedAt = performance.now();
    this.rendererStreamingBudgetStartedAt = startedAt;
    this.submitToFirstRenderStartedAt = startedAt;
    this.visibleTurnSubmitStartedAt = startedAt;
    this.visibleTurnLastContentAt = null;
    this.visibleTurnCompletionTailOverrideMs = null;
    this.visibleTurnResponseCompleteObservedAt = null;
    this.visibleTurnObservedStreaming = false;
    this.ngZone.runOutsideAngular(() => {
      ChatPerformanceTracer.startEventLoopLagSampler({ intervalMs: 50, thresholdMs: 24, enableTrace: false });
      ChatPerformanceTracer.mark('submit_to_first_render_sampler.start');
      this.submitToFirstRenderSamplerStopTimer = setTimeoutOutsideAngular(() => {
        this.submitToFirstRenderSamplerStopTimer = null;
        if (this.rendererStreamingSamplerActive) {
          return;
        }
        this.reportSubmitToFirstRenderLatency();
        ChatPerformanceTracer.stopEventLoopLagSampler();
      }, 5000);
    });
  }

  private clearSubmitToFirstRenderSamplerStopTimer(): void {
    if (this.submitToFirstRenderSamplerStopTimer !== null) {
      clearTimeoutOutsideAngular(this.submitToFirstRenderSamplerStopTimer);
      this.submitToFirstRenderSamplerStopTimer = null;
    }
  }

  private reportSubmitToFirstRenderLatency(): void {
    const startedAt = this.submitToFirstRenderStartedAt;
    if (startedAt === null) {
      return;
    }
    this.submitToFirstRenderStartedAt = null;
    this.clearSubmitToFirstRenderSamplerStopTimer();
    ChatPerformanceTracer.mark('submit_to_first_render_sampler.stop');
    const budget = ChatPerformanceTracer.snapshotRendererStreamingBudget({
      recentSampleCount: 80,
      sinceT: startedAt,
      maxRecentEventLoopLagMs: 40,
      maxRecentEventLoopLagTotalMs: 120,
      maxRecentLongTaskMs: 50,
      maxRecentLongTaskTotalMs: 120,
    });
    const elapsedMs = performance.now() - startedAt;
    console.info(
      '[AilyChat][SubmitToFirstRenderLatencyScalar]',
      `elapsedMs=${elapsedMs.toFixed(1)} lagMaxMs=${budget.recentEventLoopLag.maxMs} lagTotalMs=${budget.recentEventLoopLag.totalMs}`,
    );
    if (!budget.ok) {
      console.warn(
        '[AilyChat][SubmitToFirstRenderJankScalar]',
        [
          `lagCount=${budget.recentEventLoopLag.count}`,
          `lagMaxMs=${budget.recentEventLoopLag.maxMs}`,
          `lagTotalMs=${budget.recentEventLoopLag.totalMs}`,
          `longTaskCount=${budget.recentLongTasks.count}`,
          `longTaskMaxMs=${budget.recentLongTasks.maxMs}`,
          `longTaskTotalMs=${budget.recentLongTasks.totalMs}`,
          `violations=${budget.violations.join('|')}`,
        ].join(' '),
      );
    }
  }

  get renderedDialogItems(): readonly ChatVisibleTranscriptDialogItem[] {
    const items = this.vm.dialogItems;
    const sourceChanged = this.dialogWindowModel.setItems(items);
    if (!this.shouldUseDialogVirtualization(items)) {
      this.resetDialogVirtualWindow(items);
      return this.dialogWindowModel.snapshot.items;
    }

    if (sourceChanged) {
      this.computeDialogVirtualWindow(items);
      this.scheduleDialogWindowMeasurement();
    }

    return this.dialogWindowModel.snapshot.items;
  }

  private readRenderingDiagnostics(): AilyChatE2eRenderingDiagnostics {
    const items = this.vm.dialogItems;
    const usesVirtualization = this.shouldUseDialogVirtualization(items);
    const container = this.chatContainer?.nativeElement as HTMLElement | undefined;
    const queryRoot = (container
      ?? document.querySelector('app-aily-chat')) as HTMLElement | null;
    return {
      totalDialogItems: items.length,
      renderedDialogItems: usesVirtualization ? this.dialogWindowModel.snapshot.items.length : items.length,
      mountedDialogElements: queryRoot?.querySelectorAll('aily-x-dialog').length ?? 0,
      virtualRows: queryRoot?.querySelectorAll('.dialog-virtual-row').length ?? 0,
      topSpacerHeight: this.dialogVirtualTopSpacerHeight,
      bottomSpacerHeight: this.dialogVirtualBottomSpacerHeight,
      scrollTop: Math.round(container?.scrollTop ?? 0),
      scrollHeight: Math.round(container?.scrollHeight ?? 0),
      clientHeight: Math.round(container?.clientHeight ?? 0),
      scrollLock: this.scrollManager.scrollLock,
      virtualWindowStartIndex: this.dialogWindowModel.snapshot.startIndex,
      virtualWindowEndIndex: this.dialogWindowModel.snapshot.endIndex,
      measuredRowCount: this.dialogWindowModel.measuredRowCount,
    };
  }

  handleConversationScroll(): void {
    const previousFollowButton = this.scrollManager.showFollowBottomButton;
    this.scrollManager.checkUserScroll();
    this.scheduleDialogWindowRefresh();
    this.maybeLoadOlderVisibleTurns();
    if (previousFollowButton !== this.scrollManager.showFollowBottomButton) {
      this.cdr.detectChanges();
    }
  }

  private maybeLoadOlderVisibleTurns(): void {
    const container = this.chatContainer?.nativeElement as HTMLElement | undefined;
    if (!container || container.scrollTop > 480 || !this.engine.hasOlderVisibleTurns || this.olderTurnPageLoadPromise) {
      return;
    }
    const beforeItems = this.vm.dialogItems;
    this.dialogWindowModel.setItems(beforeItems);
    const anchorIndex = Math.max(0, this.dialogWindowModel.snapshot.startIndex);
    const anchorItemId = beforeItems[anchorIndex]?.id ?? null;
    const anchorRelativeTop = anchorItemId
      ? this.dialogWindowModel.offsetBefore(anchorIndex) - container.scrollTop
      : 0;
    this.olderTurnPageLoadPromise = this.engine.loadOlderVisibleTurns(this.vm.sessionId)
      .then(result => {
        if (!result || result.addedCount === 0 || !anchorItemId) return;
        const items = this.vm.dialogItems;
        this.dialogWindowModel.setItems(items);
        const nextAnchorIndex = items.findIndex(item => item.id === anchorItemId);
        if (nextAnchorIndex < 0) return;
        const targetScrollTop = Math.max(0, this.dialogWindowModel.offsetBefore(nextAnchorIndex) - anchorRelativeTop);
        this.dialogWindowModel.layout(targetScrollTop, Math.max(1, container.clientHeight || 640));
        this.cdr.detectChanges();
        requestAnimationFrame(() => {
          container.scrollTop = targetScrollTop;
          this.scheduleDialogWindowRefresh();
          this.scheduleDialogWindowMeasurement();
        });
      })
      .catch(error => console.warn('[AilyChat][VisibleTurnWindow] Failed to load older turns:', error))
      .finally(() => { this.olderTurnPageLoadPromise = null; });
  }

  private bindConversationScrollListener(element: HTMLElement): void {
    this.conversationScrollCleanup?.();
    const listener = () => this.handleConversationScroll();
    this.ngZone.runOutsideAngular(() => {
      element.addEventListener('scroll', listener, { passive: true });
    });
    this.conversationScrollCleanup = () => element.removeEventListener('scroll', listener);
  }

  readonly dialogContentHeightChangeHandler = (change: ChatDialogItemHeightChange): void => {
    this.handleDialogContentDelta(change);
  };

  private handleDialogContentDelta(change: ChatDialogItemHeightChange): void {
    const itemId = typeof change?.itemId === 'string' ? change.itemId.trim() : '';
    const height = typeof change?.height === 'number' && Number.isFinite(change.height)
      ? Math.ceil(change.height)
      : 0;
    if (!itemId || height <= 0) {
      return;
    }
    this.pendingDialogContentDeltaItemIds.add(itemId);
    this.dialogWindowModel.updateMeasuredHeight(itemId, height);

    if (this.dialogContentDeltaRaf !== null) {
      return;
    }

    const flush = () => {
      ChatPerformanceTracer.runWithSurface('renderer_content_delta', () => {
        const startedAt = performance.now();
        this.dialogContentDeltaRaf = null;
        const pendingItemIds = Array.from(this.pendingDialogContentDeltaItemIds);
        const measureAll = false;
        this.pendingDialogContentDeltaItemIds.clear();
        const items = this.vm.dialogItems;
        const usesVirtualization = this.shouldUseDialogVirtualization(items);
        let measured = pendingItemIds.length > 0;
        let virtualWindowChanged = false;
        if (usesVirtualization) {
          if (measured) {
            virtualWindowChanged = this.computeDialogVirtualWindow(items);
            if (virtualWindowChanged) {
              this.cdr.markForCheck();
            }
          }
        }
        ChatPerformanceTracer.runWithSurface('renderer_scroll', () => {
          this.scrollManager.handleItemHeightChange(itemId, height);
        }, 'conversation_content_delta');
        ChatPerformanceTracer.recordDuration(
          'dialog_content_delta_flush',
          performance.now() - startedAt,
          `items=${pendingItemIds.length},all=${measureAll},virtual=${usesVirtualization},measured=${measured},window=${virtualWindowChanged}`,
          { slowThresholdMs: 8 },
        );
      }, 'conversation');
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.dialogContentDeltaRaf = globalThis.requestAnimationFrame(flush);
      return;
    }

    this.dialogContentDeltaRaf = setTimeout(flush, 16) as unknown as number;
  }

  private cancelDialogContentDeltaRaf(): void {
    if (this.dialogContentDeltaRaf === null) {
      return;
    }
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.dialogContentDeltaRaf);
    } else {
      clearTimeout(this.dialogContentDeltaRaf as unknown as ReturnType<typeof setTimeout>);
    }
    this.dialogContentDeltaRaf = null;
  }

  resumeConversationAutoScroll(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.prepareDialogBottomReveal();
    this.scrollManager.resumeFollowBottom('auto');
    this.scheduleDialogBottomFollowConfirmation();
    this.scheduleDialogWindowRefresh();
    this.cdr.markForCheck();
  }

  private trackRuntimeInteractionReveal(): void {
    const sessionId = this.vm.sessionId;
    if (!sessionId) {
      return;
    }

    const activeQuestion = this.runtimeInteractionHost.getQuestionWidget(sessionId);
    const activePlanReview = this.runtimeInteractionHost.getActivePlanReview(sessionId);
    const activeConfirmation = this.runtimeInteractionHost.getActiveConfirmation(sessionId);

    let target: ChatRevealTarget | null = null;
    let key = '';

    if (activeQuestion) {
      target = 'pending-question';
      key = `${sessionId}:question:${activeQuestion.partId}`;
    } else if (activePlanReview) {
      target = 'pending-plan-review';
      key = `${sessionId}:plan:${activePlanReview.id}`;
    } else if (activeConfirmation) {
      target = 'pending-confirmation';
      key = `${sessionId}:confirmation:${activeConfirmation.id}:${activeConfirmation.data.resolved === true ? 'resolved' : 'pending'}`;
    }

    if (!target || !key || key === this.lastRuntimeInteractionRevealKey) {
      return;
    }

    this.lastRuntimeInteractionRevealKey = key;
    this.scheduleRuntimeInteractionReveal(target);
  }

  private scheduleRuntimeInteractionReveal(target: ChatRevealTarget): void {
    this.cancelRuntimeInteractionReveal();
    this.runtimeInteractionRevealTimer = setTimeout(() => {
      this.runtimeInteractionRevealTimer = null;
      this.scrollManager.revealTarget(target, {
        behavior: 'auto',
        followBottom: true,
        maxAttempts: 30,
      });
      this.scheduleDialogWindowRefresh();
      this.cdr.markForCheck();
    }, 0);
  }

  private cancelRuntimeInteractionReveal(): void {
    if (this.runtimeInteractionRevealTimer !== null) {
      clearTimeout(this.runtimeInteractionRevealTimer);
      this.runtimeInteractionRevealTimer = null;
    }
  }

  private scheduleSyncViewRefresh(): void {
    if (this.syncViewRefreshRaf !== null) {
      return;
    }

    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;

    this.ngZone.runOutsideAngular(() => {
      this.syncViewRefreshRaf = schedule(() => {
        this.syncViewRefreshRaf = null;
        this.syncSessionListDisplayState();
        this.cdr.detectChanges();
      });
    });
  }

  private reportVisibleTurnCompletionLatency(): void {
    if (!this.visibleTurnObservedStreaming || this.visibleTurnSubmitStartedAt === null) {
      return;
    }

    const completedAt = performance.now();
    const totalMs = completedAt - this.visibleTurnSubmitStartedAt;
    const tailMs = this.visibleTurnCompletionTailOverrideMs
      ?? (this.visibleTurnLastContentAt === null
        ? 0
        : completedAt - this.visibleTurnLastContentAt);
    const responseCompleteToVisibleCompleteMs = this.visibleTurnResponseCompleteObservedAt === null
      ? null
      : Math.max(0, completedAt - this.visibleTurnResponseCompleteObservedAt);
    console.info(
      '[AilyChat][VisibleTurnLatencyScalar]',
      [
        `submitToVisibleCompleteMs=${totalMs.toFixed(1)}`,
        `lastContentToVisibleCompleteMs=${tailMs.toFixed(1)}`,
        `responseCompleteToVisibleCompleteMs=${responseCompleteToVisibleCompleteMs === null ? '<unknown>' : responseCompleteToVisibleCompleteMs.toFixed(1)}`,
      ].join(' '),
    );
    this.visibleTurnSubmitStartedAt = null;
    this.visibleTurnLastContentAt = null;
    this.visibleTurnCompletionTailOverrideMs = null;
    this.visibleTurnResponseCompleteObservedAt = null;
    this.visibleTurnObservedStreaming = false;
  }

  private scheduleVisibleResponseCompletionObservation(): void {
    this.cancelVisibleResponseCompletionObservation();
    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;
    this.ngZone.runOutsideAngular(() => {
      this.visibleTurnCompletionFrameId = schedule(() => {
        this.visibleTurnCompletionFrameId = schedule(() => {
          this.visibleTurnCompletionFrameId = null;
          // The first frame applies the mounted list-item/part completion
          // patch; the second observes its final markdown/group DOM. This is
          // the response-model completion boundary and must not depend on an
          // unrelated application-wide Angular tick.
          this.reportVisibleTurnCompletionLatency();
          this.syncRendererStreamingPerformanceSampler();
        });
      });
    });
  }

  private cancelVisibleResponseCompletionObservation(): void {
    if (this.visibleTurnCompletionFrameId === null) {
      return;
    }
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.visibleTurnCompletionFrameId);
    } else {
      clearTimeout(this.visibleTurnCompletionFrameId as unknown as ReturnType<typeof setTimeout>);
    }
    this.visibleTurnCompletionFrameId = null;
  }

  private applyVisibleTranscriptItemPatch(patch: {
    readonly sessionId: string;
    readonly patches: readonly ChatVisibleTranscriptDialogItemPatch[];
  }): boolean {
    if (!patch.sessionId || patch.sessionId !== this.vm.sessionId) {
      return false;
    }
    if (patch.patches.length === 0 || this.shouldUseDialogVirtualization(this.vm.dialogItems)) {
      return false;
    }
    if (this.visibleTurnSubmitStartedAt !== null && patch.patches.some(itemPatch =>
      itemPatch.item.role === 'aily'
      && itemPatch.item.doing
      && (itemPatch.kind === 'added' || itemPatch.kind === 'updated')
    )) {
      this.visibleTurnLastContentAt = performance.now();
    }
    const result = this.transcriptListRenderer?.applyPatches(
      patch.patches,
      canPatchVisibleTranscriptItemWithoutRowDetect,
    );
    if (!result?.applied) {
      return false;
    }
    if (result.requiresRowMeasurement) {
      this.scheduleDialogWindowMeasurement();
    }
    return true;
  }

  private applyRuntimeRequestStatePatch(patch: {
    readonly sessionId: string;
    readonly requestInProgress: boolean;
    readonly activeTurnId: string | null;
    readonly previousActiveTurnId: string | null;
  }): void {
    if (!patch.sessionId || patch.sessionId !== this.vm.sessionId) {
      return;
    }

    const root = this.windowBoxElement;
    root?.classList.toggle('request-in-progress', patch.requestInProgress);
    root?.setAttribute('aria-busy', patch.requestInProgress ? 'true' : 'false');
    root?.querySelector<HTMLElement>('.input-box')?.classList.toggle('working', patch.requestInProgress);

    const sendAction = root?.querySelector<HTMLElement>('.composer-send-action');
    const stopAction = root?.querySelector<HTMLElement>('.composer-stop-action');
    sendAction?.classList.toggle('action-hidden', patch.requestInProgress || !this.shouldShowSendPrimaryAction());
    stopAction?.classList.toggle('action-hidden', !patch.requestInProgress);

    for (const control of Array.from(root?.querySelectorAll<HTMLButtonElement>('[data-disable-during-request]') ?? [])) {
      control.disabled = patch.requestInProgress || control.dataset['disabledForLocalState'] === 'true';
    }

    this.transcriptListRenderer?.applySessionRequestState(
      patch.activeTurnId ?? patch.previousActiveTurnId,
      patch.requestInProgress,
    );
    this.floatingTodo?.applyRequestInProgress(patch.requestInProgress);
  }

  private cancelSyncViewRefreshRaf(): void {
    if (this.syncViewRefreshRaf === null) {
      return;
    }

    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.syncViewRefreshRaf);
    } else {
      clearTimeout(this.syncViewRefreshRaf as unknown as ReturnType<typeof setTimeout>);
    }
    this.syncViewRefreshRaf = null;
  }

  private shouldUseDialogVirtualization(items: readonly ChatVisibleTranscriptDialogItem[]): boolean {
    return this.dialogWindowModel.shouldWindow(items);
  }

  private resetDialogVirtualWindow(items: readonly ChatVisibleTranscriptDialogItem[]): void {
    this.dialogWindowModel.setItems(items);
    this.dialogWindowModel.showAll();
  }

  private scheduleDialogWindowRefresh(): void {
    if (this.dialogVirtualRefreshRaf !== null) {
      return;
    }

    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;

    this.dialogVirtualRefreshRaf = schedule(() => {
      this.dialogVirtualRefreshRaf = null;
      const items = this.vm.dialogItems;
      if (!this.shouldUseDialogVirtualization(items)) {
        this.resetDialogVirtualWindow(items);
        return;
      }

      const changed = this.computeDialogVirtualWindow(items);
      if (changed) {
        this.cdr.markForCheck();
      }
    });
  }

  private scheduleDialogWindowMeasurement(): void {
    if (this.dialogVirtualMeasureRaf !== null) {
      return;
    }

    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;

    this.dialogVirtualMeasureRaf = schedule(() => {
      this.dialogVirtualMeasureRaf = null;
      if (!this.shouldUseDialogVirtualization(this.vm.dialogItems)) {
        return;
      }

      const measured = this.measureRenderedDialogRows();
      if (measured && this.computeDialogVirtualWindow(this.vm.dialogItems)) {
        this.cdr.markForCheck();
      }
    });
  }

  private computeDialogVirtualWindow(items: readonly ChatVisibleTranscriptDialogItem[]): boolean {
    this.dialogWindowModel.setItems(items);
    const viewport = this.chatContainer?.nativeElement as HTMLElement | undefined;
    const viewportHeight = Math.max(1, viewport?.clientHeight || 640);
    const totalHeight = this.dialogWindowModel.totalHeight;
    const fallbackBottomTop = Math.max(0, totalHeight - viewportHeight);
    const viewportTop = Math.max(0, viewport?.scrollTop ?? fallbackBottomTop);
    return this.dialogWindowModel.layout(viewportTop, viewportHeight);
  }

  private computeDialogVirtualWindowForRange(
    items: readonly ChatVisibleTranscriptDialogItem[],
    windowTop: number,
    windowBottom: number,
    _totalHeight?: number,
  ): boolean {
    this.dialogWindowModel.setItems(items);
    return this.dialogWindowModel.layoutRange(windowTop, windowBottom);
  }

  private prepareDialogRevealTarget(target: ChatRevealTarget, options: ChatRevealOptions): boolean {
    const items = this.vm.dialogItems;
    if (!this.shouldUseDialogVirtualization(items)) {
      return false;
    }

    const targetIndex = resolveChatDialogRevealTargetIndex(items, target);
    if (targetIndex < 0) {
      if (typeof target !== 'string') {
        void this.engine.ensureVisibleTurnLoaded(target.turnId, this.vm.sessionId).then(loaded => {
          if (loaded) {
            this.scrollManager.revealTarget(target, options);
          }
        });
        return true;
      }
      return false;
    }

    this.dialogWindowModel.setItems(items);
    const targetTop = this.dialogWindowModel.offsetBefore(targetIndex);
    const changed = this.dialogWindowModel.layoutItem(targetIndex);

    const container = this.chatContainer?.nativeElement as HTMLElement | undefined;
    if (container) {
      const relativeTop = options.relativeTop ?? 0;
      container.scrollTo({
        top: Math.max(0, Math.round(targetTop + relativeTop)),
        behavior: options.behavior ?? 'auto',
      });
    }

    if (changed) {
      this.cdr.markForCheck();
    }
    return true;
  }

  private prepareDialogBottomReveal(): boolean {
    const items = this.vm.dialogItems;
    if (!this.shouldUseDialogVirtualization(items)) {
      return false;
    }

    const container = this.chatContainer?.nativeElement as HTMLElement | undefined;
    if (!container) {
      return false;
    }

    this.dialogWindowModel.setItems(items);
    const totalHeight = this.dialogWindowModel.totalHeight;
    const viewportHeight = Math.max(1, container.clientHeight || 640);
    const viewportTop = Math.max(0, totalHeight - viewportHeight);
    const changed = this.dialogWindowModel.layoutBottom(viewportHeight);

    container.scrollTo({
      top: Math.round(viewportTop),
      behavior: 'auto',
    });

    if (changed) {
      this.cdr.markForCheck();
    }
    return true;
  }

  private scheduleDialogBottomFollowConfirmation(): void {
    this.cancelDialogBottomFollowConfirmation();

    const requestId = ++this.dialogBottomFollowRequestId;
    let attempts = 0;
    const maxAttempts = 6;
    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;

    const run = () => {
      if (requestId !== this.dialogBottomFollowRequestId) {
        return;
      }

      this.dialogBottomFollowRaf = null;
      attempts++;

      let measured = false;
      if (this.shouldUseDialogVirtualization(this.vm.dialogItems)) {
        measured = this.measureRenderedDialogRows();
      }

      this.prepareDialogBottomReveal();
      this.scrollManager.resumeFollowBottom('auto');

      if (measured) {
        this.cdr.markForCheck();
      }

      if (attempts < maxAttempts) {
        this.dialogBottomFollowRaf = schedule(run);
      }
    };

    this.dialogBottomFollowRaf = schedule(run);
  }

  private cancelDialogBottomFollowConfirmation(): void {
    this.dialogBottomFollowRequestId++;
    if (this.dialogBottomFollowRaf === null) {
      return;
    }

    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.dialogBottomFollowRaf);
    } else {
      clearTimeout(this.dialogBottomFollowRaf as unknown as ReturnType<typeof setTimeout>);
    }
    this.dialogBottomFollowRaf = null;
  }

  private measureRenderedDialogRows(): boolean {
    const rows = this.transcriptListRenderer?.readVirtualRows() ?? [];
    let changed = false;

    for (const rowRef of rows) {
      const element = rowRef.nativeElement;
      const itemId = element.dataset['chatItemId'];
      if (!itemId) {
        continue;
      }

      const measuredHeight = element.getBoundingClientRect().height || element.offsetHeight || 0;
      if (measuredHeight <= 0) {
        continue;
      }

      if (this.dialogWindowModel.updateMeasuredHeight(itemId, measuredHeight)) {
        changed = true;
      }
    }

    return changed;
  }

  handleCheckpointRestoreSurfaceAction(event?: Event, sessionResource?: string): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.handleDialogTaskAction({ action: 'redoEdits', sessionResource });
  }

  handleDialogTaskAction(detail?: ChatTaskActionDetail): void {
    this.engine.handleTaskActionDetail(detail);
  }

  toggleSettings(): void {
    this.viewState.toggleSettings();
  }

  closeSettings(): void {
    this.viewState.closeSettings();
  }

  openSessionPicker(event?: MouseEvent): void {
    this.viewState.openSessionPicker(event);
  }

  handleSessionSelection(event: { sessionId: string; item: ChatSessionListItem }): void {
    void this.sessionActions.requestSwitchToSession(
      event.sessionId,
      this.chatService.currentSessionId,
      this.engine.editCheckpointService,
      this.createSessionSwitchCallbacks(),
      event.item,
    );
  }

  handleSessionPreload(event: { sessionId: string; item: ChatSessionListItem }): void {
    if (!event.sessionId) {
      return;
    }

    void this.engine.preloadSessionModel(event.sessionId, {
      fallbackProjectPath: event.item.projectPath ?? null,
    }).catch((error) => {
      console.warn('[AilyChat] Failed to preload session model:', error);
    });
  }

  handleSessionAction(event: { action: string; data: any }): void {
    this.sessionActions.sessionActionClick(event, this.chatService.currentSessionId, this.createSessionRowActionCallbacks());
  }

  handleSessionOverflowOpenChange(open: boolean): void {
    this.sessionOverflowMenuOpen = open;
    this.cdr.markForCheck();
  }

  requestNewChat(): void {
    this.requestReturnToEntryInventory({
      saveCurrentSession: true,
    });
  }

  requestReturnToEntryInventory(options?: { saveCurrentSession?: boolean }): void {
    void this.sessionActions.requestReturnToEntryInventory(
      this.engine.editCheckpointService,
      this.createSessionEntryCommandCallbacks(),
      this.chatService.currentSessionId,
      {
        saveCurrentSession: options?.saveCurrentSession,
      },
    );
  }

  requestImportDebugSnapshot(): void {
    void this.sessionActions.requestImportDebugSnapshot(this.engine.editCheckpointService, this.createSessionCommandCallbacks());
  }

  private createSessionSwitchCallbacks() {
    return {
      onCloseSessionPicker: () => this.viewState.closeSessionPicker(),
      onSaveCurrentSession: () => this.engine.saveCurrentSession(),
      onSwitchSession: (sessionId: string, fallbackProjectPath?: string | null) => this.runRestoreAwareSessionSwitch(sessionId, fallbackProjectPath),
      onSetCompleted: () => {
        this.engine.isCompleted = true;
      },
      onSetServerSessionInactive: () => undefined,
    };
  }

  private createSessionRowActionCallbacks() {
    return {
      onSwitchSession: (sessionId: string, fallbackProjectPath?: string | null) => this.runRestoreAwareSessionSwitch(sessionId, fallbackProjectPath),
      onNewChat: () => {
        this.closeDebugBrowser();
        return this.runReturnAwareEntryState(this.chatService.currentSessionId);
      },
      onEnterEntryState: (sessionId?: string | null) => this.runReturnAwareEntryState(sessionId),
      isSessionRequestInProgress: (sessionId: string) => this.engine.isSessionRequestInProgress(sessionId),
      onDeleteSession: async (sessionId: string) => {
        this.closeDebugBrowser();
        return await this.engine.deleteSessionAction(sessionId);
      },
      onDetectChanges: () => this.cdr.markForCheck(),
      onUpdateTitle: (title: string) => {
        if (typeof this.chatService.setCurrentSessionTitle === 'function') {
          this.chatService.setCurrentSessionTitle({
            text: title,
            source: 'user',
          });
        } else {
          this.chatService.currentSessionTitle = title;
        }
      },
      onRefreshSessions: () => {
        this.closeDebugBrowser();
        return this.engine.refreshHistoryList();
      },
    };
  }

  private createSessionCommandCallbacks() {
    return {
      onSaveCurrentSession: () => this.engine.saveCurrentSession(),
      onNewChat: () => {
        this.closeDebugBrowser();
        return this.runReturnAwareEntryState(this.chatService.currentSessionId);
      },
      onImportDebugSnapshot: () => this.importDebugSnapshotFromDialog(),
    };
  }

  private createSessionEntryCommandCallbacks() {
    return {
      onSaveCurrentSession: () => this.engine.saveCurrentSession(),
      onEnterEntryState: (sessionId?: string | null) => this.runReturnAwareEntryState(sessionId),
    };
  }

  private async runReturnAwareEntryState(sessionId?: string | null): Promise<void> {
    this.closeDebugBrowser();
    await this.engine.returnToEntryInventory({
      sessionId,
    });
    this.scheduleChatInputFocusAfterSessionChange();
  }

  private async runRestoreAwareHistoryLoad(): Promise<void> {
    this.closeDebugBrowser();
    try {
      await this.engine.getHistory();
      const sessionId = this.chatService.currentSessionId || this.engine.sessionId;
      if (sessionId) {
        this.chatHistoryService.clearRecordedRestoreFailure?.(sessionId);
      }
    } catch (error) {
      this.reportSessionRestoreFailure(error);
    }
  }

  private async runRestoreAwareSessionSwitch(
    sessionId: string,
    fallbackProjectPath?: string | null,
  ): Promise<boolean> {
    this.closeDebugBrowser();
    try {
      const switched = await this.engine.switchToSession(sessionId, {
        fallbackProjectPath: fallbackProjectPath ?? null,
      });
      if (switched) {
        this.scheduleChatInputFocusAfterSessionChange();
      }
      return switched;
    } catch (error) {
      this.reportSessionRestoreFailure(error);
      return false;
    }
  }

  private scheduleChatInputFocusAfterSessionChange(): void {
    const focusInput = () => {
      this.engine.bindChatTextareaRef(this.chatTextarea ?? null);
      this.engine.scheduleComposerInputFocus();
    };

    focusInput();
    setTimeout(focusInput, 50);
    setTimeout(focusInput, 150);
  }

  private reportSessionRestoreFailure(error: unknown): void {
    if (isSessionLifecycleSupersededError(error)) {
      return;
    }

    const restoreDetails = readSessionLifecycleRestoreErrorDetails(error);
    if (restoreDetails) {
      try {
        const imported = this.chatHistoryService.captureRestoreFailureDebugSnapshot?.(
          restoreDetails,
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : undefined,
        );
        if (imported) {
          this.debugBrowser.openImportedRecord(imported, ChatDebugBrowserViewState.Overview);
          this.cdr.markForCheck();
        }
      } catch (captureError) {
        console.warn('[AilyChatComponent] failed to capture restore failure debug snapshot:', captureError);
      }
    }

    const marker = restoreDetails?.restoreFailure?.kind ?? restoreDetails?.stage;
    if (marker) {
      this.message.error(`会话恢复失败（${marker}），请重试`);
      return;
    }
    this.message.error('会话恢复失败，请重试');
  }

  handleReasoningMenuClick(item: { data?: { model?: unknown; modelConfiguration?: { key?: string; value: unknown } } }): void {
    this.menuManager.showReasoningMenu = false;
    this.reasoningMenuItems = [];

    const model = item?.data?.model;
    const modelConfiguration = item?.data?.modelConfiguration;
    if (!model || typeof modelConfiguration?.key !== 'string' || !modelConfiguration.key.trim()) {
      return;
    }

    void this.engine.switchToModelConfiguration(model as Parameters<ChatEngineService['switchToModelConfiguration']>[0], {
      key: modelConfiguration.key.trim(),
      value: modelConfiguration.value,
    });
  }

  setComposerFocusState(focused: boolean): void {
    this.isComposerFocused = focused;
  }

  onUserMessageEditSessionOpened(turnId: string): void {
    this.userMessageEditingTurnId = turnId;
    this.cdr.markForCheck();
  }

  onUserMessageEditSessionClosed(): void {
    this.userMessageEditingTurnId = undefined;
    this.cdr.markForCheck();
  }

  closeChatSessionMenus(): void {
    this.vm.closeSessionPicker();
    this.menuManager.closeAll();
    this.sessionOverflowMenuOpen = false;
    this.cdr.markForCheck();
  }

  handleTodoFocusToggleShortcut(): void {
    this.runFocusTodosViewAction();
  }

  openAuthQuotaUsage(event?: MouseEvent): void {
    event?.stopPropagation();
    this.uiService.openTool('user-center');
  }

  dismissChatInputNotice(event?: MouseEvent): void {
    event?.stopPropagation();
    this.engine.chatInputNoticeStateService.dismissCurrentNotice();
  }

  async continueCurrentExecution(event?: MouseEvent): Promise<void> {
    event?.stopPropagation();
    try {
      await this.engine.continueCurrentExecution();
    } catch (error) {
      console.warn('[AilyChatComponent] continue current execution failed:', error);
      this.message.error('继续执行失败，请从最新状态重试');
    }
  }

  getChatInputNoticeSeverityClass(notice: { tone?: string } | null | undefined): string {
    switch (notice?.tone) {
      case 'error':
        return 'severity-error';
      case 'warning':
        return 'severity-warning';
      default:
        return 'severity-info';
    }
  }

  private observeSessionViewport(element: HTMLElement | null): void {
    if (this.observedSessionViewportElement === element) {
      return;
    }

    this.disconnectSessionViewportObserver();
    this.observedSessionViewportElement = element;

    if (!element) {
      this.viewState.setSessionViewportWidth(0);
      return;
    }

    this.viewState.setSessionViewportWidth(element.clientWidth);

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    this.sessionViewportResizeObserver = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect?.width ?? element.clientWidth;
      this.ngZone.run(() => {
        this.viewState.setSessionViewportWidth(nextWidth);
        this.syncSessionListDisplayState();
      });
    });
    this.sessionViewportResizeObserver.observe(element);
  }

  private observeInputPart(element: HTMLElement | null): void {
    if (this.observedInputPartElement === element) {
      return;
    }

    this.disconnectInputPartObserver();
    this.observedInputPartElement = element;

    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }

    let lastHeight = element.getBoundingClientRect().height;
    this.inputPartResizeObserver = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect?.height ?? element.getBoundingClientRect().height;
      if (Math.abs(nextHeight - lastHeight) < 1) {
        return;
      }

      lastHeight = nextHeight;
      this.ngZone.run(() => this.handleInputPartHeightChanged());
    });
    this.inputPartResizeObserver.observe(element);
  }

  private handleInputPartHeightChanged(): void {
    this.scheduleDialogWindowMeasurement();
    this.scheduleDialogWindowRefresh();

    if (!this.scrollManager.scrollLock) {
      this.scrollManager.handleContentHeightChange();
      this.cdr.markForCheck();
      return;
    }

    this.prepareDialogBottomReveal();
    this.scrollManager.resumeFollowBottom('auto');
    this.scheduleDialogBottomFollowConfirmation();
    this.cdr.markForCheck();
  }

  private disconnectSessionViewportObserver(): void {
    this.sessionViewportResizeObserver?.disconnect();
    this.sessionViewportResizeObserver = null;
    this.observedSessionViewportElement = null;
  }

  private syncSessionListDisplayState(): void {
    const layoutKey = [
      this.viewState.currentViewSessionId,
      this.vm.hasConversationContent ? 'content' : 'empty',
      this.vm.isLoggedIn ? 'auth' : 'anonymous',
    ].join('|');
    if (layoutKey === this.lastSessionListLayoutKey) {
      return;
    }
    this.lastSessionListLayoutKey = layoutKey;
    this.viewState.syncSessionViewerLayout({
      hasConversationContent: this.vm.hasConversationContent,
      isAuthenticated: this.vm.isLoggedIn,
    });
    this.cdr.markForCheck();
  }

  private disconnectInputPartObserver(): void {
    this.inputPartResizeObserver?.disconnect();
    this.inputPartResizeObserver = null;
    this.observedInputPartElement = null;
  }

  private cancelDialogVirtualRafs(): void {
    if (this.dialogVirtualRefreshRaf !== null) {
      if (typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(this.dialogVirtualRefreshRaf);
      } else {
        clearTimeout(this.dialogVirtualRefreshRaf as unknown as ReturnType<typeof setTimeout>);
      }
      this.dialogVirtualRefreshRaf = null;
    }

    if (this.dialogVirtualMeasureRaf !== null) {
      if (typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(this.dialogVirtualMeasureRaf);
      } else {
        clearTimeout(this.dialogVirtualMeasureRaf as unknown as ReturnType<typeof setTimeout>);
      }
      this.dialogVirtualMeasureRaf = null;
    }

    this.cancelDialogBottomFollowConfirmation();
  }
}

function summarizeLagSurfaces(samples: readonly Readonly<Record<string, unknown>>[]): string {
  const totals = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  for (const sample of samples) {
    const surface = typeof sample['surface'] === 'string' && sample['surface']
      ? sample['surface']
      : 'unknown';
    const lagMs = Number(sample['lagMs']);
    const current = totals.get(surface) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    if (Number.isFinite(lagMs)) {
      current.totalMs += lagMs;
      current.maxMs = Math.max(current.maxMs, lagMs);
    }
    totals.set(surface, current);
  }
  return [...totals.entries()]
    .sort((left, right) => right[1].totalMs - left[1].totalMs)
    .map(([surface, value]) => `${surface}:${value.count}/${value.totalMs.toFixed(1)}/${value.maxMs.toFixed(1)}`)
    .join(',') || '<none>';
}

function summarizeLagDetails(samples: readonly Readonly<Record<string, unknown>>[]): string {
  const totals = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  for (const sample of samples) {
    const surface = typeof sample['surface'] === 'string' && sample['surface']
      ? sample['surface']
      : 'unknown';
    const detail = typeof sample['detail'] === 'string' && sample['detail']
      ? sample['detail']
      : '<none>';
    const key = `${surface}/${detail}`;
    const lagMs = Number(sample['lagMs']);
    const current = totals.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    if (Number.isFinite(lagMs)) {
      current.totalMs += lagMs;
      current.maxMs = Math.max(current.maxMs, lagMs);
    }
    totals.set(key, current);
  }
  return [...totals.entries()]
    .sort((left, right) => right[1].totalMs - left[1].totalMs)
    .map(([key, value]) => `${key}:${value.count}/${value.totalMs.toFixed(1)}/${value.maxMs.toFixed(1)}`)
    .join(',') || '<none>';
}

function summarizeDurationCounterDeltas(
  counters: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
  tags: readonly string[],
): string {
  const values: string[] = [];
  for (const tag of tags) {
    const prefix = `duration.${tag}`;
    const count = Math.max(0, (counters[`${prefix}.count`] ?? 0) - (baseline[`${prefix}.count`] ?? 0));
    const totalMs = Math.max(0, (counters[`${prefix}.totalMs`] ?? 0) - (baseline[`${prefix}.totalMs`] ?? 0));
    if (count > 0 || totalMs > 0) {
      values.push(`${tag}:${count}/${totalMs.toFixed(0)}`);
    }
  }
  return values.join(',') || '<none>';
}

function canPatchVisibleTranscriptItemWithoutRowDetect(
  previousItem: ChatVisibleTranscriptDialogItem | null | undefined,
  nextItem: ChatVisibleTranscriptDialogItem,
): boolean {
  if (!previousItem || previousItem.id !== nextItem.id) {
    return false;
  }
  if (previousItem.role !== 'aily' || nextItem.role !== 'aily') {
    return false;
  }
  if (!previousItem.doing || !nextItem.doing) {
    return false;
  }
  if (previousItem.turnId !== nextItem.turnId
    || previousItem.responseId !== nextItem.responseId
    || previousItem.turnModelName !== nextItem.turnModelName
    || previousItem.turnModelBillingLabel !== nextItem.turnModelBillingLabel
    || previousItem.responseVote !== nextItem.responseVote
    || previousItem.isLastAily !== nextItem.isLastAily
    || previousItem.showCheckpointRestore !== nextItem.showCheckpointRestore) {
    return false;
  }

  // The response content renderer owns every structured part mutation,
  // including insert/remove/reorder. Row detection is reserved for row chrome.
  return previousItem.parts.length > 0 && nextItem.parts.length > 0;
}
