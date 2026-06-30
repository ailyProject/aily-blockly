import type { TurnResponseTurn } from 'aily-lex/browser';

import {
  ChatSessionModelStoreService,
  type ChatSessionTurnOwnerPolicyOptions,
} from './chat-session-model-store.service';

type SessionModelStoreRead = Pick<ChatSessionModelStoreService, 'get'>;
type SessionModelStoreMutate = Pick<ChatSessionModelStoreService, 'get' | 'acquireOrCreate'>;

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

export function replaceSessionModelTurnResponsesInStore(
  modelStore: (SessionModelStoreMutate & Pick<ChatSessionModelStoreService, 'replaceTurnResponses'>) | null | undefined,
  sessionId: string | null | undefined,
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
  ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
): readonly TurnResponseTurn[] | null {
  const targetSessionId = normalizeSessionModelTurnResponseSessionId(sessionId);
  if (!modelStore || !targetSessionId || !Array.isArray(turnResponses)) {
    return null;
  }

  const modelReference = ensureSessionModelForTurnResponses(modelStore, targetSessionId);
  if (!modelReference) {
    return null;
  }

  try {
    return modelStore.replaceTurnResponses(targetSessionId, turnResponses, ownerPolicy);
  } finally {
    modelReference.dispose();
  }
}

export function appendOrReplaceSessionModelTurnResponseInStore(
  modelStore: (SessionModelStoreMutate & Pick<ChatSessionModelStoreService, 'appendOrReplaceTurnResponse'>) | null | undefined,
  sessionId: string | null | undefined,
  turnResponse: TurnResponseTurn,
  ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
): readonly TurnResponseTurn[] | null {
  const targetSessionId = normalizeSessionModelTurnResponseSessionId(sessionId);
  if (!modelStore || !targetSessionId) {
    return null;
  }

  const modelReference = ensureSessionModelForTurnResponses(modelStore, targetSessionId);
  if (!modelReference) {
    return null;
  }

  try {
    return modelStore.appendOrReplaceTurnResponse(targetSessionId, turnResponse, ownerPolicy);
  } finally {
    modelReference.dispose();
  }
}

function ensureSessionModelForTurnResponses(
  modelStore: SessionModelStoreMutate,
  sessionId: string,
) {
  const existingModel = modelStore.get(sessionId);
  if (existingModel) {
    return {
      object: existingModel,
      dispose: () => undefined,
    };
  }

  return modelStore.acquireOrCreate({ sessionResource: sessionId });
}

function normalizeSessionModelTurnResponseSessionId(sessionId: string | null | undefined): string {
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}
