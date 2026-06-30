export const CHAT_SHOW_MEMORIES_ACTION_ID = 'aily.chat.tools.memory.showMemories';
export const CHAT_SHOW_MEMORIES_ACTION_LABEL = 'Show Memories';

interface ChatShowMemoriesActionContext {
  readonly requestShowMemories: () => boolean;
}

export function runChatShowMemoriesAction(
  context: ChatShowMemoriesActionContext,
): boolean {
  return context.requestShowMemories();
}
