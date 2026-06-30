import type { IMenuItem } from '../../../configs/menu.config';
import { CHAT_ACTION_MENU_SURFACE_ID } from '../core/chat-action-surfaces';

import {
  CHAT_FOCUS_TODOS_ACTION_ID,
  CHAT_FOCUS_TODOS_ACTION_LABEL,
  canRunChatTodoFocusAction,
} from './chat-todo-focus-action';
import {
  CHAT_MANAGE_MODELS_ACTION_ID,
  CHAT_MANAGE_MODELS_ACTION_LABEL,
  canRunChatManageModelsAction,
  runChatManageModelsAction,
} from './chat-manage-models-action';
import {
  CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_ID,
  CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_LABEL,
} from './chat-configure-custom-agents-action';
import {
  CHAT_CLEAR_MEMORIES_ACTION_ID,
  CHAT_CLEAR_MEMORIES_ACTION_LABEL,
  runChatClearMemoriesAction,
} from './chat-clear-memories-action';
import {
  CHAT_SHOW_MEMORIES_ACTION_ID,
  runChatShowMemoriesAction,
} from './chat-show-memories-action';
import type { ChatActionWhenContextMap } from './chat-action-when';
import {
  bindChatActionContributions,
  CHAT_ACTION_MENU_CONTRIBUTION_OWNER_ID,
  readChatActionContributionsByOwner,
  type BoundChatActionContribution,
} from './chat-action-contributions';
import {
  ChatActionSurfaceRegistry,
} from './chat-action-surface-registry';

export interface ChatActionRegistryContext {
  readonly currentMode: string;
  canRunManageModelsAction(): boolean;
  runManageModelsAction(): boolean;
  runShowMemoriesAction(): boolean;
  runClearMemoriesAction(): boolean;
  runConfigureCustomAgentsAction(): boolean;
  runFocusTodosViewAction(): boolean;
  notifyManageModelsUnavailable(): void;
}

type ChatActionContextKeyMap = ChatActionWhenContextMap & {
  readonly currentMode: string;
  readonly canRunManageModelsAction: boolean;
};

type ChatActionSurfaceId = typeof CHAT_ACTION_MENU_SURFACE_ID;

interface ChatRegisteredAction extends BoundChatActionContribution<
  ChatActionRegistryContext,
  ChatActionSurfaceId,
  string,
  undefined
> {
}

const CHAT_REGISTERED_ACTIONS: readonly ChatRegisteredAction[] = bindChatActionContributions([
  ...readChatActionContributionsByOwner<ChatRegisteredAction>(CHAT_ACTION_MENU_CONTRIBUTION_OWNER_ID),
], [
  {
    id: CHAT_MANAGE_MODELS_ACTION_ID,
    run: context => runChatManageModelsAction({
      canOpenLanguageModelsConfiguration: () => context.canRunManageModelsAction(),
      openLanguageModelsConfiguration: () => context.runManageModelsAction(),
      notifyUnavailable: () => context.notifyManageModelsUnavailable(),
    }),
  },
  {
    id: CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_ID,
    run: context => context.runConfigureCustomAgentsAction(),
  },
  {
    id: CHAT_SHOW_MEMORIES_ACTION_ID,
    run: context => runChatShowMemoriesAction({
      requestShowMemories: () => context.runShowMemoriesAction(),
    }),
  },
  {
    id: CHAT_CLEAR_MEMORIES_ACTION_ID,
    run: context => runChatClearMemoriesAction({
      requestClearMemories: () => context.runClearMemoriesAction(),
    }),
  },
  {
    id: CHAT_FOCUS_TODOS_ACTION_ID,
    run: context => context.runFocusTodosViewAction(),
  },
]);

export class ChatActionRegistry {
  private readonly surfaceRegistry: ChatActionSurfaceRegistry<
    ChatActionRegistryContext,
    ChatActionSurfaceId,
    string,
    undefined,
    ChatRegisteredAction
  >;

  constructor(private readonly getContext: () => ChatActionRegistryContext) {
    this.surfaceRegistry = new ChatActionSurfaceRegistry({
      getContext,
      descriptors: CHAT_REGISTERED_ACTIONS,
      createContextKeyMap: context => this.createContextKeyMap(context),
    });
  }

  getMenuItems(): readonly IMenuItem[] {
    return this.surfaceRegistry.getSurfaceEntries(CHAT_ACTION_MENU_SURFACE_ID).map(({ descriptor, enabled }) => ({
      name: descriptor.label,
      action: descriptor.id,
      icon: descriptor.icon,
      text: descriptor.shortcutText,
      disabled: !enabled,
      tooltip: descriptor.tooltip ?? descriptor.label,
      data: { actionId: descriptor.id },
      }));
  }

  runMenuAction(item: Pick<IMenuItem, 'action'>): boolean {
    const actionId = item.action;
    if (typeof actionId !== 'string') {
      return false;
    }

    return this.surfaceRegistry.runActionById(actionId, undefined);
  }

  private createContextKeyMap(context: ChatActionRegistryContext): ChatActionContextKeyMap {
    return {
      currentMode: context.currentMode,
      canRunManageModelsAction: canRunChatManageModelsAction({
        canOpenLanguageModelsConfiguration: () => context.canRunManageModelsAction(),
      }),
    };
  }
}