export const DEFAULT_AILY_CHAT_TOOL_ID = 'aily-chat';
export const LEGACY_AILY_CHAT_MOUNT_DELAY_MS = 400;

const AILY_CHAT_TOOL_IDS = new Set([DEFAULT_AILY_CHAT_TOOL_ID, 'aily-chat-react']);

/**
 * The embedded tool stack is ordered from lowest to highest z-index. Select
 * the highest Aily Chat entry so host-side quick actions follow the surface
 * the user most recently brought to the front.
 */
export function resolvePreferredAilyChatTool(
  openToolList: readonly string[],
): string {
  return findPreferredAilyChatTool(openToolList) || DEFAULT_AILY_CHAT_TOOL_ID;
}

/**
 * Return the highest open Aily Chat without applying the legacy fallback.
 * Block-selection projection uses this variant so selecting a Blockly block
 * does not implicitly open a chat that the user has not opened.
 */
export function findPreferredAilyChatTool(
  openToolList: readonly string[],
): string | null {
  for (let index = openToolList.length - 1; index >= 0; index -= 1) {
    const toolId = openToolList[index];
    if (AILY_CHAT_TOOL_IDS.has(toolId)) {
      return toolId;
    }
  }

  return null;
}

export function resolveAilyChatMountDelay(
  toolId: string,
  legacyReadyAt: number,
  now: number,
): number {
  return toolId === DEFAULT_AILY_CHAT_TOOL_ID
    ? Math.max(0, legacyReadyAt - now)
    : 0;
}

export function resolveAilyChatExternalInputOptions(
  toolId: string,
  options: Record<string, any> | undefined,
  currentLegacySessionId: string | null | undefined,
): Record<string, any> | undefined {
  if (toolId !== DEFAULT_AILY_CHAT_TOOL_ID || options?.['newChatFirst'] !== true) {
    return options;
  }

  return {
    ...options,
    newChatFirst: !!currentLegacySessionId,
  };
}
