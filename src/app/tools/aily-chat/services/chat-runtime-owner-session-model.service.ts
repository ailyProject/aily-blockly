import { Injectable, inject } from '@angular/core';

import type { TurnResponseTurn } from 'aily-lex/browser';
import {
  ChatSessionModelStoreService,
  type ChatSessionTurnOwnerPolicyOptions,
} from './chat-session-model-store.service';
import {
  readSessionModelTurnResponses,
} from './chat-session-model-turn-responses';
import type { ChatRuntimeOwnerSessionModelPort } from './chat-runtime-owner-ports';

@Injectable()
export class ChatRuntimeOwnerSessionModelService implements ChatRuntimeOwnerSessionModelPort {
  private readonly modelStore = inject(ChatSessionModelStoreService);

  readTurnResponses(sessionId: string | null | undefined): readonly TurnResponseTurn[] {
    return readSessionModelTurnResponses(this.modelStore, sessionId);
  }

  replaceTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null {
    const targetSessionId = this.normalizeSessionId(sessionId);
    if (!targetSessionId || !Array.isArray(turnResponses)) {
      return null;
    }

    const modelReference = this.ensureSessionModel(targetSessionId);
    if (!modelReference) {
      return null;
    }

    try {
      return this.modelStore.replaceAllTurnResponsesTransaction(
        targetSessionId,
        turnResponses,
        ownerPolicy,
      )?.turnResponses ?? null;
    } finally {
      modelReference.dispose();
    }
  }

  appendOrReplaceTurnResponse(
    sessionId: string | null | undefined,
    turnResponse: TurnResponseTurn,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null {
    const targetSessionId = this.normalizeSessionId(sessionId);
    if (!targetSessionId) {
      return null;
    }

    const modelReference = this.ensureSessionModel(targetSessionId);
    if (!modelReference) {
      return null;
    }

    try {
      const transaction = this.isCompletedTurnResponse(turnResponse)
        ? this.modelStore.appendCompletedTurnTransaction(targetSessionId, turnResponse)
        : this.modelStore.appendTransientTurnTransaction(targetSessionId, turnResponse);
      return transaction?.turnResponses ?? null;
    } finally {
      modelReference.dispose();
    }
  }

  private ensureSessionModel(sessionId: string) {
    const existingModel = this.modelStore.get(sessionId);
    if (existingModel) {
      return {
        object: existingModel,
        dispose: () => undefined,
      };
    }

    return this.modelStore.acquireOrCreate({ sessionResource: sessionId });
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }

  private isCompletedTurnResponse(turnResponse: TurnResponseTurn): boolean {
    const status = turnResponse.response?.status;
    return typeof status === 'string' && status !== 'streaming';
  }
}
