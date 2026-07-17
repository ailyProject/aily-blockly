import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateService } from '@ngx-translate/core';
import { combineLatest } from 'rxjs';

import type { IMenuItem } from '../../../configs/menu.config';
import { AbsAutoSyncService } from './abs-auto-sync.service';
import { AilyHost } from '../core/host';
import { AuthService } from '../../../services/auth.service';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { BuilderService } from '../../../services/builder.service';
import { ChatEngineService } from './chat-engine.service';
import { ChatRuntimeInteractionHostService } from './chat-runtime-interaction-host.service';
import { ChatSessionItemsService } from './chat-session-items.service';
import { ChatService, type ModelConfig } from './chat.service';
import { ChatViewService } from './chat-view.service';
import { AilyChatConfigService, type ModelConfigOption, type WorkspaceSecurityOption } from './aily-chat-config.service';
import { McpService } from './mcp.service';
import { CmdService } from '../../../services/cmd.service';
import { ConfigService } from '../../../services/config.service';
import { ConnectionGraphService } from '../../../services/connection-graph.service';
import { createElectronHostAdapter } from '../adapters/electron-host-adapter';
import { DEFAULT_AILY_USAGE_GUIDE_URL } from '../helpers/chat-surface-shell-coordinator';
import { CrossPlatformCmdService } from '../../../services/cross-platform-cmd.service';
import { ElectronService } from '../../../services/electron.service';
import { NoticeService } from '../../../services/notice.service';
import { OnboardingService } from '../../../services/onboarding.service';
import { PlatformService } from '../../../services/platform.service';
import { ProjectService } from '../../../services/project.service';
import { ThemeService } from '../../../services/theme.service';
import { TodoUpdateService } from './todoUpdate.service';
import { UiService } from '../../../services/ui.service';
import { MAIN_AGENT_TYPE, SCHEMATIC_AGENT_TYPE } from '../core/agent-identifiers';
import { getRuntimeToolSettingsCatalog } from '../helpers/lex-agent-bootstrap';
import { getMarkdownContent } from '../core/markdown-content-store';
import { getThinkContent } from '../core/think-content-store';
import { findChatMessageHandleByTurnId } from '../helpers/chat-message-handle';
import { CHAT_PICKER_CONFIGURE_CUSTOM_AGENTS_ACTION_ID } from '../helpers/chat-configure-custom-agents-action';
import type { ResourceItem } from '../core/chat-types';
import {
  buildToolActivityShellPresentation,
  buildToolInvocationSummary,
  buildToolTimingSummary,
} from '../components/x-dialog/chat-activity-group-projection';

interface ChildChatRequest {
  readonly protocolVersion?: number;
  readonly id?: string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly source?: string;
}

