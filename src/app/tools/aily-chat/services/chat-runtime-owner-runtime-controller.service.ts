import { Inject, Injectable } from '@angular/core';

import type {
  ChatRuntimeHostSessionId,
  ChatRuntimeHostSessionState,
  ChatRuntimeHostSessionStatus,
  ChatRuntimeHostSubmitReadiness,
  ChatRuntimeHostTranscriptSnapshot,
} from '../core/chat-runtime-host-contract';
import {
  type ChatSessionRuntimeState,
  type ChatSessionRuntimeStatus,
} from './chat-session-runtime-store.service';
import type {
  ChatSessionRuntimeHandle,
} from './chat-session-runtime-registry-core';
import {
  CHAT_SESSION_RUNTIME_MIRROR_WRITER,
  type ChatSessionRuntimeMirrorWriterPort,
} from './chat-session-runtime-mirror-writer';
import type {
  ChatRuntimeOwnerAgentEntryReadyInput,
  ChatRuntimeOwnerBeginRequestInput,
  ChatRuntimeOwnerHandleProjectionMetadata,
  ChatRuntimeOwnerRerunGateState,
  ChatRuntimeOwnerRuntimeControllerPort,
  ChatRuntimeOwnerSessionSnapshotInput,
} from './chat-runtime-owner-ports';
import {
  CHAT_RUNTIME_OWNER_RUNTIME_REGISTRY,
  type ChatRuntimeOwnerRuntimeRegistryPort,
} from './chat-runtime-owner-runtime-registry';

@Injectable()
export class ChatRuntimeOwnerRuntimeControllerService implements ChatRuntimeOwnerRuntimeControllerPort {
  constructor(
    @Inject(CHAT_RUNTIME_OWNER_RUNTIME_REGISTRY)
    private readonly runtimeRegistry: ChatRuntimeOwnerRuntimeRegistryPort,
    @Inject(CHAT_SESSION_RUNTIME_MIRROR_WRITER)
    private readonly runtimeMirror: ChatSessionRuntimeMirrorWriterPort,
  ) {}

  attachSessionView(sessionId: ChatRuntimeHostSessionId): void {
    this.runtimeRegistry.attachView(sessionId);
  }

  detachSessionView(sessionId: ChatRuntimeHostSessionId): void {
    this.runtimeRegistry.detachView(sessionId);
  }

  readSubmitReadiness(sessionId: ChatRuntimeHostSessionId): ChatRuntimeHostSubmitReadiness {
    const activeHandle = this.runtimeRegistry.readHandle(sessionId);
    return {
      sessionId,
      canSubmit: this.runtimeRegistry.canStartRequest(sessionId),
      requestInProgress: activeHandle?.requestInProgress === true,
    };
  }

  ensureSessionCanRerun(sessionId: ChatRuntimeHostSessionId): ChatRuntimeOwnerRerunGateState {
    const activeHandle = this.runtimeRegistry.readHandle(sessionId);
    if (activeHandle?.requestInProgress === true) {
      return {
        activeRequestInProgress: true,
        staleGateCleared: false,
      };
    }

    return {
      activeRequestInProgress: false,
      staleGateCleared: this.runtimeRegistry.clearStaleRequestGate(sessionId),
    };
  }

  syncAgentEntryReady(input: ChatRuntimeOwnerAgentEntryReadyInput): void {
    this.runtimeRegistry.syncHandleState(input.sessionId, {
      requestInProgress: false,
      supportsInterruption: false,
      activeResponseHandle: null,
      stopSession: null,
      disposeSession: input.disposeSession,
    });
  }

  releaseRuntimeHandle(sessionId: ChatRuntimeHostSessionId): boolean {
    return this.runtimeRegistry.releaseHandle(sessionId);
  }

  setRuntimeAbortController(
    sessionId: ChatRuntimeHostSessionId,
    controller: AbortController | null,
  ): boolean {
    return this.runtimeRegistry.setAbortController(sessionId, controller);
  }

