import { inject, Injectable } from '@angular/core';

import {
  isResolvedSessionTitleSource,
  normalizeChatSessionTitleCandidate,
  normalizeChatSessionTitleText,
} from '../core/chat-session-title';
import { createElectronChatRuntimeHostTransport } from '../core/electron-chat-runtime-host-transport';
import { ChatTitleRequestService } from '../helpers/chat-title-request.service';
import type { PersistedChatSessionTitleSource } from '../core/chat-session-title';
import { ChatSessionModelStoreService } from './chat-session-model-store.service';
import {
  type ChatRuntimeOwnerSubmittedTurnTitleInput,
  type ChatRuntimeOwnerSubmittedTurnTitlePort,
} from './chat-runtime-owner-ports';

@Injectable()
export class ChatRuntimeOwnerSubmittedTurnTitleService implements ChatRuntimeOwnerSubmittedTurnTitlePort {
  private readonly chatSessionModelStore = inject(ChatSessionModelStoreService);
  private readonly titleRequestService = new ChatTitleRequestService(() => null);

  prepareSubmittedTurnTitle(input: ChatRuntimeOwnerSubmittedTurnTitleInput): void {
    this.scheduleTitleGeneration(() => {
      void this.generateTitleForSubmittedTurn(input.requestText, input.sessionId).catch(error => {
        console.warn('[AilyChat][RuntimeOwnerTitle] Title generation did not complete:', error);
      });
    });
  }

  private scheduleTitleGeneration(callback: () => void): void {
    const scheduleAfterFrame = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : null;
    const scheduleTimer = typeof globalThis.setTimeout === 'function'
      ? globalThis.setTimeout.bind(globalThis)
      : null;

    if (scheduleAfterFrame && scheduleTimer) {
      scheduleAfterFrame(() => {
        scheduleTimer(callback, 0);
      });
      return;
    }
    if (scheduleTimer) {
      scheduleTimer(callback, 0);
      return;
    }
    callback();
  }

  private async generateTitleForSubmittedTurn(content: string, sessionId: string): Promise<void> {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    if (!normalizedSessionId || !normalizedContent || this.hasResolvedModelTitle(normalizedSessionId)) {
      return;
    }

    const generated = await this.titleRequestService.generate(normalizedContent);
    const generatedTitle = normalizeChatSessionTitleText(generated);
    if (!generatedTitle || this.hasResolvedModelTitle(normalizedSessionId)) {
      return;
    }

    const title = normalizeChatSessionTitleCandidate({
      text: generatedTitle,
      source: 'generated',
    });
    this.chatSessionModelStore.updateMetadata(normalizedSessionId, { title });
    await this.persistTitleMetadataThroughHost(normalizedSessionId, generatedTitle, { source: 'generated' });
  }

  private hasResolvedModelTitle(sessionId: string): boolean {
    const title = this.chatSessionModelStore.get(sessionId)?.title;
    const text = normalizeChatSessionTitleText(title?.text);
    return !!text && isResolvedSessionTitleSource(title?.source);
  }

  private async persistTitleMetadataThroughHost(
    sessionId: string,
    title: string,
    options?: SessionTitlePersistenceOptions,
  ): Promise<void> {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const normalizedTitle = typeof title === 'string' ? title.trim() : '';
    if (!normalizedSessionId || !normalizedTitle) {
      return;
    }

    const runtimeHost = createElectronChatRuntimeHostTransport();
    if (!runtimeHost) {
      throw new Error('[AilyChat][RuntimeOwnerTitle] Electron runtime host transport is unavailable.');
    }

    await runtimeHost.requestResourceOperation({
      sessionId: normalizedSessionId,
      kind: 'history-persistence',
      label: 'Persisting chat session metadata',
      resource: {
        title: normalizedTitle,
        titleSource: options?.source ?? null,
      },
      payload: {
        adapter: 'chatHistory',
        record: {
          sessionId: normalizedSessionId,
          metadata: {
            sessionId: normalizedSessionId,
            title: normalizedTitle,
            titleSource: options?.source ?? 'generated',
          },
        },
      },
    });
  }

  private normalizeSessionId(sessionId: unknown): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }
}

interface SessionTitlePersistenceOptions {
  readonly source?: PersistedChatSessionTitleSource;
}