@Injectable()
export class AilyChatChildProtocolService {
  private readonly uiService = inject(UiService);
  private readonly engine = inject(ChatEngineService);
  private readonly chatService = inject(ChatService);
  private readonly chatSessionItemsService = inject(ChatSessionItemsService);
  private readonly runtimeInteractionHost = inject(ChatRuntimeInteractionHostService);
  private readonly viewState = inject(ChatViewService);
  private readonly chatConfig = inject(AilyChatConfigService);
  private readonly mcpService = inject(McpService);
  private readonly todoService = inject(TodoUpdateService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly projectService = inject(ProjectService);
  private readonly configService = inject(ConfigService);
  private readonly authService = inject(AuthService);
  private readonly builderService = inject(BuilderService);
  private readonly platformService = inject(PlatformService);
  private readonly noticeService = inject(NoticeService);
  private readonly blocklyService = inject(BlocklyService);
  private readonly connectionGraphService = inject(ConnectionGraphService);
  private readonly cmdService = inject(CmdService);
  private readonly crossPlatformCmdService = inject(CrossPlatformCmdService);
  private readonly absAutoSyncService = inject(AbsAutoSyncService);
  private readonly electronService = inject(ElectronService);
  private readonly onboardingService = inject(OnboardingService);
  private readonly themeService = inject(ThemeService);

  private initialized = false;
  private blockContextSyncInitialized = false;
  private activeClientSource = '';
  private lastSnapshotSignature = '';
  private lastStreamTurnKey = '';
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly turnContexts = new Map<string, any>();
  private sessionOperation: Promise<void> = Promise.resolve();

  constructor() {
    this.uiService.actionSubject
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((action: any) => {
        if (action?.action !== 'signal' || action?.type !== 'tool' || action?.data !== 'aily-chat:request') {
          return;
        }
        const request = action.payload as ChildChatRequest;
        if (!String(request?.source || '').startsWith('child-tool:aily-chat')) {
          return;
        }
        void this.handleRequest(request);
      });

    this.viewState.sessionViewModelChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.emitSnapshot();
        if (this.shouldContinueSnapshotPump()) {
          this.ensureSnapshotPump();
        }
      });
    this.todoService.todoUpdated$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.emitSnapshot());

    this.destroyRef.onDestroy(() => {
      if (this.snapshotTimer) {
        clearTimeout(this.snapshotTimer);
        this.snapshotTimer = null;
      }
    });
  }

  private async handleRequest(request: ChildChatRequest): Promise<void> {
    const id = String(request.id || '');
    const method = String(request.method || '');
    this.activeClientSource = String(request.source || '');

    try {
      this.ensureInitialized();
      this.ensureSnapshotPump();
      const result = await this.runMethod(method, request.params ?? {});
      this.respond(id, true, result);
      this.emitSnapshot(true);
    } catch (error) {
      this.respond(id, false, undefined, error instanceof Error ? error.message : String(error || 'Unknown error'));
    }
  }

  private ensureInitialized(): void {
    if (this.initialized) {
      return;
    }

    if (!AilyHost.isInitialized()) {
      AilyHost.init(createElectronHostAdapter({
        projectService: this.projectService,
        configService: this.configService,
        authService: this.authService,
        builderService: this.builderService,
        platformService: this.platformService,
        noticeService: this.noticeService,
        blocklyService: this.blocklyService,
        connectionGraphService: this.connectionGraphService,
        cmdService: this.cmdService,
        crossPlatformCmdService: this.crossPlatformCmdService,
        absAutoSyncService: this.absAutoSyncService,
        electronService: this.electronService,
        uiService: this.uiService,
        onboardingService: this.onboardingService,
      }));
    }

    this.engine.init(null);
    this.initializeBlockContextSync();
    this.initialized = true;
  }

  private initializeBlockContextSync(): void {
    if (this.blockContextSyncInitialized) {
      return;
    }
    this.blockContextSyncInitialized = true;

    combineLatest([
      this.blocklyService.selectedBlockIdsSubject,
      this.blocklyService.blockCodeMapSubject,
    ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([blockIds]) => {
        this.engine.resourceManager.updateBlockContexts(
          blockIds || [],
          () => this.blocklyService.getSelectedBlockContextLabels(),
        );
        this.emitSnapshot(true);
      });
  }

  private async runMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'bootstrap':
        return this.buildSnapshot();
      case 'session.create':
        return this.runSessionOperation(async () => {
          await this.engine.newChat();
          const sessionId = await this.engine.ensureSessionReadyForSubmit() ?? this.engine.sessionId;
          if (!sessionId) {
            throw new Error('无法创建新会话');
          }
          return { sessionId };
        });
      case 'session.select': {
        const targetId = String(params['sessionId'] || '');
        // Session switch must not wait on runSessionOperation: turn.send can run for
        // minutes in the background and would block re-entering a suspended session.
        const switched = await this.engine.switchToSession(targetId);
        return { switched };
      }
      case 'session.action':
        return this.runSessionOperation(async () => this.handleSessionAction(params));
      case 'surface.back':
        await this.engine.returnToEntryInventory({ sessionId: this.engine.sessionId });
        return { ok: true };
      case 'surface.toggleSettings':
        this.viewState.toggleSettings();
        return { showSettings: this.viewState.showSettings };
      case 'surface.openUrl':
        this.electronService.openUrl(String(params['url'] || DEFAULT_AILY_USAGE_GUIDE_URL));
        return { ok: true };
      case 'turn.send': {
        const text = String(params['text'] || '').trim();
        if (!text) {
          return { ok: false };
        }
        const submittedResources = this.deserializeSubmittedResources(params['resources']);
        return this.runSessionOperation(async () => {
          const requestedSessionId = typeof params['sessionId'] === 'string'
            ? params['sessionId'].trim()
            : '';
          const knownSessionIds = new Set(this.viewState.sessionListItems.map(item => item.sessionId));
          const sessionId = requestedSessionId && knownSessionIds.has(requestedSessionId)
            ? requestedSessionId
            : await this.engine.ensureSessionReadyForSubmit() ?? this.engine.sessionId;
          if (!sessionId) {
            throw new Error('会话尚未准备完成，请重试');
          }
          this.engine.resourceManager.items = submittedResources;
          await this.engine.submitUserText(text, { clearInput: true, sessionId });
          return { ok: true };
        }, 'turn.send');
      }
      case 'turn.stop':
        return { stopped: this.engine.stop(String(params['sessionId'] || this.engine.sessionId || '')) };
      case 'turn.regenerate':
        await this.engine.sessionBoundary.regenerateTurn(this.turnContexts.get(String(params['turnId'] || '')));
        return { ok: true };
      case 'turn.restore':
        await this.engine.sessionBoundary.restoreCheckpoint(this.requireTurnContext(params['turnId']));
        return { ok: true };
      case 'turn.fork':
        await this.engine.sessionBoundary.forkSession(this.requireTurnContext(params['turnId']));
        return { ok: true };
      case 'turn.feedback':
        this.engine.handleTaskActionDetail({
          action: 'voteResponse',
          target: this.requireTurnContext(params['turnId']),
          vote: params['vote'] === 'helpful' ? 1 : 0,
        });
        return { ok: true };
      case 'turn.edit':
        await this.engine.editAndResendFromTurn(
          this.requireTurnContext(params['turnId']),
          String(params['text'] || ''),
          [],
        );
        return { ok: true };
      case 'resource.addFile':
        await this.engine.resourceManager.addFile();
        return { ok: true };
      case 'resource.addFolder':
        await this.engine.resourceManager.addFolder();
        return { ok: true };
      case 'resource.remove':
        this.engine.resourceManager.removeResource(Number(params['index']));
        return { ok: true };
      case 'todo.toggle':
        return this.toggleTodo(String(params['id'] || ''));
      case 'todo.clear':
        this.todoService.updateTodoData(this.engine.sessionId, []);
        return { ok: true };
      case 'settings.update':
        await this.updateSettings(params);
        return { ok: true };
      case 'menu.select':
        await this.selectMenuItem(params);
        return { ok: true };
      case 'settings.save':
        return { ok: this.saveSettings(params) };
      case 'interaction.respond':
        return this.handleInteractionRespond(params);
      case 'confirmation.navigate':
        this.runtimeInteractionHost.navigateConfirmation(
          this.engine.sessionId,
          Number(params['delta'] || 0),
        );
        return { ok: true };
      case 'question.respond':
        return this.handleQuestionRespond(params);
      case 'plan.respond':
        return this.handlePlanRespond(params);
      case 'layout.setViewportWidth': {
        const width = Number(params['width']);
        this.viewState.syncSessionViewerLayout({
          hasConversationContent: this.viewState.hasConversationContent,
          isAuthenticated: this.authService.isLoggedIn,
        });
        this.viewState.setSessionViewportWidth(Number.isFinite(width) && width >= 0 ? width : 0);
        return { ok: true };
      }
      case 'layout.setSessionSidebarWidth': {
        const width = Number(params['width']);
        if (!Number.isFinite(width)) {
          return { ok: false };
        }
        this.viewState.setSessionSidebarWidth(width, {
          persist: params['persist'] === true,
        });
        return { ok: true };
      }
      default:
        throw new Error(`Unsupported Aily Chat child protocol method: ${method}`);
    }
  }

  private deserializeSubmittedResources(value: unknown): ResourceItem[] {
    if (!Array.isArray(value)) {
      return this.engine.resourceManager.items.map(item => ({ ...item }));
    }

    const resources: ResourceItem[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const item = raw as Record<string, unknown>;
      const type = item['type'];
      const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
      if (
        (type !== 'file' && type !== 'folder' && type !== 'url' && type !== 'block')
        || !name
      ) {
        continue;
      }

      resources.push({
        type,
        name,
        ...(typeof item['path'] === 'string' ? { path: item['path'] } : {}),
        ...(typeof item['url'] === 'string' ? { url: item['url'] } : {}),
        ...(typeof item['blockId'] === 'string' ? { blockId: item['blockId'] } : {}),
        ...(typeof item['blockContext'] === 'string' ? { blockContext: item['blockContext'] } : {}),
      });
    }
    return resources;
  }

  private async updateSettings(params: Record<string, unknown>): Promise<void> {
    const permissionMode = params['permissionMode'];
    if (permissionMode === 'full' || permissionMode === 'default' || permissionMode === 'auto_review') {
      this.engine.applyComposerPermissionPreset(
        permissionMode === 'full'
          ? 'permission-full-access'
          : permissionMode === 'auto_review'
            ? 'permission-auto-review'
            : 'permission-default',
        this.engine.sessionId,
      );
    }

    const modeId = typeof params['modeId'] === 'string' ? params['modeId'] : '';
    if (modeId) {
      const item = this.viewState.modeMenuItems.find(menuItem => (
        String(menuItem.data?.modeId || menuItem.data?.mode || menuItem.action || '') === modeId
      ));
      const customModeId = typeof item?.data?.modeId === 'string' ? item.data.modeId.trim() : '';
      const customAgentTarget = typeof item?.data?.customAgentTarget === 'string'
        ? item.data.customAgentTarget.trim()
        : '';
      if (customModeId && item?.data?.mode === 'agent') {
        await this.engine.switchToCustomAgent({ modeId: customModeId });
      } else if (customAgentTarget) {
        await this.engine.switchToCustomAgent({ customAgentTarget });
      } else {
        await this.engine.switchToMode(String(item?.data?.mode || modeId));
      }
    }

    const modelId = typeof params['modelId'] === 'string' ? params['modelId'] : '';
    if (modelId) {
      const item = this.viewState.modelMenuItems.find(menuItem => this.menuItemId(menuItem) === modelId);
      const model = item?.data as ModelConfig | undefined;
      if (model) {
        await this.engine.switchToModel(model);
      }
    }
  }

  private async selectMenuItem(params: Record<string, unknown>): Promise<void> {
    const kind = String(params['kind'] || '');
    const path = Array.isArray(params['path'])
      ? params['path'].map(value => Number(value)).filter(value => Number.isInteger(value) && value >= 0)
      : [];
    const source = kind === 'mode'
      ? this.viewState.modeMenuItems
      : kind === 'model'
        ? this.viewState.modelMenuItems
        : [];
    const item = this.resolveMenuItemPath(source, path);
    if (!item || item.disabled || item.sep) {
      return;
    }

    if (kind === 'mode') {
      if (item.action === CHAT_PICKER_CONFIGURE_CUSTOM_AGENTS_ACTION_ID) {
        this.viewState.openSettings();
        return;
      }

      const modeId = typeof item.data?.modeId === 'string' ? item.data.modeId.trim() : '';
      const customAgentTarget = typeof item.data?.customAgentTarget === 'string'
        ? item.data.customAgentTarget.trim()
        : '';
      if (modeId && item.data?.mode === 'agent') {
        await this.engine.switchToCustomAgent({ modeId });
      } else if (customAgentTarget) {
        await this.engine.switchToCustomAgent({ customAgentTarget });
      } else {
        const mode = String(item.data?.mode || modeId || '');
        if (mode) {
          await this.engine.switchToMode(mode);
        }
      }
      return;
    }

    if (kind === 'model') {
      const model = item.data?.model as ModelConfig | undefined;
      if (!model?.model) {
        return;
      }
      const modelConfiguration = item.data?.modelConfiguration as { key?: string; value?: unknown } | undefined;
      const configurationKey = typeof modelConfiguration?.key === 'string'
        ? modelConfiguration.key.trim()
        : '';
      if (configurationKey) {
        await this.engine.switchToModelConfiguration(model, {
          key: configurationKey,
          value: modelConfiguration?.value,
        });
      } else {
        await this.engine.switchToModel(model);
      }
    }
  }

  private async handleSessionAction(params: Record<string, unknown>): Promise<{ ok: boolean }> {
    const sessionId = String(params['sessionId'] || '').trim();
    const action = String(params['action'] || '').trim();
    if (!sessionId || !action) {
      throw new Error('Invalid session action');
    }

    const controller = this.chatSessionItemsService.sessionItemController;
    const currentSessionId = this.engine.sessionId;

    switch (action) {
      case 'pin-session':
        controller.setSessionPinned(sessionId, true);
        break;
      case 'unpin-session':
        controller.setSessionPinned(sessionId, false);
        break;
      case 'mark-session-read':
        controller.setSessionRead(sessionId, true);
        break;
      case 'mark-session-unread':
        controller.setSessionRead(sessionId, false);
        break;
      case 'archive-session':
        controller.setSessionArchived(sessionId, true);
        break;
      case 'unarchive-session':
        controller.setSessionArchived(sessionId, false);
        break;
      case 'rename-session': {
        const title = String(params['title'] || '').trim();
        if (!title) {
          throw new Error('Title required for rename');
        }
        controller.renameChatSessionItem(sessionId, title);
        if (sessionId === currentSessionId) {
          if (typeof this.chatService.setCurrentSessionTitle === 'function') {
            this.chatService.setCurrentSessionTitle({ text: title, source: 'user' });
          } else {
            this.chatService.currentSessionTitle = title;
          }
        }
        break;
      }
      case 'delete-session': {
        this.engine.deleteSessionAction(sessionId);
        if (sessionId === currentSessionId) {
          const remaining = this.chatSessionItemsService.sessionListItems[0];
          if (remaining?.sessionId) {
            await this.engine.switchToSession(remaining.sessionId);
          } else {
            await this.engine.returnToEntryInventory({ sessionId });
          }
        }
        break;
      }
      default:
        throw new Error(`Unsupported session action: ${action}`);
    }

    await this.engine.refreshHistoryList();
    return { ok: true };
  }

  private handleInteractionRespond(params: Record<string, unknown>): { ok: boolean } {
    const sessionId = this.engine.sessionId;
    const sideEffectOnly = params['sideEffectOnly'] === true;
    const actionId = typeof params['actionId'] === 'string' ? params['actionId'].trim() : '';
    const toolCallId = typeof params['toolCallId'] === 'string' ? params['toolCallId'].trim() : '';
    const confirmationId = typeof params['confirmationId'] === 'string'
      ? params['confirmationId'].trim()
      : (typeof params['partId'] === 'string' ? params['partId'].trim() : '');
    const approved = params['approved'] === true;
    const scope = typeof params['scope'] === 'string' ? params['scope'] : undefined;
    const reason = typeof params['reason'] === 'string' ? params['reason'] : undefined;

    if (sideEffectOnly && actionId) {
      const active = this.runtimeInteractionHost.getActiveConfirmation(sessionId);
      if (active) {
        this.runtimeInteractionHost.triggerConfirmationAction(sessionId, active.id, actionId);
      }
      return { ok: true };
    }

    const decision = {
      approved,
      scope: scope as 'once' | 'session' | 'workspace' | 'session-all-terminal' | 'session-safe' | undefined,
      actionId: actionId || undefined,
      reason,
    };

    if (toolCallId) {
      this.runtimeInteractionHost.resolveToolApproval(sessionId, toolCallId, decision);
      return { ok: true };
    }

    const active = this.runtimeInteractionHost.getActiveConfirmation(sessionId);
    const targetId = confirmationId || active?.id || '';
    if (targetId) {
      this.runtimeInteractionHost.resolveConfirmation(sessionId, targetId, decision);
      return { ok: true };
    }

    void this.engine.submitInteractionActionRequest(
      String(params['value'] || params['actionId'] || ''),
      { kind: 'continue' },
      undefined,
      sessionId,
    );
    return { ok: true };
  }

  private handleQuestionRespond(params: Record<string, unknown>): { ok: boolean } {
    const sessionId = this.engine.sessionId;
    const widget = this.runtimeInteractionHost.getQuestionWidget(sessionId);
    if (!widget) {
      return { ok: false };
    }

    if (params['skipped'] === true) {
      this.runtimeInteractionHost.skipQuestion(sessionId);
      return { ok: true };
    }

    const answersInput = Array.isArray(params['answers']) ? params['answers'] as any[] : [];
    const answers: Record<string, { selected: string[]; freeText: string | null; skipped: boolean }> = {};
    for (const item of answersInput) {
      const question = String(item?.question || '').trim();
      if (!question) {
        continue;
      }
      const freeText = typeof item?.freeText === 'string' && item.freeText.trim().length > 0
        ? item.freeText
        : null;
      answers[question] = {
        selected: Array.isArray(item?.selected) ? item.selected.map((value: unknown) => String(value)) : [],
        freeText,
        skipped: false,
      };
    }

    this.runtimeInteractionHost.completeQuestion(sessionId, { answers });
    return { ok: true };
  }

  private handlePlanRespond(params: Record<string, unknown>): { ok: boolean } {
    const sessionId = this.engine.sessionId;
    const review = this.runtimeInteractionHost.getActivePlanReview(sessionId);
    if (!review) {
      return { ok: false };
    }

    const approved = params['approved'] !== false;
    const actionId = typeof params['actionId'] === 'string' ? params['actionId'] : undefined;
    const feedback = typeof params['feedback'] === 'string' && params['feedback'].trim().length > 0
      ? params['feedback']
      : undefined;

    this.runtimeInteractionHost.resolvePlanReview(sessionId, review.id, { approved, actionId, feedback });
    return { ok: true };
  }

  private serializeRuntimeQuestion(sessionId: string): Record<string, unknown> | null {
    const widget = this.runtimeInteractionHost.getQuestionWidget(sessionId);
    if (!widget) {
      return null;
    }
    return {
      partId: widget.partId,
      questions: widget.data.questions.map(question => ({
        question: question.question,
        options: Array.isArray(question.options)
          ? question.options.map(option => ({
              label: option.label,
              description: option.description,
              recommended: option.recommended === true,
            }))
          : [],
        allowFreeform: question.allow_freeform === true,
        multiSelect: question.multi_select === true,
      })),
    };
  }

  private serializeRuntimePlanReview(sessionId: string): Record<string, unknown> | null {
    const review = this.runtimeInteractionHost.getActivePlanReview(sessionId);
    if (!review) {
      return null;
    }
    return {
      id: review.id,
      title: review.data.title,
      content: review.data.content,
      planUri: review.data.planUri,
      canProvideFeedback: review.data.canProvideFeedback === true,
      actions: review.data.actions.map(action => ({
        id: action.id,
        label: action.label,
        description: action.description,
        default: action.default === true,
      })),
    };
  }

  private toggleTodo(id: string): { ok: boolean } {
    const sessionId = this.engine.sessionId;
    const todos = this.todoService.getTodosForSession(sessionId);
    const next = todos.map(todo => String(todo.id) === id
      ? {
          ...todo,
          status: todo.status === 'completed' ? 'not-started' as const : 'completed' as const,
          updatedAt: Date.now(),
        }
      : todo);
    this.todoService.updateTodoData(sessionId, next);
    return { ok: true };
  }

  private isChildSnapshotSessionAligned(): boolean {
    const viewSessionId = this.viewState.currentViewSessionId;
    const engineSessionId = typeof this.engine.sessionId === 'string' ? this.engine.sessionId.trim() : '';
    if (!viewSessionId && !engineSessionId) {
      return true;
    }
    return viewSessionId === engineSessionId;
  }

  private buildSnapshot(): Record<string, unknown> {
    this.viewState.syncSessionViewerLayout({
      hasConversationContent: this.viewState.hasConversationContent,
      isAuthenticated: this.authService.isLoggedIn,
    });
    const viewSessionId = this.viewState.currentViewSessionId;
    const engineSessionId = typeof this.engine.sessionId === 'string' ? this.engine.sessionId.trim() : '';
    const sessionId = engineSessionId || viewSessionId || '';
    const sessionItems = this.viewState.sessionListItems;
    const modelOptions = this.serializeMenuItems(this.viewState.modelMenuItems);
    const modeOptions = this.serializeMenuItems(this.viewState.modeMenuItems);
    const permissionMode = this.engine.currentSessionPermissionMode === 'bypassPermissions' ? 'full' : 'default';
    const permissionPreset = permissionMode === 'full'
      ? 'full'
      : this.engine.currentSessionApprovalsReviewer === 'auto_review'
        ? 'auto_review'
        : 'default';
    const contextUsage = this.engine.contextUsageSnapshot;

    this.turnContexts.clear();
    const pendingConfirmations = this.serializeRuntimeConfirmations(sessionId);
    const runState = this.resolveRunState(sessionId, sessionItems);
    const dialogItems = this.engine.readLiveDialogItemsForSnapshot();
    const turns = dialogItems.map((item, index) => this.serializeDialogItem(
      item,
      runState === 'running' && index === dialogItems.length - 1,
      runState,
    ));
    return {
      sessions: sessionItems.map(item => ({
        id: item.sessionId,
        title: item.title,
        createdAt: item.timing?.created ?? 0,
        updatedAt: item.timing?.updated ?? item.timing?.created ?? 0,
        unread: item.markedUnread === true || item.read === false,
        current: item.current,
        status: item.status,
        detail: [item.description, item.projectPath].filter(Boolean),
        pinned: item.pinned,
        archived: item.archived,
        actions: Array.isArray(item.actions)
          ? item.actions.map(action => ({
              icon: action.icon,
              action: action.action,
              title: action.title,
              ...(action.active ? { active: true } : {}),
            }))
          : [],
      })),
      activeSessionId: sessionId || null,
      turns,
      runState,
      models: modelOptions
        .filter(item => item.type !== 'section' && item.id && item.label)
        .map(item => ({ id: item.id, label: item.label })),
      activeModelId: this.engine.currentModel?.presetId
        || this.engine.currentModel?.model
        || this.engine.currentModelName
        || modelOptions.find(item => item.active)?.id
        || '',
      permissionMode,
      permissionPreset,
      paneSurface: this.viewState.currentPaneSurface,
      sessionListMode: this.viewState.sessionListDisplayMode,
      sessionSidebarWidth: this.viewState.sessionSidebarWidth,
      sessionSidebarResizeMinWidth: this.viewState.sessionSidebarResizeMinWidth,
      sessionSidebarMaxWidth: this.viewState.sessionSidebarMaxWidth,
      title: this.viewState.currentPaneTitle,
      inputValue: this.engine.inputValue,
      resources: this.engine.resourceManager.items.map(item => ({
        type: item.type,
        name: item.name,
        path: item.path,
        blockId: item.blockId,
        blockContext: item.blockContext,
      })),
      todos: this.todoService.getTodosForSession(sessionId).map(todo => ({
        id: String(todo.id),
        content: todo.content,
        status: todo.status,
      })),
      notices: [],
      modeId: this.engine.currentMode,
      modeLabel: this.resolveModeLabel(),
      modeOptions,
      modelOptions,
      permissionLabel: permissionMode === 'full'
        ? '完全访问权限'
        : this.engine.currentSessionApprovalsReviewer === 'auto_review' ? '自动审查' : '默认权限',
      contextUsage: contextUsage ? {
        percentage: contextUsage.percentage,
        label: `${Math.round(contextUsage.percentage)}%`,
        estimated: contextUsage.source === 'estimate',
        severity: contextUsage.percentage >= 90 ? 'error' : contextUsage.percentage >= 75 ? 'warning' : 'normal',
      } : null,
      interactionBudget: this.engine.interactionBudgetSnapshot?.badgeText
        ? { label: this.engine.interactionBudgetSnapshot.badgeText, detail: this.engine.interactionBudgetSnapshot.descriptionText }
        : null,
      authQuota: this.engine.authQuotaStateService.getAuthQuotaSnapshot()?.badgeText
        ? {
            label: this.engine.authQuotaStateService.getAuthQuotaSnapshot()?.badgeText,
            detail: this.engine.authQuotaStateService.getAuthQuotaSnapshot()?.detailText,
          }
        : null,
      requestQuota: this.engine.requestQuotaSnapshot?.badgeText
        ? { label: this.engine.requestQuotaSnapshot.badgeText, detail: this.engine.requestQuotaSnapshot.detailText }
        : null,
      showSettings: this.viewState.showSettings,
      settings: this.buildSettingsSnapshot(),
      theme: this.themeService.theme(),
      pendingConfirmations,
      activeConfirmationIndex: this.runtimeInteractionHost.getActiveConfirmationIndex(sessionId),
      pendingQuestion: this.serializeRuntimeQuestion(sessionId),
      pendingPlanReview: this.serializeRuntimePlanReview(sessionId),
    };
  }

  private serializeRuntimeConfirmations(sessionId: string): Record<string, unknown>[] {
    return this.runtimeInteractionHost.getConfirmationQueue(sessionId).map(entry => ({
      id: entry.id,
      kind: entry.kind,
      partId: entry.partId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      askId: entry.askId,
      title: entry.data.title,
      subtitle: entry.data.subtitle,
      message: entry.data.message,
      args: this.jsonSafe(entry.data.args),
      actions: Array.isArray(entry.data.actions)
        ? entry.data.actions.map(action => ({
            id: String(action.id || action.scope || ''),
            scope: action.scope,
            label: action.label,
            description: action.description,
            tooltip: action.tooltip,
            disabled: action.disabled === true,
            isSecondary: action.isSecondary === true,
          }))
        : [],
      primaryScope: entry.data.primaryScope,
      primaryLabel: entry.data.primaryLabel,
      rejectLabel: entry.data.rejectLabel,
    }));
  }

  private buildSettingsSnapshot(): Record<string, unknown> {
    const agents = [
      { id: MAIN_AGENT_TYPE, label: '主 Agent', description: '处理用户请求的主要 Agent' },
      { id: SCHEMATIC_AGENT_TYPE, label: '连线 Agent', description: '处理电路连线图相关任务的子 Agent' },
    ];
    const catalog = getRuntimeToolSettingsCatalog({
      ailyChatConfigService: this.chatConfig,
      mcpService: this.mcpService,
    });
    const toolsByAgent = agents.map(agent => {
      const saved = this.chatConfig.getAgentToolsConfig(agent.id);
      const enabled = new Set(saved.enabledTools);
      const disabled = new Set(saved.disabledTools);
      const hasStoredConfig = enabled.size > 0 || disabled.size > 0;
      return {
        ...agent,
        tools: catalog
          .filter(tool => tool.agents.includes(agent.id as typeof MAIN_AGENT_TYPE | typeof SCHEMATIC_AGENT_TYPE))
          .map(tool => ({
            name: tool.name,
            displayName: tool.name
              .split('_')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' '),
            description: tool.description,
            enabled: !hasStoredConfig || enabled.has(tool.name) || !disabled.has(tool.name),
          })),
      };
    });

    const hiddenTargets = new Set(this.chatConfig.hiddenCustomAgentTargets);
    const customAgents = this.chatService.availableResolvedCustomModes
      .filter(mode => !mode?.isBuiltin && mode?.hidden !== true && mode?.enabled !== false)
      .map(mode => {
        const target = String(mode.customAgentTarget || mode.name || '').trim();
        return {
          target,
          label: String(mode.label || target),
          description: mode.description || '',
          visible: !hiddenTargets.has(target),
        };
      })
      .filter(option => option.target);

    return {
      modelPresets: this.chatConfig.getUserVisibleModelPresets().map(preset => ({
        id: preset.id,
        name: preset.name,
        description: preset.description || '',
        enabled: preset.enabled,
        isDefault: preset.id === this.chatConfig.getDefaultModelPresetId(),
        unavailableReason: preset.unavailableReason,
      })),
      customModels: this.chatConfig.models
        .filter(model => model.isCustom)
        .map(model => ({
          model: model.model,
          name: model.name,
          family: model.family,
          speed: model.speed,
          enabled: model.enabled,
          isCustom: true,
          baseUrl: model.baseUrl || '',
          hasApiKey: !!model.apiKey,
        })),
      modelCatalogStatusHint: this.chatConfig.modelCatalogStatusHint || '',
      workspaceOptions: this.chatConfig.getWorkspaceSecurityOptions(),
      agents: toolsByAgent,
      maxRequests: this.chatConfig.maxRequests,
      autoSaveEdits: this.chatConfig.autoSaveEdits,
      sessionViewerOrientation: this.chatConfig.sessionViewerOrientation,
      userInstructionFolders: this.chatConfig.userInstructionFolders,
      projectInstructionFolders: this.chatConfig.projectInstructionFolders,
      userAgentFolders: this.chatConfig.userAgentFolders,
      projectAgentFolders: this.chatConfig.projectAgentFolders,
      useChatSessionCustomizationsForCustomAgents: this.chatConfig.useChatSessionCustomizationsForCustomAgents,
      customAgents,
      terminalAllowList: this.chatConfig.terminalAllowList,
      terminalDenyList: this.chatConfig.terminalDenyList,
      terminalInheritDefaultAllowList: this.chatConfig.terminalInheritDefaultAllowList ?? true,
    };
  }

  private saveSettings(params: Record<string, unknown>): boolean {
    const toStringArray = (value: unknown): string[] => Array.isArray(value)
      ? value.map(item => String(item).trim()).filter(Boolean)
      : [];

    this.chatConfig.maxRequests = Math.max(1, Number(params['maxRequests']) || 200);
    this.chatConfig.autoSaveEdits = params['autoSaveEdits'] === true;
    this.chatConfig.sessionViewerOrientation = params['sessionViewerOrientation'] === 'stacked'
      ? 'stacked'
      : 'sideBySide';
    this.chatConfig.userInstructionFolders = toStringArray(params['userInstructionFolders']);
    this.chatConfig.projectInstructionFolders = toStringArray(params['projectInstructionFolders']);
    this.chatConfig.userAgentFolders = toStringArray(params['userAgentFolders']);
    this.chatConfig.projectAgentFolders = toStringArray(params['projectAgentFolders']);
    this.chatConfig.useChatSessionCustomizationsForCustomAgents =
      params['useChatSessionCustomizationsForCustomAgents'] === true;
    this.chatConfig.terminalAllowList = toStringArray(params['terminalAllowList']);
    this.chatConfig.terminalDenyList = toStringArray(params['terminalDenyList']);
    this.chatConfig.terminalInheritDefaultAllowList = params['terminalInheritDefaultAllowList'] !== false;

    const workspaceOptions = Array.isArray(params['workspaceOptions'])
      ? params['workspaceOptions'].map(option => ({
          name: String((option as any)?.name || ''),
          displayName: String((option as any)?.displayName || ''),
          enabled: (option as any)?.enabled === true,
        })) as WorkspaceSecurityOption[]
      : [];
    this.chatConfig.updateFromWorkspaceOptions(workspaceOptions);

    const agents = Array.isArray(params['agents']) ? params['agents'] : [];
    for (const agent of agents) {
      const id = String((agent as any)?.id || '');
      const tools = Array.isArray((agent as any)?.tools) ? (agent as any).tools : [];
      this.chatConfig.setAgentToolsConfig(id, {
        enabledTools: tools.filter((tool: any) => tool?.enabled === true).map((tool: any) => String(tool.name)),
        disabledTools: tools.filter((tool: any) => tool?.enabled !== true).map((tool: any) => String(tool.name)),
      });
    }

    const existingModels = new Map(
      this.chatConfig.models.filter(model => model.isCustom).map(model => [model.model, model]),
    );
    const customModels = Array.isArray(params['customModels']) ? params['customModels'] : [];
    this.chatConfig.models = customModels
      .map(raw => {
        const model = String((raw as any)?.model || '').trim();
        const name = String((raw as any)?.name || '').trim();
        const baseUrl = String((raw as any)?.baseUrl || '').trim();
        if (!model || !name || !baseUrl) {
          return null;
        }
        const previous = existingModels.get(model);
        const newApiKey = String((raw as any)?.apiKey || '').trim();
        return {
          model,
          name,
          family: 'custom',
          speed: previous?.speed || '1x',
          enabled: (raw as any)?.enabled !== false,
          isCustom: true,
          baseUrl,
          apiKey: newApiKey || previous?.apiKey || '',
        } as ModelConfigOption;
      })
      .filter(Boolean) as ModelConfigOption[];

    const customAgents = Array.isArray(params['customAgents']) ? params['customAgents'] : [];
    const catalogTargets = new Set(customAgents.map(option => String((option as any)?.target || '')).filter(Boolean));
    const hiddenOutsideCatalog = this.chatConfig.hiddenCustomAgentTargets.filter(target => !catalogTargets.has(target));
    this.chatConfig.hiddenCustomAgentTargets = [
      ...hiddenOutsideCatalog,
      ...customAgents
      .filter(option => (option as any)?.visible === false)
      .map(option => String((option as any)?.target || ''))
      .filter(Boolean),
    ];

    return this.chatConfig.save();
  }

  private runSessionOperation<T>(task: () => Promise<T>, label = 'unknown'): Promise<T> {
    const wrapped = async (): Promise<T> => task();
    const operation = this.sessionOperation.then(wrapped, wrapped);
    this.sessionOperation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private resolveRunState(
    sessionId: string,
    sessionItems: ReadonlyArray<{ sessionId: string; status?: string }>,
  ): 'running' | 'waiting' | 'idle' {
    const activeItem = sessionItems.find(item => item.sessionId === sessionId);
    const awaitingUserInput = activeItem?.status === 'needs_input'
      || this.runtimeInteractionHost.getConfirmationQueue(sessionId).length > 0
      || !!this.runtimeInteractionHost.getQuestionWidget(sessionId)
      || !!this.runtimeInteractionHost.getActivePlanReview(sessionId);
    if (awaitingUserInput) {
      return 'waiting';
    }
    const sessionRunning = activeItem?.status === 'in_progress'
      || activeItem?.status === 'running';
    return sessionRunning || this.engine.isWaiting ? 'running' : 'idle';
  }

  private resolveModeLabel(): string {
    const selectedMode = this.engine.selectedMode;
    const customAgentTarget = typeof selectedMode.customAgentTarget === 'string'
      ? selectedMode.customAgentTarget.trim()
      : '';
    if (selectedMode.modeId === 'agent' && customAgentTarget) {
      return customAgentTarget;
    }
    return '';
  }

  private serializeDialogItem(
    item: any,
    isActiveTurn = false,
    runState: 'running' | 'waiting' | 'idle' = 'idle',
  ): Record<string, unknown> {
    const turnResponse = item.turnContext?.turnResponse;
    const useLiveParts = item.role !== 'user' && (isActiveTurn || item.doing === true);
    const rawParts = useLiveParts
      ? this.resolveLiveAssistantParts(item)
      : Array.isArray(turnResponse?.response?.parts)
        ? turnResponse.response.parts
        : Array.isArray(turnResponse?.parts) ? turnResponse.parts : [];
    const userContent = item.turnContext?.displayContent
      ?? item.turnContext?.requestContent
      ?? item.content
      ?? '';
    const parts = item.role === 'user'
      ? [{
          id: `${item.trackId}-content`,
          type: 'markdown',
          content: String(userContent),
        }]
      : rawParts.length
      ? rawParts.map((part: any, index: number) => this.serializePart(part, index, isActiveTurn))
      : [{
          id: `${item.trackId}-content`,
          type: 'markdown',
          content: item.content || '',
        }];

    const turnId = item.turnContext?.turnId || item.trackId;
    if (item.turnContext) {
      this.turnContexts.set(String(turnId), item.turnContext);
      this.turnContexts.set(String(item.trackId), item.turnContext);
    }

    return {
      id: item.trackId,
      turnId,
      role: item.role === 'user' ? 'user' : 'aily',
      createdAt: turnResponse?.createdAt ?? Date.now(),
      parts,
      doing: runState !== 'idle' && (item.doing === true || (isActiveTurn && item.role !== 'user')),
      modelName: item.turnModelName || '',
      modelBillingLabel: item.turnModelBillingLabel,
      canEdit: item.role === 'user'
        && item.turnContext?.requestDisabled !== true
        && !!(item.turnContext?.turnId || item.turnContext?.turnResponse?.turnId)
        && runState === 'idle'
        && item.doing !== true,
      canRestore: item.showCheckpointRestore === true,
      canFork: item.role === 'user' && !!item.turnContext?.turnId,
      feedback: item.responseVote === 1 ? 'helpful' : item.responseVote === 0 ? 'unhelpful' : null,
    };
  }

  private resolveLiveAssistantParts(item: any): any[] {
    const turnId = item.turnContext?.turnId ?? item.turnContext?.turnResponse?.turnId;
    if (!turnId) {
      return [];
    }

    const handle = findChatMessageHandleByTurnId(this.engine.list, String(turnId), { role: 'aily' });
    const liveParts = handle ? this.engine.partStore.getPartsForHandle(handle) : [];
    if (liveParts.length > 0) {
      return liveParts;
    }

    const turnResponse = item.turnContext?.turnResponse;
    if (Array.isArray(turnResponse?.response?.parts)) {
      return turnResponse.response.parts;
    }
    if (Array.isArray(turnResponse?.parts)) {
      return turnResponse.parts;
    }
    return [];
  }

  private serializePart(part: any, index: number, turnActive = false): Record<string, unknown> {
    const type = String(part?.type || 'markdown');
    const toolDisplay = type === 'tool_call'
      ? buildToolInvocationSummary(part)
      : undefined;
    const toolTiming = type === 'tool_call'
      ? buildToolTimingSummary(part)
      : undefined;
    const toolShell = type === 'tool_call'
      ? buildToolActivityShellPresentation({ state: part.state })
      : undefined;
    const content = type === 'markdown' && part?.contentRef
      ? getMarkdownContent(String(part.contentRef))
      : type === 'thinking' && part?.contentRef
        ? getThinkContent(String(part.contentRef))
        : part?.content ?? part?.message ?? part?.output ?? '';
    const isStreamingPart = type === 'thinking'
      ? part?.isComplete !== true
      : type === 'markdown'
        ? turnActive && (part?.isComplete === false || !!part?.contentRef || part?.state === 'doing')
        : type === 'terminal'
          ? part?.isRunning === true
          : type === 'plan'
            ? part?.status === 'streaming'
            : false;
    return {
      id: String(part?.partId || part?.toolCallId || part?.stateId || part?.askId || `${type}-${index}`),
      type,
      content,
      contentLength: part?.contentLength ?? (typeof content === 'string' ? content.length : undefined),
      isComplete: type === 'thinking'
        ? part?.isComplete === true
        : part?.isComplete,
      isRunning: part?.isRunning,
      streaming: isStreamingPart ? true : undefined,
      text: part?.text,
      title: part?.title ?? part?.toolName ?? part?.kind,
      detail: part?.description ?? part?.subtitle ?? part?.stderr,
      state: type === 'tool_call'
        ? (part?.state === 'doing' || part?.state === 'done' || part?.state === 'error' || part?.state === 'warn' || part?.state === 'pending_approval'
          ? part.state
          : 'done')
        : type === 'state'
          ? (part?.state === 'doing' || part?.state === 'done' || part?.state === 'error' || part?.state === 'warn' || part?.state === 'info'
            ? part.state
            : 'done')
          : part?.state ?? (part?.isComplete === false || part?.isRunning === true ? 'doing' : 'done'),
      command: part?.command,
      output: part?.output,
      stderr: part?.stderr,
      exitCode: part?.exitCode,
      progress: part?.progress,
      kind: part?.kind,
      toolName: part?.toolName,
      toolDisplayName: type === 'tool_call' ? this.formatToolDisplayName(part?.toolName) : undefined,
      displayTitle: toolDisplay?.label,
      displaySubtitle: toolDisplay?.subtitle,
      displayMeta: toolTiming?.headerMeta,
      displayStatus: toolShell?.pill || undefined,
      displayTone: toolShell?.pillTone,
      toolCallId: part?.toolCallId,
      resolved: part?.resolved,
      result: part?.result,
      args: this.jsonSafe(part?.args),
      metadata: this.jsonSafe(part?.metadata),
      questions: Array.isArray(part?.questions)
        ? part.questions.map((question: any, questionIndex: number) => ({
            id: String(question.id || questionIndex),
            question: String(question.question || ''),
            options: Array.isArray(question.options) ? question.options : [],
            allowFreeform: question.allow_freeform === true,
          }))
        : undefined,
      actions: Array.isArray(part?.actions)
        ? part.actions.map((action: any) => ({
            id: String(action.id || action.action || action.label || ''),
            label: String(action.label || action.title || action.id || ''),
            primary: action.primary === true,
            danger: action.danger === true,
          }))
        : undefined,
      status: part?.status,
    };
  }

  private formatToolDisplayName(value: unknown): string {
    const name = String(value || '').replace(/^mcp_/, '').trim();
    if (!name) {
      return '';
    }
    return name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map(token => token.charAt(0).toUpperCase() + token.slice(1))
      .join('');
  }

  private jsonSafe(value: unknown): any {
    if (value === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  private requireTurnContext(turnIdValue: unknown): any {
    const turnId = String(turnIdValue || '');
    const context = this.turnContexts.get(turnId);
    if (!context) {
      throw new Error(`Turn context not found: ${turnId}`);
    }
    return context;
  }

  private menuItemId(item: any): string {
    const model = item?.data?.model;
    if (model && typeof model === 'object') {
      return String(model.presetId || model.model || model.id || '');
    }
    return String(item?.data?.modelSelectionId || item?.data?.id || item?.action || item?.data || item?.name || '');
  }

  private serializeMenuItems(items: readonly IMenuItem[], parentPath: readonly number[] = []): any[] {
    const result: any[] = [];
    let separatorBefore = false;

    items.forEach((item, index) => {
      if (item.sep) {
        separatorBefore = result.length > 0;
        return;
      }

      const path = [...parentPath, index];
      const isSection = typeof item.action === 'string' && item.action.startsWith('section-toggle-');
      const option = {
        id: this.menuItemId(item) || path.join('.'),
        label: this.menuItemLabel(item),
        description: item.tooltip || '',
        detail: typeof item.extra?.detail === 'string' ? item.extra.detail : '',
        iconClass: item.icon,
        active: item.check === true || item.current === true,
        disabled: item.disabled === true,
        billingLabel: typeof item.extra?.billingLabel === 'string' ? item.extra.billingLabel : undefined,
        separatorBefore,
        path,
        type: isSection ? 'section' : 'item',
        action: typeof item.action === 'string' ? item.action : undefined,
        children: Array.isArray(item.children) && item.children.length > 0
          ? this.serializeMenuItems(item.children, path)
          : undefined,
      };
      separatorBefore = false;
      if (option.label) {
        result.push(option);
      }
    });

    return result;
  }

  private resolveMenuItemPath(items: readonly IMenuItem[], path: readonly number[]): IMenuItem | undefined {
    let currentItems = items;
    let current: IMenuItem | undefined;
    for (const index of path) {
      current = currentItems[index];
      if (!current) {
        return undefined;
      }
      currentItems = Array.isArray(current.children) ? current.children : [];
    }
    return current;
  }

  private menuItemLabel(item: any): string {
    const raw = String(item?.name || item?.data?.name || item?.action || '');
    const translated = this.translate.instant(raw);
    return typeof translated === 'string' && translated !== raw ? translated : raw;
  }

  private respond(id: string, ok: boolean, result?: unknown, error = ''): void {
    this.uiService.sendToolSignal('aily-chat:response', {
      kind: 'response',
      id,
      ok,
      result,
      error,
      source: 'host:aily-chat-protocol',
    });
  }

  private emitSnapshot(force = false): void {
    if (!this.activeClientSource || !this.initialized) {
      return;
    }
    if (!this.isChildSnapshotSessionAligned()) {
      return;
    }
    const snapshot = this.buildSnapshot();
    this.maybeEmitTurnUpsert(snapshot);
    const signature = JSON.stringify(snapshot);
    if (!force && signature === this.lastSnapshotSignature) {
      return;
    }
    this.lastSnapshotSignature = signature;
    this.uiService.sendToolSignal('aily-chat:event', {
      kind: 'event',
      event: {
        type: 'snapshot',
        payload: snapshot,
      },
      source: 'host:aily-chat-protocol',
    });
  }

  private ensureSnapshotPump(): void {
    if (this.snapshotTimer) {
      return;
    }
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.emitSnapshot();
      if (this.shouldContinueSnapshotPump()) {
        this.ensureSnapshotPump();
      }
    }, 50);
  }

  private shouldContinueSnapshotPump(): boolean {
    const sessionId = this.engine.sessionId || this.viewState.currentViewSessionId || '';
    if (!sessionId) {
      return false;
    }

    const awaitingUserInput = this.runtimeInteractionHost.getConfirmationQueue(sessionId).length > 0
      || !!this.runtimeInteractionHost.getQuestionWidget(sessionId)
      || !!this.runtimeInteractionHost.getActivePlanReview(sessionId);
    if (awaitingUserInput) {
      return false;
    }

    const activeItem = this.viewState.sessionListItems.find(item => item.sessionId === sessionId);
    const status = String(activeItem?.status || '').toLowerCase();
    return status === 'in_progress'
      || status === 'running'
      || (this.engine.isWaiting && status !== 'needs_input');
  }

  private maybeEmitTurnUpsert(snapshot: Record<string, unknown>): void {
    if (snapshot['runState'] !== 'running') {
      this.lastStreamTurnKey = '';
      return;
    }

    const sessionId = String(snapshot['activeSessionId'] || '');
    const turns = snapshot['turns'];
    if (!sessionId || !Array.isArray(turns) || !turns.length) {
      return;
    }

    const lastTurn = turns[turns.length - 1] as Record<string, unknown>;
    if (lastTurn['role'] === 'user') {
      return;
    }

    const parts = Array.isArray(lastTurn['parts']) ? lastTurn['parts'] as Record<string, unknown>[] : [];
    const streamKey = `${lastTurn['id']}:${parts.map(part => `${part['type']}:${typeof part['content'] === 'string' ? part['content'].length : 0}:${part['isComplete']}:${part['streaming']}`).join('|')}`;
    if (streamKey === this.lastStreamTurnKey) {
      return;
    }
    this.lastStreamTurnKey = streamKey;

    this.uiService.sendToolSignal('aily-chat:event', {
      kind: 'event',
      event: {
        type: 'turn.upsert',
        sessionId,
        payload: lastTurn,
      },
      source: 'host:aily-chat-protocol',
    });
  }
}
