import type { TurnResponseTurn } from 'aily-lex/browser';

import {
  runtimeChangeOptionsFromTranscriptProjection,
  type ChatRuntimeTurnResponseSyncOptions,
} from '../core/chat-runtime-projection-policy';
import { normalizeChatSessionTitleCandidate } from '../core/chat-session-title';
import {
  buildHostProjectionStateFromPersistedRecord,
  type HostTurnResponseState,
} from './host-turn-response-state';
import type { HostSessionSaveTarget } from './host-session-save-bridge';
import { buildSessionTurnOwnerDiagnostics } from './session-turn-owner-diagnostics';
import type { ChatSessionRuntimeHandlePatch } from '../services/chat-session-runtime-registry-core';
import type { ChatSessionRuntimeProjectionPatch } from '../services/chat-session-runtime-projection-core';
import {
  DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES,
  type ChatSessionRuntimeCapabilities,
  type ChatSessionRuntimeChangeOptions,
} from '../services/chat-session-runtime-store.service';
import type { ChatRuntimeOwnerRuntimeControllerPort } from '../services/chat-runtime-owner-ports';

export interface ChatRuntimeOwnerExecutionProjectionInput {
  readonly saveTarget: HostSessionSaveTarget | null | undefined;
}

export interface ChatRuntimeOwnerProjectionPatchInput {
  readonly sessionId: string | null | undefined;
  readonly patch: ChatSessionRuntimeProjectionPatch;
  readonly options?: ChatSessionRuntimeChangeOptions;
}

export interface ChatRuntimeOwnerHandleProjectionInput {
  readonly sessionId: string | null | undefined;
  readonly patch: ChatSessionRuntimeHandlePatch;
}

export interface ChatRuntimeOwnerTurnResponsesProjectionInput {
  readonly sessionId: string | null | undefined;
  readonly turnResponses: readonly TurnResponseTurn[] | null | undefined;
  readonly hostProjectionState: HostTurnResponseState | null;
  readonly capabilities?: ChatSessionRuntimeCapabilities | null;
  readonly concurrencyScope?: string | null;
  readonly projection: ChatRuntimeTurnResponseSyncOptions;
}

export function buildRuntimeOwnerHostProjectionState(
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): HostTurnResponseState | null {
  return Array.isArray(turnResponses)
    ? buildHostProjectionStateFromPersistedRecord({ turnResponses })
    : null;
}

export function projectExecutionRuntimeStateToRuntimeController(
  runtimeController: Pick<ChatRuntimeOwnerRuntimeControllerPort, 'projectRuntimeState' | 'readHandleProjectionMetadata'>,
  input: ChatRuntimeOwnerExecutionProjectionInput,
): boolean {
  const saveTarget = input.saveTarget;
  const targetSessionId = normalizeSessionId(saveTarget?.sessionId);
  if (!targetSessionId) {
    return false;
  }

  const handle = runtimeController.readHandleProjectionMetadata(targetSessionId);
  const titleCandidate = normalizeChatSessionTitleCandidate(
    saveTarget?.sessionTitleCandidate ?? {
      text: saveTarget?.sessionTitle,
      source: saveTarget?.sessionTitleSource,
      revision: saveTarget?.sessionTitleRevision,
    },
  );
  runtimeController.projectRuntimeState(targetSessionId, {
    turnResponses: Array.isArray(saveTarget?.turnResponses)
      ? saveTarget.turnResponses
      : undefined,
    hostProjectionState: buildRuntimeOwnerHostProjectionState(saveTarget?.turnResponses),
    status: null,
    requestInProgress: false,
    yieldRequested: false,
    supportsInterruption: false,
    activeResponseHandle: null,
    stopSession: null,
    capabilities: handle.capabilities ?? DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES,
    ...(handle.concurrencyScope ? { concurrencyScope: handle.concurrencyScope } : {}),
    debugSummary: {
      liveRuntimeOverlayPresent: Array.isArray(saveTarget?.turnResponses) && saveTarget.turnResponses.length > 0,
      pendingRequest: false,
      needsInput: false,
      attachedView: false,
      ...(titleCandidate.text ? { title: titleCandidate.text } : {}),
      ...(titleCandidate.text && titleCandidate.source !== 'empty' ? { titleSource: titleCandidate.source } : {}),
      ...(titleCandidate.text ? { titleRevision: titleCandidate.revision } : {}),
    },
  });
  return true;
}

export function projectRuntimeStateToRuntimeController(
  runtimeController: Pick<ChatRuntimeOwnerRuntimeControllerPort, 'projectRuntimeState'>,
  input: ChatRuntimeOwnerProjectionPatchInput,
): boolean {
  const targetSessionId = normalizeSessionId(input.sessionId);
  if (!targetSessionId) {
    return false;
  }

  runtimeController.projectRuntimeState(targetSessionId, input.patch, input.options);
  return true;
}

export function syncHandleStateToRuntimeController(
  runtimeController: Pick<ChatRuntimeOwnerRuntimeControllerPort, 'syncRuntimeHandleState'>,
  input: ChatRuntimeOwnerHandleProjectionInput,
): boolean {
  const targetSessionId = normalizeSessionId(input.sessionId);
  if (!targetSessionId) {
    return false;
  }

  runtimeController.syncRuntimeHandleState(targetSessionId, input.patch);
  return true;
}

export function syncTurnResponsesToRuntimeController(
  runtimeController: Pick<
    ChatRuntimeOwnerRuntimeControllerPort,
    'syncRuntimeHandleState' | 'syncRuntimeTurnResponses' | 'syncRuntimeTurnResponse'
  >,
  input: ChatRuntimeOwnerTurnResponsesProjectionInput,
): boolean {
  const targetSessionId = normalizeSessionId(input.sessionId);
  if (!targetSessionId || !Array.isArray(input.turnResponses)) {
    return false;
  }

  const ownerDiagnostics = buildSessionTurnOwnerDiagnostics(targetSessionId, input.turnResponses);
  if (input.turnResponses.length > 0
    && ownerDiagnostics.ownerSamples.length > 0
    && !ownerDiagnostics.ownerSamples.includes(targetSessionId)) {
    console.warn('[AilyChat][RuntimeOwnerProjection][blocked-owner-mismatch]', {
      targetSessionId,
      ownerSamples: ownerDiagnostics.ownerSamples,
      firstTurnId: ownerDiagnostics.firstTurnId,
      firstRequestPreview: ownerDiagnostics.firstRequestPreview,
    });
    return false;
  }

  runtimeController.syncRuntimeHandleState(targetSessionId, {
    capabilities: input.capabilities ?? DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES,
    concurrencyScope: input.concurrencyScope ?? null,
  });
  const changeOptions = runtimeChangeOptionsFromTranscriptProjection(input.projection);
  if (input.projection.phase === 'live') {
    const latestTurnResponse = resolveLatestTurnResponse(input.turnResponses);
    if (!latestTurnResponse) {
      return true;
    }
    runtimeController.syncRuntimeTurnResponse(
      targetSessionId,
      latestTurnResponse,
      input.hostProjectionState,
      changeOptions,
    );
    return true;
  }

  runtimeController.syncRuntimeTurnResponses(
    targetSessionId,
    input.turnResponses,
    input.hostProjectionState,
    changeOptions,
  );
  return true;
}

function normalizeSessionId(sessionId: string | null | undefined): string {
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}

function resolveLatestTurnResponse(
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
