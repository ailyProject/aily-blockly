import type { TurnResponseTurn } from 'aily-lex/browser';

import type {
  ChatAgentRuntimeMode,
  ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';
import type { ChatSelectedMode } from '../core/chat-mode';
import type { ChatRuntimeHostModelSelectionSnapshot } from '../core/chat-runtime-host-contract';
import type { PendingFollowupRequest } from '../helpers/chat-pending-request';
import type { HostSessionProviderOptions } from '../helpers/host-session-input-state';
import type { HostTurnResponseState } from '../helpers/host-turn-response-state';
import {
  DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES,
  type ChatSessionRuntimeCapabilities,
  type ChatSessionRuntimeChangeOptions,
  type ChatSessionRuntimeChangeReason,
  type ChatSessionRuntimeDebugSummary,
  type ChatSessionRuntimeQuotaOverlay,
  type ChatSessionRuntimeState,
  type ChatSessionRuntimeStatePatch,
  type ChatSessionRuntimeStatus,
  type ChatSessionRuntimeViewOverlay,
} from './chat-session-runtime-store.service';
import type {
  ChatSessionRuntimeHandle,
  ChatSessionRuntimeHandlePatch,
} from './chat-session-runtime-registry-core';

export interface ChatSessionRuntimeProjectionPatch extends ChatSessionRuntimeHandlePatch {
  readonly turnResponses?: readonly TurnResponseTurn[] | null | undefined;
  readonly hostProjectionState?: HostTurnResponseState | null | undefined;
  readonly pendingFollowupRequests?: readonly PendingFollowupRequest[] | null | undefined;
  readonly yieldRequested?: boolean | null | undefined;
  readonly status?: ChatSessionRuntimeStatus | null | undefined;
  readonly description?: string | null | undefined;
  readonly attachedView?: boolean | undefined;
  readonly quotaOverlay?: ChatSessionRuntimeQuotaOverlay | null | undefined;
  readonly viewOverlay?: ChatSessionRuntimeViewOverlay | null | undefined;
  readonly providerOptions?: HostSessionProviderOptions | null | undefined;
  readonly selectedMode?: ChatSelectedMode | null | undefined;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode | null | undefined;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource | null | undefined;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null | undefined;
  readonly debugSummary?: Partial<ChatSessionRuntimeDebugSummary> | null | undefined;
}

export interface ChatSessionRuntimeProjectionCallbacks {
  readonly stopSession: () => void;
  readonly disposeSession: () => void;
}

export class ChatSessionRuntimeProjectionCore {
  readProjectedRuntimeState(
    runtimeState: ChatSessionRuntimeState | undefined,
    activeHandle: ChatSessionRuntimeHandle | undefined,
  ): ChatSessionRuntimeState | undefined {
    if (activeHandle?.requestInProgress) {
      return {
        ...(runtimeState ?? {
          turnResponses: [],
          hostProjectionState: null,
          attachedView: false,
        }),
        requestInProgress: true,
        status: runtimeState?.status ?? 'in_progress',
        supportsInterruption: activeHandle.supportsInterruption,
        activeResponseHandle: activeHandle.activeResponseHandle ?? runtimeState?.activeResponseHandle,
      };
    }

    if (!runtimeState || !this.hasRuntimeRequestGate(runtimeState)) {
      return runtimeState;
    }

    const {
      activeResponseHandle: _activeResponseHandle,
      stopSession: _stopSession,
      status,
      ...rest
    } = runtimeState;
    return {
      ...rest,
      ...(status && status !== 'in_progress' ? { status } : {}),
      requestInProgress: false,
      supportsInterruption: false,
    };
  }

  buildRequestCompleteStatePatch(
    previous: ChatSessionRuntimeHandle | undefined,
    debugSummary?: Partial<ChatSessionRuntimeDebugSummary>,
  ): ChatSessionRuntimeStatePatch {
    return {
      status: null,
      requestInProgress: false,
      yieldRequested: false,
      supportsInterruption: false,
      activeResponseHandle: null,
      stopSession: null,
      capabilities: previous?.capabilities ?? DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES,
      debugSummary,
    };
  }

  buildHandleStatePatch(
    handle: ChatSessionRuntimeHandle,
    callbacks: ChatSessionRuntimeProjectionCallbacks,
  ): ChatSessionRuntimeStatePatch {
    return {
      requestInProgress: handle.requestInProgress,
      supportsInterruption: handle.supportsInterruption,
      activeResponseHandle: handle.activeResponseHandle ?? null,
      stopSession: handle.supportsInterruption
        ? callbacks.stopSession
        : null,
      disposeSession: callbacks.disposeSession,
      capabilities: handle.capabilities,
    };
  }

  buildRuntimeStatePatch(
    patch: ChatSessionRuntimeProjectionPatch,
    handle: ChatSessionRuntimeHandle,
    callbacks: ChatSessionRuntimeProjectionCallbacks,
  ): ChatSessionRuntimeStatePatch {
    return {
      turnResponses: patch.turnResponses,
      hostProjectionState: patch.hostProjectionState,
      pendingFollowupRequests: patch.pendingFollowupRequests,
      yieldRequested: patch.yieldRequested,
      status: patch.status,
      description: patch.description,
      quotaOverlay: patch.quotaOverlay,
      viewOverlay: patch.viewOverlay,
      providerOptions: patch.providerOptions,
      selectedMode: patch.selectedMode,
      agentRuntimeMode: patch.agentRuntimeMode,
      agentRuntimeModeSource: patch.agentRuntimeModeSource,
      currentModel: patch.currentModel,
      requestInProgress: handle.requestInProgress,
      attachedView: patch.attachedView,
      supportsInterruption: handle.supportsInterruption,
      activeResponseHandle: handle.activeResponseHandle,
      stopSession: handle.supportsInterruption
        ? callbacks.stopSession
        : null,
      disposeSession: callbacks.disposeSession,
      capabilities: handle.capabilities,
      debugSummary: patch.debugSummary,
    };
  }

  buildTurnResponsesStatePatch(
    turnResponses: readonly TurnResponseTurn[],
    hostProjectionState: HostTurnResponseState | null,
    handle: ChatSessionRuntimeHandle,
    callbacks: ChatSessionRuntimeProjectionCallbacks,
  ): ChatSessionRuntimeStatePatch {
    return {
      turnResponses,
      hostProjectionState,
      requestInProgress: handle.requestInProgress,
      supportsInterruption: handle.supportsInterruption,
      activeResponseHandle: handle.activeResponseHandle,
      stopSession: handle.supportsInterruption
        ? callbacks.stopSession
        : null,
      disposeSession: callbacks.disposeSession,
      capabilities: handle.capabilities,
    };
  }

  appendOrReplaceTurnResponse(
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    turnResponse: TurnResponseTurn,
  ): readonly TurnResponseTurn[] {
    const turnId = typeof turnResponse.turnId === 'string' ? turnResponse.turnId.trim() : '';
    const nextTurnResponses = Array.isArray(turnResponses) ? [...turnResponses] : [];
    if (!turnId) {
      return nextTurnResponses;
    }

    const existingIndex = nextTurnResponses.findIndex(turn => turn.turnId === turnId);
    if (existingIndex >= 0) {
      nextTurnResponses[existingIndex] = turnResponse;
      return nextTurnResponses;
    }

    nextTurnResponses.push(turnResponse);
    return nextTurnResponses;
  }

  resolveProjectionChangeOptions(
    patch: ChatSessionRuntimeProjectionPatch,
    options?: ChatSessionRuntimeChangeOptions,
  ): ChatSessionRuntimeChangeOptions {
    return {
      reason: options?.reason ?? this.resolveProjectionChangeReason(patch),
      highFrequency: options?.highFrequency,
      listAffecting: options?.listAffecting,
    };
  }

  resolveTurnResponsesChangeOptions(
    options?: ChatSessionRuntimeChangeOptions,
  ): ChatSessionRuntimeChangeOptions {
    return {
      reason: options?.reason ?? 'live_transcript',
      highFrequency: options?.highFrequency ?? true,
      listAffecting: options?.listAffecting ?? false,
    };
  }

  hasRuntimeRequestGate(runtimeState: ChatSessionRuntimeState | undefined): boolean {
    return runtimeState?.requestInProgress === true
      || runtimeState?.supportsInterruption === true
      || runtimeState?.status === 'in_progress'
      || typeof runtimeState?.stopSession === 'function'
      || (runtimeState?.activeResponseHandle !== undefined && runtimeState.activeResponseHandle !== null);
  }

  private resolveProjectionChangeReason(
    patch: ChatSessionRuntimeProjectionPatch,
  ): ChatSessionRuntimeChangeReason {
    if (patch.status !== undefined) {
      return 'status';
    }
    if (patch.description !== undefined) {
      return 'description';
    }
    if (patch.attachedView !== undefined) {
      return 'view';
    }
    if (patch.requestInProgress !== undefined
      || patch.supportsInterruption !== undefined
      || patch.activeResponseHandle !== undefined
      || patch.stopSession !== undefined
      || patch.disposeSession !== undefined) {
      return 'handle';
    }
    if (patch.quotaOverlay !== undefined) {
      return 'quota';
    }
    if (patch.viewOverlay !== undefined) {
      return 'view';
    }
    if (patch.providerOptions !== undefined || patch.selectedMode !== undefined) {
      return 'state';
    }
    if (patch.debugSummary !== undefined) {
      return 'debug';
    }
    if (patch.turnResponses !== undefined || patch.hostProjectionState !== undefined) {
      return 'transcript';
    }

    return 'state';
  }
}
