import type {
  ChatSessionTitleAction,
  ChatSessionTitleActionContext,
  ChatSessionTitleActionRequest,
  ChatSessionTitleSurfaceModel,
  ChatSessionTitleToolbarId,
} from '../core/chat-session-title-actions';
import {
  CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID,
  CHAT_SESSION_TITLE_TOOLBAR_ID,
} from '../core/chat-action-surfaces';
import type { ChatActionWhenContextMap } from './chat-action-when';
import {
  bindChatActionContributions,
  CHAT_SESSION_TITLE_CONTRIBUTION_OWNER_ID,
  readChatActionContributionsByOwner,
  type BoundChatActionContribution,
} from './chat-action-contributions';
import {
  ChatActionSurfaceRegistry,
} from './chat-action-surface-registry';

export interface ChatSessionTitleActionRegistryContext extends ChatSessionTitleActionContext {
  runGoBackAction(): boolean;
  runPickSessionAction(event: MouseEvent): boolean;
}

type ChatSessionTitleContextKeyMap = ChatActionWhenContextMap & {
  readonly isChatSurface: boolean;
  readonly isBlankSessionSurface: boolean;
  readonly hasSessions: boolean;
  readonly hasConversationContent: boolean;
  readonly hasCurrentSession: boolean;
  readonly sessionListDisplayMode: string;
};

interface ChatSessionTitleRegisteredAction extends BoundChatActionContribution<
  ChatSessionTitleActionRegistryContext,
  ChatSessionTitleToolbarId,
  ChatSessionTitleAction['id'],
  ChatSessionTitleActionRequest,
  ChatSessionTitleAction['presentation']
> {
  isActive?(context: ChatSessionTitleActionRegistryContext): boolean;
}

const CHAT_SESSION_TITLE_REGISTERED_ACTIONS: readonly ChatSessionTitleRegisteredAction[] = bindChatActionContributions([
  ...readChatActionContributionsByOwner<ChatSessionTitleRegisteredAction>(CHAT_SESSION_TITLE_CONTRIBUTION_OWNER_ID),
], [
  {
    id: 'go-back',
    run: context => context.runGoBackAction(),
  },
  {
    id: 'pick-session',
    run: (context, request) => context.runPickSessionAction(request.event),
  },
]);

export class ChatSessionTitleActionRegistry {
  private readonly surfaceRegistry: ChatActionSurfaceRegistry<
    ChatSessionTitleActionRegistryContext,
    ChatSessionTitleToolbarId,
    ChatSessionTitleAction['id'],
    ChatSessionTitleActionRequest,
    ChatSessionTitleRegisteredAction
  >;

  constructor(private readonly getContext: () => ChatSessionTitleActionRegistryContext) {
    this.surfaceRegistry = new ChatActionSurfaceRegistry({
      getContext,
      descriptors: CHAT_SESSION_TITLE_REGISTERED_ACTIONS,
      createContextKeyMap: context => this.createContextKeyMap(context),
    });
  }

  getNavigationActions(): readonly ChatSessionTitleAction[] {
    return this.getToolbarActions(CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID);
  }

  getActions(): readonly ChatSessionTitleAction[] {
    return this.getToolbarActions(CHAT_SESSION_TITLE_TOOLBAR_ID);
  }

  getSurfaceModel(title: string): ChatSessionTitleSurfaceModel {
    const normalizedTitle = typeof title === 'string' ? title : '';
    const navigationActions = this.getToolbarActions(CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID);
    const actions = this.getToolbarActions(CHAT_SESSION_TITLE_TOOLBAR_ID);
    const navigationIconActions = navigationActions.filter(action => action.presentation !== 'title');
    const titleAction = navigationActions.find(action => action.presentation === 'title') ?? null;
    const shouldRender = normalizedTitle.trim().length > 0;

    return {
      shouldRender,
      title: normalizedTitle,
      navigationIconActions,
      titleAction,
      actions,
    };
  }

  getToolbarActions(toolbarId: ChatSessionTitleToolbarId): readonly ChatSessionTitleAction[] {
    return this.getActionsForToolbar(toolbarId);
  }

  runAction(request: ChatSessionTitleActionRequest): boolean {
    return this.surfaceRegistry.runActionById(request.action.id, request);
  }

  private getActionsForToolbar(toolbarId: ChatSessionTitleToolbarId): readonly ChatSessionTitleAction[] {
    return this.surfaceRegistry
      .getSurfaceEntries(toolbarId)
      .filter(entry => entry.enabled)
      .map(({ descriptor, context }) => ({
        id: descriptor.id,
        label: descriptor.label,
        tooltip: descriptor.tooltip ?? descriptor.label,
        iconClass: descriptor.icon,
        presentation: descriptor.presentation,
        active: descriptor.isActive?.(context) === true,
      }));
  }

  private createContextKeyMap(context: ChatSessionTitleActionRegistryContext): ChatSessionTitleContextKeyMap {
    return {
      isChatSurface: context.isChatSurface,
      isBlankSessionSurface: context.isBlankSessionSurface === true,
      hasSessions: context.hasSessions,
      hasConversationContent: context.hasConversationContent,
      hasCurrentSession: context.hasCurrentSession,
      sessionListDisplayMode: context.sessionListDisplayMode,
    };
  }
}
