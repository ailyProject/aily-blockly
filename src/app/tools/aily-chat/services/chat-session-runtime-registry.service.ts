import { Inject, Injectable } from '@angular/core';

import type { TurnResponseTurn } from 'aily-lex/browser';
import {
  buildHostProjectionStateFromPersistedRecord,
  type HostTurnResponseState,
} from '../helpers/host-turn-response-state';
import { ChatPerformanceTracer } from './chat-perf-tracer';
import type {
  ChatSessionRuntimeChangeOptions,
  ChatSessionRuntimeDebugSummary,
  ChatSessionRuntimeState,
} from './chat-session-runtime-store.service';
import {
  ChatSessionRuntimeRegistryCore,
  type ChatSessionActiveRequestHandle,
  type ChatSessionRuntimeHandle,
  type ChatSessionRuntimeHandlePatch,
} from './chat-session-runtime-registry-core';
import {
  ChatSessionRuntimeCompletionQueueCore,
  type ChatSessionLexRequestCompletedInput,
  type ChatSessionRuntimeCompletionPhase,
} from './chat-session-runtime-completion-queue-core';
import {
  ChatSessionRuntimeProjectionCore,
  type ChatSessionRuntimeProjectionPatch,
} from './chat-session-runtime-projection-core';
import { ChatSessionRuntimePostTurnResourcesCore } from './chat-session-runtime-post-turn-resources-core';
import {
  CHAT_SESSION_RUNTIME_MIRROR_WRITER,
  type ChatSessionRuntimeMirrorWriterPort,
} from './chat-session-runtime-mirror-writer';
import {
  CHAT_SESSION_LEX_POST_TURN_RESOURCE_FACTORY,
  type ChatSessionLexPostTurnResourceFactory,
  type ChatSessionLexPostTurnResources,
} from './chat-session-lex-post-turn-resource-factory.service';
import {
  CHAT_RUNTIME_OWNER_SCHEDULER,
  type ChatRuntimeOwnerSchedulerPort,
} from './chat-runtime-owner-ports';
import type { ChatRuntimeOwnerRuntimeRegistryPort } from './chat-runtime-owner-runtime-registry';

export type {
  ChatSessionActiveRequestHandle,
  ChatSessionRuntimeHandle,
  ChatSessionRuntimeHandlePatch,
} from './chat-session-runtime-registry-core';

export type { ChatSessionLexRequestCompletedInput } from './chat-session-runtime-completion-queue-core';
export type { ChatSessionRuntimeProjectionPatch } from './chat-session-runtime-projection-core';
export type { ChatSessionLexPostTurnResources } from './chat-session-lex-post-turn-resource-factory.service';

const LEX_COMPLETION_IDLE_TIMEOUT_MS = 500;
const LEX_COMPLETION_SLOW_PHASE_MS = 64;
const LEX_COMPLETION_BACKGROUND_GLOBAL_KEY = '__AILY_CHAT_LEX_COMPLETION_PENDING_COUNT__';

function getNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function updateLexCompletionBackgroundOperation(delta: number): void {
  const global = globalThis as Record<string, unknown>;
  const current = typeof global[LEX_COMPLETION_BACKGROUND_GLOBAL_KEY] === 'number'
    ? global[LEX_COMPLETION_BACKGROUND_GLOBAL_KEY] as number
    : 0;
  global[LEX_COMPLETION_BACKGROUND_GLOBAL_KEY] = Math.max(0, current + delta);
}

@Injectable()
export class ChatSessionRuntimeRegistryService implements ChatRuntimeOwnerRuntimeRegistryPort {
  private readonly registryCore = new ChatSessionRuntimeRegistryCore();
  private readonly projectionCore = new ChatSessionRuntimeProjectionCore();
  private readonly completionQueueCore = new ChatSessionRuntimeCompletionQueueCore({
    onPendingCountDelta: delta => updateLexCompletionBackgroundOperation(delta),
    beforePhase: (sessionId, turnId, phase) => this.yieldBeforeLexCompletionPhase(sessionId, turnId, phase),
    runPhase: (sessionId, turnId, phase, runPhase) =>
      this.runLexCompletionPhase(sessionId, turnId, phase, runPhase),
  });
  private readonly postTurnResourcesCore = new ChatSessionRuntimePostTurnResourcesCore<ChatSessionLexPostTurnResources>();
  constructor(
    @Inject(CHAT_SESSION_RUNTIME_MIRROR_WRITER)
    private readonly runtimeMirror: ChatSessionRuntimeMirrorWriterPort,
    @Inject(CHAT_RUNTIME_OWNER_SCHEDULER)
    private readonly ownerScheduler: ChatRuntimeOwnerSchedulerPort,
    @Inject(CHAT_SESSION_LEX_POST_TURN_RESOURCE_FACTORY)
    private readonly lexPostTurnResourceFactory: ChatSessionLexPostTurnResourceFactory,
  ) {}