  getOrCreateLexPostTurnResources(
    sessionId: ChatRuntimeHostSessionId,
    cwd: string | null | undefined,
  ) {
    return this.runtimeRegistry.getOrCreateLexPostTurnResources(sessionId, cwd);
  }

  scheduleLexRequestCompleted(input: Parameters<ChatRuntimeOwnerRuntimeControllerPort['scheduleLexRequestCompleted']>[0]): void {
    this.runtimeRegistry.scheduleLexRequestCompleted(input);
  }

  beginSubmittedRequestState(input: ChatRuntimeOwnerBeginRequestInput): void {
    this.runtimeRegistry.beginRequest(input.sessionId, {
      requestInProgress: true,
      supportsInterruption: true,
      activeResponseHandle: input.activeResponseHandle,
      stopSession: input.stopSession,
      disposeSession: input.disposeSession,
    }, {
      status: 'in_progress',
      attachedView: input.attachedView,
    });
  }

  completeSubmittedRequestState(
    sessionId: ChatRuntimeHostSessionId,
    activeResponseHandle: unknown,
  ): void {
    this.runtimeRegistry.completeRequest(sessionId, activeResponseHandle, {
      pendingRequest: false,
    });
  }

  stopSession(sessionId: ChatRuntimeHostSessionId): void {
    this.runtimeRegistry.stopSession(sessionId);
  }

  disposeSession(sessionId: ChatRuntimeHostSessionId): void {
    this.runtimeRegistry.disposeSession(sessionId);
  }

  getSessionIds(): readonly ChatRuntimeHostSessionId[] {
    return [...new Set([
      ...this.runtimeRegistry.getSessionIds(),
      ...this.runtimeMirror.getSessionIds(),
    ])];
  }

  readRuntimeState(sessionId: ChatRuntimeHostSessionId): ChatSessionRuntimeState | null {
    return this.runtimeMirror.read(sessionId) ?? null;
  }

  readHandleProjectionMetadata(sessionId: ChatRuntimeHostSessionId): ChatRuntimeOwnerHandleProjectionMetadata {
    const handle = this.runtimeRegistry.readHandle(sessionId);
    return {
      capabilities: handle?.capabilities,
      concurrencyScope: handle?.concurrencyScope ?? null,
    };
  }

  projectRuntimeState(
    sessionId: Parameters<ChatRuntimeOwnerRuntimeControllerPort['projectRuntimeState']>[0],
    patch: Parameters<ChatRuntimeOwnerRuntimeControllerPort['projectRuntimeState']>[1],
    options?: Parameters<ChatRuntimeOwnerRuntimeControllerPort['projectRuntimeState']>[2],
  ): void {
    this.runtimeRegistry.projectRuntimeState(sessionId, patch, options);
  }

  syncRuntimeHandleState(
    sessionId: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeHandleState']>[0],
    patch: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeHandleState']>[1],
  ): void {
    this.runtimeRegistry.syncHandleState(sessionId, patch);
  }

  syncRuntimeTurnResponses(
    sessionId: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeTurnResponses']>[0],
    turnResponses: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeTurnResponses']>[1],
    hostProjectionState: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeTurnResponses']>[2],
    options?: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeTurnResponses']>[3],
  ): void {
    this.runtimeRegistry.syncTurnResponses(sessionId, turnResponses, hostProjectionState, options);
  }

  syncRuntimeTurnResponse(
    sessionId: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeTurnResponse']>[0],
    turnResponse: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeTurnResponse']>[1],
    hostProjectionState: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeTurnResponse']>[2],
    options?: Parameters<ChatRuntimeOwnerRuntimeControllerPort['syncRuntimeTurnResponse']>[3],
  ): void {
    this.runtimeRegistry.syncTurnResponse(sessionId, turnResponse, hostProjectionState, options);
  }

  readSessionState(input: ChatRuntimeOwnerSessionSnapshotInput): ChatRuntimeHostSessionState | null {
    const runtimeState = this.readRuntimeState(input.sessionId);
    return runtimeState ? this.buildSessionState(input, runtimeState) : null;
  }

