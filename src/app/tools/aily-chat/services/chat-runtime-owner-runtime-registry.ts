import { InjectionToken } from '@angular/core';

import type { TurnResponseTurn } from 'aily-lex/browser';
import type { HostTurnResponseState } from '../helpers/host-turn-response-state';
import type {
  ChatSessionRuntimeChangeOptions,
  ChatSessionRuntimeDebugSummary,
} from './chat-session-runtime-store.service';
import type {
  ChatSessionActiveRequestHandle,
  ChatSessionRuntimeHandle,
  ChatSessionRuntimeHandlePatch,
} from './chat-session-runtime-registry-core';
import type {
  ChatSessionLexRequestCompletedInput,
} from './chat-session-runtime-completion-queue-core';
import type {
  ChatSessionRuntimeProjectionPatch,
} from './chat-session-runtime-projection-core';
import type {
  ChatSessionLexPostTurnResources,
} from './chat-session-lex-post-turn-resource-factory.service';

export interface ChatRuntimeOwnerRuntimeRegistryPort {
  attachView(sessionId: string | null | undefined): boolean;
  detachView(sessionId: string | null | undefined): boolean;
  readHandle(sessionId: string | null | undefined): ChatSessionRuntimeHandle | undefined;
  canStartRequest(sessionId: string | null | undefined): boolean;
  clearStaleRequestGate(sessionId: string | null | undefined): boolean;
  syncHandleState(sessionId: string | null | undefined, patch: ChatSessionRuntimeHandlePatch): void;
  releaseHandle(sessionId: string | null | undefined): boolean;
  setAbortController(sessionId: string | null | undefined, controller: AbortController | null): boolean;
  getOrCreateLexPostTurnResources(
    sessionId: string | null | undefined,
    cwd: string | null | undefined,
  ): ChatSessionLexPostTurnResources | undefined;
  scheduleLexRequestCompleted(input: ChatSessionLexRequestCompletedInput): void;
  beginRequest(
    sessionId: string | null | undefined,
    handle: ChatSessionActiveRequestHandle,
    projection?: Omit<ChatSessionRuntimeProjectionPatch, keyof ChatSessionRuntimeHandlePatch>,
  ): void;
  completeRequest(
    sessionId: string | null | undefined,
    handleId?: unknown,
    debugSummary?: Partial<ChatSessionRuntimeDebugSummary>,
  ): boolean;
  stopSession(sessionId: string | null | undefined): boolean;
  disposeSession(sessionId: string | null | undefined): boolean;
  getSessionIds(): readonly string[];
  projectRuntimeState(
    sessionId: string | null | undefined,
    patch: ChatSessionRuntimeProjectionPatch,
    options?: ChatSessionRuntimeChangeOptions,
  ): void;
  syncTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): void;
  syncTurnResponse(
    sessionId: string | null | undefined,
    turnResponse: TurnResponseTurn | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): void;
  awaitPendingLexRequestCompleted(sessionId?: string | null): Promise<void>;
}

export const CHAT_RUNTIME_OWNER_RUNTIME_REGISTRY = new InjectionToken<ChatRuntimeOwnerRuntimeRegistryPort>(
  'AILY_CHAT_RUNTIME_OWNER_RUNTIME_REGISTRY',
);
