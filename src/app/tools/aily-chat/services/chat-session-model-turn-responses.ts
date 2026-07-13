import type { TurnResponseTurn } from 'aily-lex/browser';

import { ChatSessionModelStoreService } from './chat-session-model-store.service';

type SessionModelStoreRead = Pick<ChatSessionModelStoreService, 'get'>;

export function readSessionModelTurnResponses(
  modelStore: SessionModelStoreRead | null | undefined,
  sessionId: string | null | undefined,
): readonly TurnResponseTurn[] {
  const targetSessionId = normalizeSessionModelTurnResponseSessionId(sessionId);
  if (!targetSessionId) {
    return [];
  }

  const turnResponses = modelStore?.get?.(targetSessionId)?.turnResponses;
  return Array.isArray(turnResponses) ? turnResponses : [];
}

function normalizeSessionModelTurnResponseSessionId(sessionId: string | null | undefined): string {
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}
