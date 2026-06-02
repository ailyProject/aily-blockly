import { Subscription, skip, distinctUntilChanged, combineLatest } from 'rxjs';
import { ConfigService } from '../../../services/config.service';

import type {
  IAgentLifecycle,
  IChatCoordination,
  IChatServiceAccess,
  IChatViewAccess,
  IProjectContext,
  ISessionAccess,
} from '../core/chat-context';
import { AilyHost } from '../core/host';
import type { ChatTextOptions } from '../services/chat.service';
import { ChatViewWriteBridge, type ChatViewWriteBridgeContext } from './chat-view-write-bridge';
import {
  hasHostResponseConversationContent,
  type HostResponseProjection,
} from './host-turn-response-state';
import { DEFAULT_CHAT_SESSION_TYPE } from '../core/chat-mode';
import type { ChatTaskActionEvent } from './chat-task-action-coordinator';

type ChatSubscriptionCoordinatorContext = ChatViewWriteBridgeContext
  & Pick<
    IAgentLifecycle,
    'hasInitializedForThisLogin' | 'isSessionStarting' | 'mcpInitialized' | 'isWaiting' | 'isCompleted' | 'messageSubscription'
  >
  & Pick<IChatViewAccess, 'toolCallStates'>
  & Pick<IProjectContext, 'currentUserGroup' | 'prjPath' | 'prjRootPath' | 'isLoggedIn'>
  & Pick<ISessionAccess, 'chatService' | 'chatHistoryService'>
  & Pick<IChatServiceAccess, 'resourceManager' | 'absAutoSyncService' | 'ailyChatConfigService' | 'message'>
  & Pick<IChatCoordination, 'session' | 'interaction' | 'lexStream'>
  & {
    readonly configService: ConfigService;
  }
  & {
    readonly hostResponseProjection?: HostResponseProjection | null;
  };

type ChatSubscriptionViewWriteContext = ConstructorParameters<typeof ChatViewWriteBridge>[0];

interface SubscriptionCallbacks {
  receiveTextFromExternal: (text: string, options?: ChatTextOptions) => void;
  showAiWritingNotice: (isWaiting: boolean) => void;
  handleTaskAction: (event: ChatTaskActionEvent) => void;
  flushPendingAutoSend: () => void;
  syncAuthQuotaState: () => void;
  refreshRequestQuotaState: () => Promise<void>;
  refreshSessionProviderOptionsSources: () => void;
  clearAuthQuotaState: () => void;
  clearRequestQuotaState: () => void;
}

type ChatSubscriptionViewWriteAccess = Pick<ChatViewWriteBridge, 'clearChatView'>;

/**
 * Coordinates host-side subscriptions and teardown for ChatEngineService.
 */
export class ChatSubscriptionCoordinator {
  private textMessageSubscription: Subscription | null = null;
  private loginStatusSubscription: Subscription | null = null;
  private authChangeSubscription: Subscription | null = null;
  private aiWritingSubscription: Subscription | null = null;
  private aiWaitingSubscription: Subscription | null = null;
  private projectPathSubscription: Subscription | null = null;
  private configChangedSubscription: Subscription | null = null;
  private hostConfigReloadSubscription: Subscription | null = null;
  private blockSelectionSubscription: Subscription | null = null;
  private uiChatMessageSubscription: Subscription | null = null;
  private userInfoSubscription: Subscription | null = null;
  private taskActionHandler: ((event: Event) => void) | null = null;
  private active = false;
  private lastKnownApiServer = '';
  private readonly viewWriteBridge: ChatSubscriptionViewWriteAccess;

  private async tryInitializeLoggedInSession(): Promise<void> {
    if (!this.isReadyForLoggedInSessionWork() || this.ctx.hasInitializedForThisLogin || this.ctx.isSessionStarting) {
      return;
    }

    this.ctx.hasInitializedForThisLogin = true;
    await this.ctx.session.initializeEntryInventory({ restorePersistedTarget: false });
  }

  private async tryInitializeLoggedInSessionFromAuthRefresh(): Promise<void> {
    if (this.hasConversationHistory()) {
      return;
    }

    await this.tryInitializeLoggedInSession();
  }

  private isReadyForLoggedInSessionWork(): boolean {
    if (!this.ctx.isLoggedIn) {
      return false;
    }

    return this.isAuthSnapshotReady(AilyHost.get().auth);
  }

  private isAuthSnapshotReady(authProvider: ReturnType<typeof AilyHost.get>['auth'] | undefined): boolean {
    if (!authProvider?.getSnapshot) {
      return true;
    }

    if (!authProvider.authChanged$ && !authProvider.authSnapshot$) {
      return true;
    }

    return !!authProvider.getSnapshot();
  }

