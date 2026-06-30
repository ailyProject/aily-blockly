import { Injectable, inject } from '@angular/core';

import type { TurnResponseTurn } from 'aily-lex/browser';
import {
  ChatSessionModelStoreService,
  type ChatSessionTurnOwnerPolicyOptions,
} from './chat-session-model-store.service';
import {
  appendOrReplaceSessionModelTurnResponseInStore,
  readSessionModelTurnResponses,
  replaceSessionModelTurnResponsesInStore,
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
    return replaceSessionModelTurnResponsesInStore(
      this.modelStore,
      sessionId,
      turnResponses,
      ownerPolicy,
    );
  }

  appendOrReplaceTurnResponse(
    sessionId: string | null | undefined,
    turnResponse: TurnResponseTurn,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null {
    return appendOrReplaceSessionModelTurnResponseInStore(
      this.modelStore,
      sessionId,
      turnResponse,
      ownerPolicy,
    );
  }
}
