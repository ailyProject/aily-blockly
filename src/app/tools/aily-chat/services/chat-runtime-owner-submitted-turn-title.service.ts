import { inject, Injectable } from '@angular/core';

import {
  isResolvedSessionTitleSource,
  normalizeChatSessionTitleCandidate,
  normalizeChatSessionTitleText,
} from '../core/chat-session-title';
import { ChatSessionModelStoreService } from './chat-session-model-store.service';
import {
  type ChatRuntimeOwnerGeneratedTitleInput,
  type ChatRuntimeOwnerSubmittedTurnTitlePort,
} from './chat-runtime-owner-ports';

@Injectable()
export class ChatRuntimeOwnerSubmittedTurnTitleService implements ChatRuntimeOwnerSubmittedTurnTitlePort {
  private readonly chatSessionModelStore = inject(ChatSessionModelStoreService);

  applyGeneratedTitle(input: ChatRuntimeOwnerGeneratedTitleInput): boolean {
    const normalizedSessionId = this.normalizeSessionId(input.sessionId);
    const generatedTitle = normalizeChatSessionTitleText(input.title);
    if (!normalizedSessionId || !generatedTitle || this.hasResolvedModelTitle(normalizedSessionId)) {
      return false;
    }
    const title = normalizeChatSessionTitleCandidate({
      text: generatedTitle,
      source: input.source,
    });
    return this.chatSessionModelStore.updateMetadata(normalizedSessionId, { title });
  }

  private hasResolvedModelTitle(sessionId: string): boolean {
    const title = this.chatSessionModelStore.get(sessionId)?.title;
    const text = normalizeChatSessionTitleText(title?.text);
    return !!text && isResolvedSessionTitleSource(title?.source);
  }

  private normalizeSessionId(sessionId: unknown): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }
}