  constructor(
    private readonly ctx: ChatSubscriptionCoordinatorContext,
    private readonly callbacks: SubscriptionCallbacks,
  ) {
    const viewWriteContext: ChatSubscriptionViewWriteContext = {
      get list() {
        return ctx.list;
      },
      set list(list) {
        ctx.list = list;
      },
      get partStore() {
        return ctx.partStore;
      },
      get viewAdapter() {
        return ctx.viewAdapter;
      },
      get scrollManager() {
        return ctx.scrollManager;
      },
      invalidateHostRequestGraph: () => ctx.invalidateHostRequestGraph(),
      triggerSyncDetectChanges: () => ctx.triggerSyncDetectChanges(),
      get sessionId() {
        return ctx.sessionId;
      },
      get chatHistoryService() {
        return ctx.chatHistoryService;
      },
      get currentModelName() {
        return ctx.currentModelName;
      },
      get currentMessageSource() {
        return ctx.currentMessageSource;
      },
      get ngZone() {
        return ctx.ngZone;
      },
    };
    this.viewWriteBridge = new ChatViewWriteBridge(viewWriteContext);
  }

  setup(): void {
    this.active = true;
    this.lastKnownApiServer = this.normalizeApiServer(this.ctx.configService.getCurrentApiServer());

    this.textMessageSubscription = this.ctx.chatService.getTextMessages().subscribe(message => {
      if (!message) {
        return;
      }

      this.callbacks.receiveTextFromExternal(message.text, message.options);
      this.ctx.chatService.clearBufferedTextMessage(message.timestamp);
    });

    const uiChatMessage$ = AilyHost.get().ui?.chatMessage$;
    if (uiChatMessage$) {
      this.uiChatMessageSubscription = uiChatMessage$.subscribe((message: any) => {
        this.callbacks.receiveTextFromExternal(message.text, message.options);
      });
    }

    const authProvider = AilyHost.get().auth;
    authProvider?.initializeAuth?.().then(() => {
      if (!this.active) {
        return;
      }

      this.userInfoSubscription = authProvider?.userInfo$?.subscribe((userInfo) => {
        this.ctx.currentUserGroup = Array.isArray(userInfo?.groups) ? [...userInfo.groups] : [];
      }) ?? null;

      this.authChangeSubscription = authProvider?.authChanged$?.subscribe(() => {
        this.callbacks.syncAuthQuotaState();
        if (this.ctx.isLoggedIn) {
          void this.callbacks.refreshRequestQuotaState();
        }
        void this.tryInitializeLoggedInSessionFromAuthRefresh();
      }) ?? authProvider?.authSnapshot$?.subscribe(() => {
        this.callbacks.syncAuthQuotaState();
        if (this.ctx.isLoggedIn) {
          void this.callbacks.refreshRequestQuotaState();
        }
        void this.tryInitializeLoggedInSessionFromAuthRefresh();
      }) ?? null;

      void this.tryInitializeLoggedInSession();
    });

    this.aiWritingSubscription = AilyHost.get().blockly.aiWriting$.subscribe(this.callbacks.showAiWritingNotice);
    this.aiWaitingSubscription = AilyHost.get().blockly.aiWaiting$.subscribe(this.callbacks.showAiWritingNotice);

    this.blockSelectionSubscription = combineLatest([
      AilyHost.get().blockly.selectedBlockIdsSubject,
      AilyHost.get().blockly.blockCodeMapSubject,
    ]).subscribe((results: any[]) => {
      this.ctx.resourceManager.updateBlockContexts(
        results[0] || [],
        () => AilyHost.get().blockly.getSelectedBlockContextLabels(),
      );
      this.ctx.triggerSyncDetectChanges();
    });

    this.taskActionHandler = (event: Event) => {
      this.callbacks.handleTaskAction(event as ChatTaskActionEvent);
    };
    document.addEventListener('aily-task-action', this.taskActionHandler);

    this.projectPathSubscription = AilyHost.get().project.currentProjectPath$.pipe(
      distinctUntilChanged(),
      skip(1),
    ).subscribe((newPath: string) => {
      const rootPath = AilyHost.get().project.projectRootPath;
      this.ctx.prjPath = newPath === rootPath ? '' : newPath;
      this.ctx.prjRootPath = rootPath;

      if (newPath && newPath !== rootPath) {
        this.ctx.chatService.currentSessionPath = newPath;
      }

      if (newPath && newPath !== rootPath) {
        this.ctx.chatHistoryService.reloadProjectIndex(newPath);
        const adopted = this.ctx.chatHistoryService.adoptOrphanSessions(newPath, rootPath);
        if (adopted > 0) {
          console.log(`[ChatEngine] 项目切换，自动领养 ${adopted} 个孤儿会话到: ${newPath}`);
        }
      }

      this.ctx.session.requestSessionListRefresh({
        reason: 'project',
        scope: 'full',
        priority: 'normal',
      });
      if (newPath && newPath !== rootPath) {
        this.ctx.absAutoSyncService.initialize(newPath);
      }
      this.callbacks.refreshSessionProviderOptionsSources();
    });

    this.loginStatusSubscription = authProvider?.isLoggedIn$?.subscribe(async isLoggedIn => {
      this.ctx.isLoggedIn = isLoggedIn;

      if (isLoggedIn) {
        await this.tryInitializeLoggedInSession();
      }

      if (isLoggedIn) {
        this.callbacks.syncAuthQuotaState();
        await this.callbacks.refreshRequestQuotaState();
        return;
      }

      try {
        await this.ctx.session.stopAndCloseSession();
      } catch (error) {
        console.warn('清理会话时出错:', error);
      }
      this.ctx.hasInitializedForThisLogin = false;
      this.ctx.mcpInitialized = false;
      this.ctx.isWaiting = false;
      this.ctx.isCompleted = false;
      this.ctx.isSessionStarting = false;
      this.ctx.chatService.currentSessionId = '';
      this.ctx.chatService.currentSessionType = DEFAULT_CHAT_SESSION_TYPE;
      this.ctx.chatService.currentSessionPath = '';
      this.callbacks.clearAuthQuotaState();
      this.callbacks.clearRequestQuotaState();
      this.viewWriteBridge.clearChatView();
      this.ctx.toolCallStates = {};
      if (this.ctx.messageSubscription) {
        this.ctx.messageSubscription.unsubscribe();
        this.ctx.messageSubscription = null;
      }
    }) ?? null;

    this.configChangedSubscription = this.ctx.ailyChatConfigService.configChanged$.subscribe(async () => {
      const hasConversationHistory = this.hasConversationHistory();
      if (!hasConversationHistory && this.ctx.sessionId && this.isReadyForLoggedInSessionWork()) {
        try {
          await this.ctx.session.stopAndCloseSession(true);
          await this.ctx.session.startSession();
          this.ctx.message.success('配置已更新并生效');
        } catch (error) {
          console.warn('重新启动会话失败:', error);
          this.ctx.message.warning('配置更新失败，请尝试新建对话');
        }
        return;
      }

      if (hasConversationHistory) {
        this.ctx.message.info('配置已保存；工具选择会在后续请求中生效，其余配置可能需要新建对话');
      }
    });

    this.hostConfigReloadSubscription = this.ctx.configService.configReloaded$.subscribe(async () => {
      const nextApiServer = this.normalizeApiServer(this.ctx.configService.getCurrentApiServer());
      if (!nextApiServer || nextApiServer === this.lastKnownApiServer) {
        return;
      }

      this.lastKnownApiServer = nextApiServer;

      if (!this.isReadyForLoggedInSessionWork()) {
        return;
      }

      try {
        await this.ctx.session.stopAndCloseSession(true);
        await this.ctx.session.startSession();
        this.ctx.message.success('服务节点已切换，后续请求将使用新的 endpoint');
      } catch (error) {
        console.warn('服务节点切换后重建会话失败:', error);
        this.ctx.message.warning('服务节点切换后重建会话失败，请尝试新建对话');
      }
    });
  }

