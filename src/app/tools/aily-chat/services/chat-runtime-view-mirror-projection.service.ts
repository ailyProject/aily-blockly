import { Injectable, inject } from '@angular/core';

import type { TurnResponseTurn } from 'aily-lex/browser';
import {
  runtimeChangeOptionsFromTranscriptProjection,
  type ChatRuntimeTurnResponseSyncOptions,
} from '../core/chat-runtime-projection-policy';
import type { HostTurnResponseState } from '../helpers/host-turn-response-state';
import { buildSessionTurnOwnerDiagnostics } from '../helpers/session-turn-owner-diagnostics';
import {
  ChatSessionRuntimeStoreService,
  type ChatSessionRuntimeCapabilities,
  type ChatSessionRuntimeChangeOptions,
  type ChatSessionRuntimeStatePatch,
} from './chat-session-runtime-store.service';

export interface ChatRuntimeViewMirrorHandlePatch extends ChatSessionRuntimeStatePatch {
  readonly concurrencyScope?: string | null;
  readonly abortController?: AbortController | null;
}

export interface ChatRuntimeViewMirrorProjectionPatch extends ChatRuntimeViewMirrorHandlePatch {}

export interface ChatRuntimeViewMirrorTurnResponsesProjectionInput {
  readonly sessionId: string | null | undefined;
  readonly turnResponses: readonly TurnResponseTurn[] | null | undefined;
  readonly hostProjectionState: HostTurnResponseState | null;
  readonly capabilities: ChatSessionRuntimeCapabilities;
  readonly concurrencyScope?: string | null;
  readonly projection: ChatRuntimeTurnResponseSyncOptions;
}

export interface ChatRuntimeViewMirrorProjectionPatchInput {
  readonly sessionId: string | null | undefined;
  readonly patch: ChatRuntimeViewMirrorProjectionPatch;
  readonly options?: ChatSessionRuntimeChangeOptions;
}

export interface ChatRuntimeViewMirrorHandleProjectionInput {
  readonly sessionId: string | null | undefined;
  readonly patch: ChatRuntimeViewMirrorHandlePatch;
}

@Injectable()
export class ChatRuntimeViewMirrorProjectionService {
  private readonly runtimeStore = inject(ChatSessionRuntimeStoreService);

  projectRuntimeState(input: ChatRuntimeViewMirrorProjectionPatchInput): boolean {
    const targetSessionId = ChatRuntimeViewMirrorProjectionService.normalizeSessionId(input.sessionId);
    if (!targetSessionId) {
      return false;
    }

    this.runtimeStore.replaceRuntimeState(
      targetSessionId,
      ChatRuntimeViewMirrorProjectionService.toRuntimeStatePatch(input.patch),
      input.options,
    );
    return true;
  }

  syncHandleState(input: ChatRuntimeViewMirrorHandleProjectionInput): boolean {
    const targetSessionId = ChatRuntimeViewMirrorProjectionService.normalizeSessionId(input.sessionId);
    if (!targetSessionId) {
      return false;
    }

    this.runtimeStore.replaceRuntimeState(
      targetSessionId,
      ChatRuntimeViewMirrorProjectionService.toRuntimeStatePatch(input.patch),
      { reason: 'handle' },
    );
    return true;
  }

  syncTurnResponses(input: ChatRuntimeViewMirrorTurnResponsesProjectionInput): boolean {
    const targetSessionId = ChatRuntimeViewMirrorProjectionService.normalizeSessionId(input.sessionId);
    if (!targetSessionId || !Array.isArray(input.turnResponses)) {
      return false;
    }

    const ownerDiagnostics = buildSessionTurnOwnerDiagnostics(targetSessionId, input.turnResponses);
    if (input.turnResponses.length > 0
      && ownerDiagnostics.ownerSamples.length > 0
      && !ownerDiagnostics.ownerSamples.includes(targetSessionId)) {
      console.warn('[AilyChat][RuntimeViewMirrorProjection][blocked-owner-mismatch]', {
        targetSessionId,
        ownerSamples: ownerDiagnostics.ownerSamples,
        firstTurnId: ownerDiagnostics.firstTurnId,
        firstRequestPreview: ownerDiagnostics.firstRequestPreview,
      });
      return false;
    }

    if (input.projection.phase === 'live') {
      const latestTurnResponse = ChatRuntimeViewMirrorProjectionService.resolveLatestTurnResponse(input.turnResponses);
      if (!latestTurnResponse) {
        return true;
      }
      this.runtimeStore.appendOrReplaceTurnResponse(
        targetSessionId,
        latestTurnResponse,
        input.hostProjectionState,
        runtimeChangeOptionsFromTranscriptProjection(input.projection),
      );
      return true;
    }

    this.runtimeStore.replaceRuntimeState(
      targetSessionId,
      {
        turnResponses: input.turnResponses,
        hostProjectionState: input.hostProjectionState,
        capabilities: input.capabilities,
      },
      runtimeChangeOptionsFromTranscriptProjection(input.projection),
    );
    return true;
  }

  private static toRuntimeStatePatch(
    patch: ChatRuntimeViewMirrorProjectionPatch,
  ): ChatSessionRuntimeStatePatch {
    const {
      concurrencyScope: _concurrencyScope,
      abortController: _abortController,
      ...runtimePatch
    } = patch;
    return runtimePatch;
  }

  private static normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }

  private static resolveLatestTurnResponse(
    turnResponses: readonly TurnResponseTurn[],
  ): TurnResponseTurn | null {
    for (let index = turnResponses.length - 1; index >= 0; index -= 1) {
      const turn = turnResponses[index];
      if (typeof turn?.turnId === 'string' && turn.turnId.trim().length > 0) {
        return turn;
      }
    }
    return null;
  }
}
