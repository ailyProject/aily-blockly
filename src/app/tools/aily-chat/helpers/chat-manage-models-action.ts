export const CHAT_MANAGE_MODELS_ACTION_ID = 'workbench.action.chat.manage';
export const CHAT_MANAGE_MODELS_ACTION_LABEL = 'Manage Models...';

interface ChatManageModelsActionContext {
  readonly canOpenLanguageModelsConfiguration: () => boolean;
  readonly openLanguageModelsConfiguration: () => boolean;
  readonly notifyUnavailable: () => void;
}

export function canRunChatManageModelsAction(
  context: Pick<ChatManageModelsActionContext, 'canOpenLanguageModelsConfiguration'>,
): boolean {
  return context.canOpenLanguageModelsConfiguration();
}

export function runChatManageModelsAction(context: ChatManageModelsActionContext): boolean {
  if (!canRunChatManageModelsAction(context)) {
    return false;
  }

  if (context.openLanguageModelsConfiguration()) {
    return true;
  }

  context.notifyUnavailable();
  return false;
}