  buildSessionState(
    input: ChatRuntimeOwnerSessionSnapshotInput,
    runtimeState = this.readRuntimeState(input.sessionId),
  ): ChatRuntimeHostSessionState {
    const activeHandle = this.runtimeRegistry.readHandle(input.sessionId);
    const handleRequestInProgress = activeHandle?.requestInProgress === true;
    const requestInProgress = handleRequestInProgress || runtimeState?.requestInProgress === true;
    return {
      sessionId: input.sessionId,
      status: this.toHostStatus(runtimeState?.status, requestInProgress),
      requestInProgress,
      attachedViewIds: input.attachedViewIds,
      activeTurnId: this.readActiveTurnId(runtimeState, activeHandle),
      transcriptRevision: input.transcriptRevision,
      selectedMode: runtimeState?.selectedMode ?? null,
      providerOptions: runtimeState?.providerOptions ?? null,
      currentModel: runtimeState?.currentModel ?? null,
    };
  }

  readTranscript(input: ChatRuntimeOwnerSessionSnapshotInput): ChatRuntimeHostTranscriptSnapshot | null {
    const runtimeState = this.readRuntimeState(input.sessionId);
    return runtimeState ? this.buildTranscriptSnapshot(input, runtimeState) : null;
  }

  buildTranscriptSnapshot(
    input: ChatRuntimeOwnerSessionSnapshotInput,
    runtimeState = this.readRuntimeState(input.sessionId),
  ): ChatRuntimeHostTranscriptSnapshot {
    return {
      sessionId: input.sessionId,
      turnResponses: runtimeState?.turnResponses ?? [],
      revision: input.transcriptRevision,
    };
  }

  async awaitRequestCompletion(sessionId: ChatRuntimeHostSessionId): Promise<void> {
    await this.runtimeRegistry.awaitPendingLexRequestCompleted(sessionId);
  }

  async runWorkspaceFinalizeBoundaryProbe(sessionId: ChatRuntimeHostSessionId): Promise<void> {
    this.runtimeRegistry.scheduleLexRequestCompleted({
      sessionId,
      turnId: `e2e-terminal-boundary-${Date.now()}`,
      reason: 'e2e-terminal-boundary',
      runWorkspaceFinalize: async () => undefined,
      runSessionEndHooks: async () => undefined,
    });
    await this.runtimeRegistry.awaitPendingLexRequestCompleted(sessionId);
  }

  private readActiveTurnId(
    runtimeState: ChatSessionRuntimeState | null,
    activeHandle?: ChatSessionRuntimeHandle,
  ): string | null {
    if (activeHandle?.requestInProgress === true) {
      const activeResponseHandle = this.normalizeActiveResponseHandle(activeHandle.activeResponseHandle);
      if (activeResponseHandle) {
        return activeResponseHandle;
      }
    }
    const latestTurn = runtimeState?.turnResponses[runtimeState.turnResponses.length - 1];
    return typeof latestTurn?.turnId === 'string' && latestTurn.turnId.trim().length > 0
      ? latestTurn.turnId
      : null;
  }

  private normalizeActiveResponseHandle(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (!value || typeof value !== 'object') {
      return null;
    }
    const record = value as { readonly turnId?: unknown; readonly id?: unknown };
    if (typeof record.turnId === 'string' && record.turnId.trim().length > 0) {
      return record.turnId.trim();
    }
    if (typeof record.id === 'string' && record.id.trim().length > 0) {
      return record.id.trim();
    }
    return null;
  }

  private toHostStatus(
    runtimeStatus: ChatSessionRuntimeStatus | undefined,
    requestInProgress: boolean,
  ): ChatRuntimeHostSessionStatus {
    if (requestInProgress || runtimeStatus === 'in_progress') {
      return 'running';
    }
    switch (runtimeStatus) {
      case 'needs_input':
      case 'completed':
      case 'cancelled':
      case 'failed':
        return runtimeStatus;
      default:
        return 'idle';
    }
  }
}
