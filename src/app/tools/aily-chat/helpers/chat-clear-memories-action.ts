export const CHAT_CLEAR_MEMORIES_ACTION_ID = 'aily.chat.tools.memory.clearMemories';
export const CHAT_CLEAR_MEMORIES_ACTION_LABEL = 'Clear Memories';

interface ChatClearMemoriesActionContext {
  readonly requestClearMemories: () => boolean;
}

export function runChatClearMemoriesAction(
  context: ChatClearMemoriesActionContext,
): boolean {
  return context.requestClearMemories();
}