  cleanup(): void {
    this.active = false;
    if (this.ctx.messageSubscription) { this.ctx.messageSubscription.unsubscribe(); this.ctx.messageSubscription = null; }
    if (this.textMessageSubscription) { this.textMessageSubscription.unsubscribe(); this.textMessageSubscription = null; }
    if (this.loginStatusSubscription) { this.loginStatusSubscription.unsubscribe(); this.loginStatusSubscription = null; }
    if (this.authChangeSubscription) { this.authChangeSubscription.unsubscribe(); this.authChangeSubscription = null; }
    if (this.userInfoSubscription) { this.userInfoSubscription.unsubscribe(); this.userInfoSubscription = null; }
    if (this.aiWritingSubscription) { this.aiWritingSubscription.unsubscribe(); this.aiWritingSubscription = null; }
    if (this.aiWaitingSubscription) { this.aiWaitingSubscription.unsubscribe(); this.aiWaitingSubscription = null; }
    if (this.projectPathSubscription) { this.projectPathSubscription.unsubscribe(); this.projectPathSubscription = null; }
    if (this.configChangedSubscription) { this.configChangedSubscription.unsubscribe(); this.configChangedSubscription = null; }
    if (this.hostConfigReloadSubscription) { this.hostConfigReloadSubscription.unsubscribe(); this.hostConfigReloadSubscription = null; }
    if (this.blockSelectionSubscription) { this.blockSelectionSubscription.unsubscribe(); this.blockSelectionSubscription = null; }
    if (this.uiChatMessageSubscription) { this.uiChatMessageSubscription.unsubscribe(); this.uiChatMessageSubscription = null; }
    if (this.taskActionHandler) { document.removeEventListener('aily-task-action', this.taskActionHandler); this.taskActionHandler = null; }
    this.ctx.isSessionStarting = false;
    this.ctx.mcpInitialized = false;
    this.ctx.hasInitializedForThisLogin = false;
  }

  private hasConversationHistory(): boolean {
    return hasHostResponseConversationContent(
      this.ctx.hostResponseProjection ?? null,
    );
  }

  private normalizeApiServer(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim().replace(/\/$/, '') : '';
  }
}