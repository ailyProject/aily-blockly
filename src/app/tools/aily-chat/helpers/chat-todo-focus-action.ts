import { resolveChatSurfaceModeId } from '../core/chat-mode';

export const CHAT_FOCUS_TODOS_ACTION_ID = 'workbench.action.chat.focusTodosView';
export const CHAT_FOCUS_TODOS_ACTION_LABEL = 'Toggle Focus Between TODOs and Input';

interface ChatTodoFocusActionContext {
  readonly currentMode: string;
  readonly toggleTodosViewFocus: () => boolean;
  readonly notifyUnavailable: () => void;
}

export function canRunChatTodoFocusAction(currentMode: string): boolean {
  return resolveChatSurfaceModeId(currentMode) === 'agent';
}

export function runChatTodoFocusAction(context: ChatTodoFocusActionContext): boolean {
  if (!canRunChatTodoFocusAction(context.currentMode)) {
    return false;
  }

  if (context.toggleTodosViewFocus()) {
    return true;
  }

  context.notifyUnavailable();
  return false;
}