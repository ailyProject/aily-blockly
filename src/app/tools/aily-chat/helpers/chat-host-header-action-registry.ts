import type {
  ChatHostHeaderAction,
  ChatHostHeaderActionContext,
  ChatHostHeaderActionRequest,
  ChatHostHeaderSurfaceId,
} from '../core/chat-host-header-actions';
import { CHAT_HOST_HEADER_SURFACE_ID } from '../core/chat-host-header-actions';
import type { ChatActionWhenContextMap } from './chat-action-when';
import {
  bindChatActionContributions,
  CHAT_HOST_HEADER_CONTRIBUTION_OWNER_ID,
  readChatActionContributionsByOwner,
  type BoundChatActionContribution,
} from './chat-action-contributions';
import { ChatActionSurfaceRegistry } from './chat-action-surface-registry';

export interface ChatHostHeaderActionRegistryContext extends ChatHostHeaderActionContext {
  runNewChatAction(): boolean;
  runToggleSettingsAction(): boolean;
}

type ChatHostHeaderContextKeyMap = ChatActionWhenContextMap & {
  readonly currentPaneSurface: string;
  readonly showSettings: boolean;
};

interface ChatHostHeaderRegisteredAction extends BoundChatActionContribution<
  ChatHostHeaderActionRegistryContext,
  ChatHostHeaderSurfaceId,
  ChatHostHeaderAction['id'],
  ChatHostHeaderActionRequest
> {
  isActive?(context: ChatHostHeaderActionRegistryContext): boolean;
}

const CHAT_HOST_HEADER_REGISTERED_ACTIONS: readonly ChatHostHeaderRegisteredAction[] = bindChatActionContributions([
  ...readChatActionContributionsByOwner<ChatHostHeaderRegisteredAction>(CHAT_HOST_HEADER_CONTRIBUTION_OWNER_ID),
], [
  {
    id: 'new-chat',
    run: context => context.runNewChatAction(),
  },
  {
    id: 'toggle-settings',
    isActive: context => context.showSettings,
    run: context => context.runToggleSettingsAction(),
  },
]);

export class ChatHostHeaderActionRegistry {
  private readonly surfaceRegistry: ChatActionSurfaceRegistry<
    ChatHostHeaderActionRegistryContext,
    ChatHostHeaderSurfaceId,
    ChatHostHeaderAction['id'],
    ChatHostHeaderActionRequest,
    ChatHostHeaderRegisteredAction
  >;

  constructor(private readonly getContext: () => ChatHostHeaderActionRegistryContext) {
    this.surfaceRegistry = new ChatActionSurfaceRegistry({
      getContext,
      descriptors: CHAT_HOST_HEADER_REGISTERED_ACTIONS,
      createContextKeyMap: context => this.createContextKeyMap(context),
    });
  }

  getActions(): readonly ChatHostHeaderAction[] {
    return this.surfaceRegistry
      .getSurfaceEntries(CHAT_HOST_HEADER_SURFACE_ID)
      .filter(({ enabled }) => enabled)
      .map(({ descriptor, context }) => ({
        id: descriptor.id,
        label: descriptor.label,
        tooltip: descriptor.tooltip ?? descriptor.label,
        iconClass: descriptor.icon,
        active: descriptor.isActive?.(context) === true,
      }));
  }

  runAction(request: ChatHostHeaderActionRequest): boolean {
    return this.surfaceRegistry.runActionById(request.action.id, request);
  }

  private createContextKeyMap(context: ChatHostHeaderActionRegistryContext): ChatHostHeaderContextKeyMap {
    return {
      currentPaneSurface: context.currentPaneSurface,
      showSettings: context.showSettings,
    };
  }
}