import { CHAT_ACTION_MENU_SURFACE_ID, CHAT_HOST_HEADER_SURFACE_ID, CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID, CHAT_SESSION_TITLE_TOOLBAR_ID } from '../core/chat-action-surfaces';
import type { ChatHostHeaderAction, ChatHostHeaderSurfaceId } from '../core/chat-host-header-actions';
import type { ChatSessionTitleAction, ChatSessionTitleActionId, ChatSessionTitleToolbarId } from '../core/chat-session-title-actions';
import { CHAT_CLEAR_MEMORIES_ACTION_ID, CHAT_CLEAR_MEMORIES_ACTION_LABEL } from './chat-clear-memories-action';
import { ChatActionContributionRegistry } from './chat-action-contribution-registry';
import { CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_ID, CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_LABEL } from './chat-configure-custom-agents-action';
import { CHAT_FOCUS_TODOS_ACTION_ID, CHAT_FOCUS_TODOS_ACTION_LABEL } from './chat-todo-focus-action';
import { CHAT_MANAGE_MODELS_ACTION_ID, CHAT_MANAGE_MODELS_ACTION_LABEL } from './chat-manage-models-action';
import { type ChatActionSurfaceDescriptor } from './chat-action-surface-registry';
import { CHAT_SHOW_MEMORIES_ACTION_ID, CHAT_SHOW_MEMORIES_ACTION_LABEL } from './chat-show-memories-action';

export const CHAT_ACTION_MENU_CONTRIBUTION_OWNER_ID = 'chat-action-menu-contributions';
export const CHAT_SESSION_TITLE_CONTRIBUTION_OWNER_ID = 'chat-session-title-contributions';
export const CHAT_HOST_HEADER_CONTRIBUTION_OWNER_ID = 'chat-host-header-contributions';

export type ChatActionContributionOwnerId =
  | typeof CHAT_ACTION_MENU_CONTRIBUTION_OWNER_ID
  | typeof CHAT_SESSION_TITLE_CONTRIBUTION_OWNER_ID
  | typeof CHAT_HOST_HEADER_CONTRIBUTION_OWNER_ID;

export interface ChatActionContribution<TActionId extends string, TSurfaceId extends string, TPresentation = never> {
  readonly ownerId: ChatActionContributionOwnerId;
  readonly id: TActionId;
  readonly label: string;
  readonly tooltip?: string;
  readonly icon?: string;
  readonly shortcutText?: string;
  readonly presentation?: TPresentation;
  readonly surfaceId?: TSurfaceId;
  readonly surfaceWhen?: string;
  readonly when?: string;
  readonly enabledWhen?: string;
  readonly group?: string;
  readonly order?: number;
}

export interface ChatActionContributionBinding<TContext, TActionId extends string, TRequest> {
  readonly id: TActionId;
  isActive?(context: TContext): boolean;
  run(context: TContext, request: TRequest): boolean;
}

export type BoundChatActionContribution<
  TContext,
  TSurfaceId extends string,
  TActionId extends string,
  TRequest,
  TPresentation = never,
> = ChatActionSurfaceDescriptor<TContext, TSurfaceId, TActionId, TRequest>
  & ChatActionContribution<TActionId, TSurfaceId, TPresentation>
  & {
    isActive?(context: TContext): boolean;
  };

export function bindChatActionContributions<
  TContext,
  TSurfaceId extends string,
  TActionId extends string,
  TRequest,
  TPresentation = never,
>(
  contributions: readonly ChatActionContribution<TActionId, TSurfaceId, TPresentation>[],
  bindings: readonly ChatActionContributionBinding<TContext, TActionId, TRequest>[],
): readonly BoundChatActionContribution<TContext, TSurfaceId, TActionId, TRequest, TPresentation>[] {
  const bindingById = new Map<TActionId, ChatActionContributionBinding<TContext, TActionId, TRequest>>();
  for (const binding of bindings) {
    bindingById.set(binding.id, binding);
  }

  return contributions.map((contribution) => {
    const binding = bindingById.get(contribution.id);
    if (!binding) {
      throw new Error(`Missing chat action contribution binding for ${contribution.id}`);
    }

    return {
      ...contribution,
      isActive: binding.isActive,
      run: binding.run,
    };
  });
}

type AnyChatActionContribution = ChatActionContribution<string, string, ChatSessionTitleAction['presentation']>;

const chatActionContributionRegistry = new ChatActionContributionRegistry<
  ChatActionContributionOwnerId,
  AnyChatActionContribution
>();

let builtinsRegistered = false;

type ChatActionMenuSurfaceId = typeof CHAT_ACTION_MENU_SURFACE_ID;

