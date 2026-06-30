export const CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID = 'chat-session-title-navigation-toolbar';
export const CHAT_SESSION_TITLE_TOOLBAR_ID = 'chat-session-title-toolbar';
export const CHAT_ACTION_MENU_SURFACE_ID = 'chat-action-menu';
export const CHAT_HOST_HEADER_SURFACE_ID = 'chat-host-header';

export const CHAT_ACTION_SURFACE_IDS = {
  sessionTitleNavigationToolbar: CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID,
  sessionTitleToolbar: CHAT_SESSION_TITLE_TOOLBAR_ID,
  actionMenu: CHAT_ACTION_MENU_SURFACE_ID,
  hostHeader: CHAT_HOST_HEADER_SURFACE_ID,
} as const;

export type ChatActionSurfaceId = (typeof CHAT_ACTION_SURFACE_IDS)[keyof typeof CHAT_ACTION_SURFACE_IDS];

export type ChatSessionTitleToolbarId =
  | typeof CHAT_SESSION_TITLE_NAVIGATION_TOOLBAR_ID
  | typeof CHAT_SESSION_TITLE_TOOLBAR_ID;

export type ChatHostHeaderSurfaceId = typeof CHAT_HOST_HEADER_SURFACE_ID;