  readHandle(sessionId: string | null | undefined): ChatSessionRuntimeHandle | undefined {
    return this.registryCore.readHandle(sessionId);
  }

  readProjectedRuntimeState(sessionId: string | null | undefined): ChatSessionRuntimeState | undefined {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return undefined;
    }

    const runtimeState = this.runtimeMirror.read(normalizedSessionId);
    const activeHandle = this.registryCore.readHandle(normalizedSessionId);
    return this.projectionCore.readProjectedRuntimeState(runtimeState, activeHandle);
  }

  getSessionIds(): readonly string[] {
    return [...new Set([
      ...this.runtimeMirror.getSessionIds(),
      ...this.registryCore.getSessionIds(),
      ...this.postTurnResourcesCore.getSessionIds(),
      ...this.completionQueueCore.getSessionIds(),
    ])];
  }

  getOrCreateLexPostTurnResources(
    sessionId: string | null | undefined,
    cwd: string | null | undefined,
  ): ChatSessionLexPostTurnResources | undefined {
    return this.postTurnResourcesCore.getOrCreate(
      sessionId,
      cwd,
      (normalizedSessionId, normalizedCwd) =>
        this.createLexPostTurnResources(normalizedSessionId, normalizedCwd, this.lexPostTurnResourceFactory),
    );
  }

  scheduleLexRequestCompleted(input: ChatSessionLexRequestCompletedInput): void {
    this.completionQueueCore.schedule(input);
  }

  private async yieldBeforeLexCompletionPhase(
    sessionId: string,
    turnId: string,
    phase: ChatSessionRuntimeCompletionPhase,
  ): Promise<void> {
    const startedAt = getNowMs();
    await this.ownerScheduler.yieldToIdle(LEX_COMPLETION_IDLE_TIMEOUT_MS);
    await this.ownerScheduler.yieldToTask(0);
    ChatPerformanceTracer.recordDuration(
      'lex_completion_idle_boundary',
      getNowMs() - startedAt,
      `session=${sessionId},turn=${turnId},phase=${phase}`,
      { slowThresholdMs: LEX_COMPLETION_SLOW_PHASE_MS },
    );
  }

  private async runLexCompletionPhase(
    sessionId: string,
    turnId: string,
    phase: ChatSessionRuntimeCompletionPhase,
    runPhase: () => Promise<void>,
  ): Promise<void> {
    const startedAt = getNowMs();
    const surface = phase === 'workspace_finalize'
      ? 'workspace_finalize'
      : 'session_save';
    try {
      await ChatPerformanceTracer.runWithSurface(
        surface,
        () => runPhase(),
        `session=${sessionId},turn=${turnId},phase=${phase}`,
      );
    } finally {
      ChatPerformanceTracer.recordDuration(
        `lex_completion_${phase}`,
        getNowMs() - startedAt,
        `session=${sessionId},turn=${turnId}`,
        { slowThresholdMs: LEX_COMPLETION_SLOW_PHASE_MS },
      );
    }
  }

  async awaitPendingLexRequestCompleted(sessionId?: string | null): Promise<void> {
    await this.completionQueueCore.awaitPending(sessionId);
  }

  canStartRequest(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    return this.registryCore.canStartRequest(normalizedSessionId);
  }

  beginRequest(
    sessionId: string | null | undefined,
    handle: ChatSessionActiveRequestHandle,
    projection?: Omit<ChatSessionRuntimeProjectionPatch, keyof ChatSessionRuntimeHandlePatch>,
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    const activeHandle = this.upsertHandle(normalizedSessionId, handle);
    const patch: ChatSessionRuntimeProjectionPatch = {
      ...projection,
      requestInProgress: activeHandle.requestInProgress,
      supportsInterruption: activeHandle.supportsInterruption,
      activeResponseHandle: activeHandle.activeResponseHandle,
      stopSession: activeHandle.stopSession,
      ...(activeHandle.disposeSession ? { disposeSession: activeHandle.disposeSession } : {}),
      capabilities: activeHandle.capabilities,
      ...(activeHandle.concurrencyScope !== undefined ? { concurrencyScope: activeHandle.concurrencyScope } : {}),
    };
    this.projectRuntimeState(normalizedSessionId, patch);
  }

  completeRequest(
    sessionId: string | null | undefined,
    handleId?: unknown,
    debugSummary?: Partial<ChatSessionRuntimeDebugSummary>,
  ): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    const previous = this.registryCore.readHandle(normalizedSessionId);
    if (!previous?.requestInProgress) {
      return false;
    }

    if (handleId !== undefined && previous.activeResponseHandle !== handleId) {
      return false;
    }

    const runtimeState = this.runtimeMirror.read(normalizedSessionId);
    if (this.projectionCore.hasPendingToolResults(runtimeState?.turnResponses)) {
      console.info('[AilyChat][RuntimeRequestInvariant] keep request active while waiting for tool results', {
        sessionId: normalizedSessionId,
        turnCount: runtimeState?.turnResponses.length ?? 0,
      });
      return false;
    }

    this.markRequestComplete(normalizedSessionId, debugSummary);
    return true;
  }

  cancelRequest(
    sessionId: string | null | undefined,
    options?: {
      readonly source?: 'user' | 'system';
      readonly handleId?: unknown;
      readonly debugSummary?: Partial<ChatSessionRuntimeDebugSummary>;
    },
  ): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const handle = this.readHandle(normalizedSessionId);
    if (!normalizedSessionId || !handle?.supportsInterruption) {
      return false;
    }

    if (options?.handleId !== undefined && handle.activeResponseHandle !== options.handleId) {
      return false;
    }

    handle.abortController?.abort();
    handle.stopSession?.();
    return this.completeRequest(normalizedSessionId, handle.activeResponseHandle, {
      ...(options?.debugSummary ?? {}),
      ...(options?.source === 'user' || options?.source === undefined
        ? { lastExplicitInterruptAt: Date.now() }
        : {}),
    });
  }

  clearStaleRequestGate(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    const handle = this.registryCore.readHandle(normalizedSessionId);
    if (handle?.requestInProgress) {
      return false;
    }

    const runtimeState = this.runtimeMirror.read(normalizedSessionId);
    if (!this.projectionCore.hasRuntimeRequestGate(runtimeState)) {
      return false;
    }

    this.registryCore.markRequestComplete(normalizedSessionId);

    this.runtimeMirror.write(normalizedSessionId, {
      status: null,
      requestInProgress: false,
      yieldRequested: false,
      supportsInterruption: false,
      activeResponseHandle: null,
      stopSession: null,
      debugSummary: {
        pendingRequest: false,
      },
    }, {
      reason: 'handle',
    });
    return true;
  }

  setAbortController(
    sessionId: string | null | undefined,
    controller: AbortController | null,
  ): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    const previous = this.registryCore.readHandle(normalizedSessionId);
    const handle = this.upsertHandle(normalizedSessionId, {
      abortController: controller,
      requestInProgress: controller ? previous?.requestInProgress ?? true : previous?.requestInProgress,
      supportsInterruption: controller ? true : previous?.supportsInterruption,
    });
    if (!this.runtimeMirror.hasSession(normalizedSessionId)) {
      return true;
    }

    this.projectHandleToRuntimeStore(normalizedSessionId, handle);
    return true;
  }

  syncHandleState(
    sessionId: string | null | undefined,
    patch: ChatSessionRuntimeHandlePatch,
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    const handle = this.upsertHandle(normalizedSessionId, patch);
    if (!this.runtimeMirror.hasSession(normalizedSessionId)) {
      return;
    }

    this.projectHandleToRuntimeStore(normalizedSessionId, handle);
  }

  releaseHandle(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    const hadHandle = this.registryCore.releaseHandle(normalizedSessionId);
    if (!this.runtimeMirror.hasSession(normalizedSessionId)) {
      return hadHandle;
    }

    this.runtimeMirror.write(normalizedSessionId, {
      requestInProgress: false,
      supportsInterruption: false,
      activeResponseHandle: null,
      stopSession: null,
      disposeSession: null,
    }, {
      reason: 'handle',
    });
    return hadHandle;
  }

  projectRuntimeState(
    sessionId: string | null | undefined,
    patch: ChatSessionRuntimeProjectionPatch,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    const handle = this.upsertHandle(normalizedSessionId, patch);
    this.runtimeMirror.write(
      normalizedSessionId,
      this.projectionCore.buildRuntimeStatePatch(
        patch,
        handle,
        this.buildProjectionCallbacks(normalizedSessionId),
      ),
      this.projectionCore.resolveProjectionChangeOptions(patch, options),
    );
  }

  syncTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId || !Array.isArray(turnResponses)) {
      return;
    }

    const handle = this.upsertHandle(normalizedSessionId, {});
    this.runtimeMirror.write(
      normalizedSessionId,
      this.projectionCore.buildTurnResponsesStatePatch(
        turnResponses,
        hostProjectionState,
        handle,
        this.buildProjectionCallbacks(normalizedSessionId),
      ),
      this.projectionCore.resolveTurnResponsesChangeOptions(options),
    );
  }

  syncTurnResponse(
    sessionId: string | null | undefined,
    turnResponse: TurnResponseTurn | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const normalizedTurnId = typeof turnResponse?.turnId === 'string'
      ? turnResponse.turnId.trim()
      : '';
    if (!normalizedSessionId || !turnResponse || !normalizedTurnId) {
      return;
    }

    const handle = this.upsertHandle(normalizedSessionId, {});
    const previousState = this.runtimeMirror.read(normalizedSessionId);
    const nextTurnResponses = this.projectionCore.appendOrReplaceTurnResponse(
      previousState?.turnResponses ?? [],
      turnResponse,
    );
    const nextHostProjectionState = nextTurnResponses.length > 0
      ? buildHostProjectionStateFromPersistedRecord({ turnResponses: nextTurnResponses })
      : hostProjectionState;
    this.runtimeMirror.write(
      normalizedSessionId,
      this.projectionCore.buildTurnResponsesStatePatch(
        nextTurnResponses,
        nextHostProjectionState,
        handle,
        this.buildProjectionCallbacks(normalizedSessionId),
      ),
      this.projectionCore.resolveTurnResponsesChangeOptions(options),
    );
  }

  attachView(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId || !this.runtimeMirror.hasSession(normalizedSessionId)) {
      return false;
    }

    this.runtimeMirror.write(normalizedSessionId, { attachedView: true }, {
      reason: 'view',
    });
    return true;
  }

  detachView(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId || !this.runtimeMirror.hasSession(normalizedSessionId)) {
      return false;
    }

    this.runtimeMirror.write(normalizedSessionId, {
      attachedView: false,
      debugSummary: {
        lastViewDetachAt: Date.now(),
      },
    }, {
      reason: 'view',
    });
    return true;
  }

  stopSession(sessionId: string | null | undefined): boolean {
    return this.cancelRequest(sessionId, { source: 'user' });
  }

  disposeSession(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    const handle = this.registryCore.readHandle(normalizedSessionId);
    handle?.disposeSession?.();
    this.runtimeMirror.write(normalizedSessionId, {
      requestInProgress: false,
      supportsInterruption: false,
      stopSession: null,
      disposeSession: null,
      activeResponseHandle: null,
      yieldRequested: false,
      debugSummary: {
        lastExplicitDisposeAt: Date.now(),
      },
    }, {
      reason: 'handle',
    });
    this.registryCore.deleteHandle(normalizedSessionId);
    this.postTurnResourcesCore.clearSession(normalizedSessionId);
    this.completionQueueCore.clearSession(normalizedSessionId);
    this.runtimeMirror.clearSession(normalizedSessionId);
    return true;
  }

  clearSession(sessionId: string | null | undefined): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    this.registryCore.deleteHandle(normalizedSessionId);
    this.postTurnResourcesCore.clearSession(normalizedSessionId);
    this.completionQueueCore.clearSession(normalizedSessionId);
    this.runtimeMirror.clearSession(normalizedSessionId);
  }

  clearAll(): void {
    this.registryCore.clear();
    this.postTurnResourcesCore.clearAll();
    this.completionQueueCore.clearAll();
    this.runtimeMirror.clearAll();
  }

  private createLexPostTurnResources(
    sessionId: string,
    cwd: string,
    factory: ChatSessionLexPostTurnResourceFactory,
  ): ChatSessionLexPostTurnResources {
    return factory.create(sessionId, cwd);
  }

  private markRequestComplete(
    sessionId: string,
    debugSummary?: Partial<ChatSessionRuntimeDebugSummary>,
  ): void {
    const previous = this.registryCore.markRequestComplete(sessionId);

    this.runtimeMirror.write(sessionId, this.projectionCore.buildRequestCompleteStatePatch(previous, debugSummary), {
      reason: 'status',
    });
  }

  private upsertHandle(
    sessionId: string,
    patch: ChatSessionRuntimeHandlePatch,
  ): ChatSessionRuntimeHandle {
    return this.registryCore.upsertHandle(sessionId, patch);
  }

  private projectHandleToRuntimeStore(
    sessionId: string,
    handle: ChatSessionRuntimeHandle,
  ): void {
    this.runtimeMirror.write(sessionId, this.projectionCore.buildHandleStatePatch(
      handle,
      this.buildProjectionCallbacks(sessionId),
    ), {
      reason: 'handle',
    });
  }

  private buildProjectionCallbacks(sessionId: string): {
    readonly stopSession: () => void;
    readonly disposeSession: () => void;
  } {
    return {
      stopSession: () => this.stopSession(sessionId),
      disposeSession: () => this.disposeSession(sessionId),
    };
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
  }
}
