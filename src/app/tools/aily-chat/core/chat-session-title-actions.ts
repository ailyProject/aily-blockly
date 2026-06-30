export type ChatSessionTitleActionId = 'go-back' | 'pick-session';

export type ChatSessionTitleActionPresentation = 'icon' | 'title';

export {
  CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID,
  CHAT_SESSION_TITLE_TOOLBAR_ID,
} from './chat-action-surfaces';
export type { ChatSessionTitleToolbarId } from './chat-action-surfaces';

export type ChatSessionTitleDisplayMode = 'hidden' | 'stacked' | 'sidebar';

export interface ChatSessionTitleActionContext {
  readonly isChatSurface: boolean;
  readonly isBlankSessionSurface?: boolean;
  readonly hasSessions: boolean;
  readonly hasConversationContent: boolean;
  readonly hasCurrentSession: boolean;
  readonly sessionListDisplayMode: ChatSessionTitleDisplayMode;
}

export interface ChatSessionTitleAction {
  readonly id: ChatSessionTitleActionId;
  readonly label: string;
  readonly tooltip: string;
  readonly iconClass?: string;
  readonly presentation?: ChatSessionTitleActionPresentation;
  readonly active?: boolean;
}

export interface ChatSessionTitleSurfaceModel {
  readonly shouldRender: boolean;
  readonly title: string;
  readonly navigationIconActions: readonly ChatSessionTitleAction[];
  readonly titleAction: ChatSessionTitleAction | null;
  readonly actions: readonly ChatSessionTitleAction[];
}

export interface ChatSessionTitleActionRequest {
  readonly action: ChatSessionTitleAction;
  readonly event: MouseEvent;
}