export const CHAT_ACTION_MENU_CONTRIBUTIONS: readonly ChatActionContribution<string, ChatActionMenuSurfaceId>[] = [
  {
    ownerId: CHAT_ACTION_MENU_CONTRIBUTION_OWNER_ID,
    id: CHAT_MANAGE_MODELS_ACTION_ID,
    label: CHAT_MANAGE_MODELS_ACTION_LABEL,
    tooltip: CHAT_MANAGE_MODELS_ACTION_LABEL,
    icon: 'fa-light fa-gear',
    surfaceWhen: 'false',
    enabledWhen: 'canRunManageModelsAction',
    group: 'manage',
    order: 1,
  },
  {
    ownerId: CHAT_ACTION_MENU_CONTRIBUTION_OWNER_ID,
    id: CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_ID,
    label: CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_LABEL,
    tooltip: CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_LABEL,
    icon: 'fa-light fa-gear',
    surfaceWhen: 'false',
    group: 'manage',
    order: 2,
  },
  {
    ownerId: CHAT_ACTION_MENU_CONTRIBUTION_OWNER_ID,
    id: CHAT_SHOW_MEMORIES_ACTION_ID,
    label: CHAT_SHOW_MEMORIES_ACTION_LABEL,
    tooltip: CHAT_SHOW_MEMORIES_ACTION_LABEL,
    icon: 'fa-light fa-book-open',
    surfaceWhen: 'false',
    group: 'memory',
    order: 1,
  },
  {
    ownerId: CHAT_ACTION_MENU_CONTRIBUTION_OWNER_ID,
    id: CHAT_CLEAR_MEMORIES_ACTION_ID,
    label: CHAT_CLEAR_MEMORIES_ACTION_LABEL,
    tooltip: CHAT_CLEAR_MEMORIES_ACTION_LABEL,
    icon: 'fa-light fa-broom-wide',
    surfaceWhen: 'false',
    group: 'memory',
    order: 2,
  },
  {
    ownerId: CHAT_ACTION_MENU_CONTRIBUTION_OWNER_ID,
    id: CHAT_FOCUS_TODOS_ACTION_ID,
    surfaceId: CHAT_ACTION_MENU_SURFACE_ID,
    label: CHAT_FOCUS_TODOS_ACTION_LABEL,
    tooltip: CHAT_FOCUS_TODOS_ACTION_LABEL,
    icon: 'fa-light fa-list-check',
    shortcutText: 'Ctrl/⌘ + Shift + T',
    enabledWhen: "currentMode == 'agent'",
    group: 'navigation',
    order: 1,
  },
];

export const CHAT_SESSION_TITLE_ACTION_CONTRIBUTIONS: readonly ChatActionContribution<
  ChatSessionTitleActionId,
  ChatSessionTitleToolbarId,
  ChatSessionTitleAction['presentation']
>[] = [
  {
    ownerId: CHAT_SESSION_TITLE_CONTRIBUTION_OWNER_ID,
    id: 'go-back',
    surfaceId: CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID,
    label: 'Go Back',
    tooltip: 'Go Back',
    icon: 'fa-light fa-arrow-left',
    when: "isChatSurface && hasCurrentSession && sessionListDisplayMode != 'sidebar'",
    group: 'navigation',
    order: 1,
  },
  {
    ownerId: CHAT_SESSION_TITLE_CONTRIBUTION_OWNER_ID,
    id: 'pick-session',
    surfaceId: CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID,
    label: 'Pick session',
    tooltip: 'Pick session',
    presentation: 'title',
    when: 'isChatSurface && hasCurrentSession',
    group: 'navigation',
    order: 2,
  },
];

export const CHAT_HOST_HEADER_ACTION_CONTRIBUTIONS: readonly ChatActionContribution<
  ChatHostHeaderAction['id'],
  ChatHostHeaderSurfaceId
>[] = [
  {
    ownerId: CHAT_HOST_HEADER_CONTRIBUTION_OWNER_ID,
    id: 'new-chat',
    surfaceId: CHAT_HOST_HEADER_SURFACE_ID,
    label: 'New chat',
    tooltip: 'New chat',
    icon: 'fa-light fa-plus',
    when: "currentPaneSurface != 'login' && currentPaneSurface != 'debug-home' && currentPaneSurface != 'debug-session'",
    group: 'primary',
    order: 1,
  },
  {
    ownerId: CHAT_HOST_HEADER_CONTRIBUTION_OWNER_ID,
    id: 'toggle-settings',
    surfaceId: CHAT_HOST_HEADER_SURFACE_ID,
    label: 'Settings',
    tooltip: 'Settings',
    icon: 'fa-light fa-gear',
    when: "currentPaneSurface != 'debug-home' && currentPaneSurface != 'debug-session'",
    group: 'secondary',
    order: 1,
  },
];

export function registerChatActionContributions(contributions: readonly AnyChatActionContribution[]): void {
  chatActionContributionRegistry.appendMany(contributions);
}

export function ensureBuiltinChatActionContributionsRegistered(): void {
  if (builtinsRegistered) {
    return;
  }

  registerChatActionContributions(CHAT_ACTION_MENU_CONTRIBUTIONS);
  registerChatActionContributions(CHAT_SESSION_TITLE_ACTION_CONTRIBUTIONS);
  registerChatActionContributions(CHAT_HOST_HEADER_ACTION_CONTRIBUTIONS);
  builtinsRegistered = true;
}

export function readChatActionContributionsByOwner<TContribution extends AnyChatActionContribution>(
  ownerId: ChatActionContributionOwnerId,
): readonly TContribution[] {
  ensureBuiltinChatActionContributionsRegistered();
  return chatActionContributionRegistry.readByOwner(ownerId) as readonly TContribution[];
}
