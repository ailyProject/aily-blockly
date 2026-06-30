export type ChatHostHeaderActionId = 'new-chat' | 'toggle-settings';

export { CHAT_HOST_HEADER_SURFACE_ID } from './chat-action-surfaces';
export type { ChatHostHeaderSurfaceId } from './chat-action-surfaces';

export interface ChatHostHeaderActionContext {
  readonly currentPaneSurface: string;
  readonly showSettings: boolean;
}

export interface ChatHostHeaderAction {
  readonly id: ChatHostHeaderActionId;
  readonly label: string;
  readonly tooltip: string;
  readonly iconClass?: string;
  readonly active?: boolean;
}

export interface ChatHostHeaderActionRequest {
  readonly action: ChatHostHeaderAction;
  readonly event: MouseEvent;
}