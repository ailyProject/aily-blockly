import type { TurnResponseTurn } from 'aily-lex/browser';

import type { ChatEngineService } from '../services/chat-engine.service';
import type { ChatViewService } from '../services/chat-view.service';
import type { RuntimePlanReviewAction, RuntimePlanReviewDecision } from '../services/chat-runtime-interaction-host.service';
import {
  terminalTranscriptProjection,
  type ChatRuntimeTurnResponseSyncOptions,
} from '../core/chat-runtime-projection-policy';
import { getSharedBlocklyEditorOperationQueue } from '../tools/blocklyEditorOperationQueue';
import { createToolCallProgressEditorOperationSink } from '../tools/editorOperationEvents';

interface AilyChatE2eHarnessOptions {
  readonly engine: ChatEngineService;
  readonly viewState: ChatViewService;
  readonly readRenderingDiagnostics?: () => AilyChatE2eRenderingDiagnostics;
  readonly readPerformanceDiagnostics?: () => unknown;
  readonly runWorkspaceFinalizeBoundaryProbe?: () => Promise<void>;
}

interface AilyChatE2eSnapshot {
  readonly currentMode: string;
  readonly selectedMode: unknown;
  readonly currentCustomAgentTarget?: string;
  readonly currentResolvedMode: unknown;
  readonly currentPaneSurface?: string;
  readonly currentViewSessionResource?: string;
  readonly inputValue: string;
  readonly isWaiting: boolean;
  readonly sessionId: string;
  readonly runtimeState: unknown;
  readonly visibleText: string;
  readonly activeLoadingIndicators: number;
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly dialogItems: readonly {
    readonly id: string;
    readonly turnId?: string;
    readonly responseId?: string;
    readonly role?: string;
    readonly isStreaming?: boolean;
  }[];
  readonly rendering?: AilyChatE2eRenderingDiagnostics;
  readonly performance?: unknown;
}

export interface AilyChatE2eRenderingDiagnostics {
  readonly totalDialogItems: number;
  readonly renderedDialogItems: number;
  readonly mountedDialogElements: number;
  readonly virtualRows: number;
  readonly topSpacerHeight: number;
  readonly bottomSpacerHeight: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollLock: boolean;
  readonly virtualWindowStartIndex: number;
  readonly virtualWindowEndIndex: number;
  readonly measuredRowCount: number;
}

interface AilyChatE2eHarnessApi {
  installDeterministicRuntime(): Promise<AilyChatE2eSnapshot>;
  selectAsk(): Promise<AilyChatE2eSnapshot>;
  selectAgent(): Promise<AilyChatE2eSnapshot>;
  selectPlan(): Promise<AilyChatE2eSnapshot>;
  newSession(): Promise<AilyChatE2eSnapshot>;
  readTurns(sessionId: string): readonly TurnResponseTurn[];
  seedLargeFrozenHistory(count?: number): Promise<AilyChatE2eSnapshot>;
  send(text: string): Promise<AilyChatE2eSnapshot>;
  startImplementation(): Promise<AilyChatE2eSnapshot>;
  sendWhileDetached(text: string): Promise<AilyChatE2eSnapshot>;
  startCancellableStreamingTurn(): Promise<AilyChatE2eSnapshot>;
  awaitCancellableStreamingTurnSettled(): Promise<AilyChatE2eSnapshot>;
  runLongSubagentTurn(): Promise<AilyChatE2eSnapshot>;
  runWorkspaceFinalizeBoundaryProbe(): Promise<AilyChatE2eSnapshot>;
  runEditorOperationStreamingProbe(): Promise<AilyChatE2eSnapshot>;
  startCancellableSubagentTurn(): Promise<AilyChatE2eSnapshot>;
  awaitCancellableSubagentTurnSettled(): Promise<AilyChatE2eSnapshot>;
  startCancellableEditorOperationTurn(): Promise<AilyChatE2eSnapshot>;
  awaitCancellableEditorOperationTurnSettled(): Promise<AilyChatE2eSnapshot>;
  snapshot(): AilyChatE2eSnapshot;
}

declare global {
  interface Window {
    __AILY_CHAT_E2E__?: AilyChatE2eHarnessApi;
  }
}

type DeterministicRun = (llmText: string, displayText?: string) => Promise<void>;

type EnginePrivateAccess = {
  currentMode: string;
  selectedMode: unknown;
  currentResolvedMode: unknown;
  inputValue: string;
  isWaiting: boolean;
  sessionId: string;
  chatService: {
    currentCustomAgentTarget?: string;
  };
  switchToMode: (mode: string) => Promise<void>;
  newChat?: () => Promise<void>;
  ensureSessionReadyForSubmit: () => Promise<string | null>;
  submitUserText: (content: string, options?: { clearInput?: boolean; sessionId?: string | null }) => Promise<void>;
  detachView: () => void;
  chatSessionRuntimeStore?: { read?: (sessionId?: string | null) => unknown };
  dialogItems?: readonly {
    readonly id?: unknown;
    readonly turnId?: unknown;
    readonly responseId?: unknown;
    readonly role?: unknown;
    readonly isStreaming?: unknown;
  }[];
  readSessionTurnResponses?: (sessionId: string) => readonly TurnResponseTurn[];
  replaceSessionModelTurnResponses?: (
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
    ownerPolicy?: { readonly allowForkedTurns?: boolean; readonly source?: string },
  ) => readonly TurnResponseTurn[] | void;
  syncExecutionRuntimeTurnResponses?: (
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
    options: ChatRuntimeTurnResponseSyncOptions,
  ) => void;
  resolveCurrentViewSessionResource?: () => string;
  resolveActiveRuntimeSessionId?: () => string;
  resolveRuntimeResolvedMode?: (sessionId?: string | null) => unknown;
  applyPlanReviewTransitionBeforeResume?: (
    sessionId: string | null | undefined,
    pendingReview: {
      readonly id: string;
      readonly title: string;
      readonly content: string;
      readonly actions: readonly RuntimePlanReviewAction[];
      readonly canProvideFeedback: boolean;
    },
    result: RuntimePlanReviewDecision,
    currentRequestPermissionLevel?: string,
  ) => Promise<void>;
  startImplementationFromPlanPart?: (sessionId?: string | null) => Promise<void>;
  readHostItemLifecycleSnapshot?: () => unknown;
  attachCurrentSessionView?: () => Promise<void>;
  lexStream?: {
    readonly turnResponses?: readonly TurnResponseTurn[];
    agent?: {
      stop?: (sessionId?: string | null) => unknown;
    };
    hydrateTurnResponses?: (
      sessionId: string,
      turnResponses: readonly TurnResponseTurn[],
      options?: { readonly visibility?: string },
    ) => void;
    finalizeCurrentTurnResponse?: (fallbackStatus?: string) => boolean;
    turns?: {
      currentId?: () => string | undefined;
      currentRequestMetadata?: () => Record<string, unknown> | undefined;
      complete?: (response: string) => void;
    };
    turn?: {
      run?: DeterministicRun;
    };
    _renderEventBridge?: {
      setProjectionSessionResource?: (sessionResource: string | null | undefined) => void;
      prepareTurnRequest?: (requestContent: string, displayContent?: string, metadata?: Record<string, unknown>) => void;
      processEvent?: (event: Record<string, unknown>) => void;
      finalizeCurrentTurn?: (fallbackStatus?: string) => boolean;
    };
    _turnExecutionBridge?: {
      runTurnWithRenderEvents?: (
        source: { chat(message: string, signal?: AbortSignal): AsyncIterable<Record<string, unknown>> },
        userMessage: string,
        displayContent?: string,
      ) => Promise<void>;
    };
  };
  chatSessionRuntimeRegistry?: {
    setAbortController?: (sessionId: string | null | undefined, controller: AbortController | null) => boolean;
    syncHandleState?: (
      sessionId: string | null | undefined,
      patch: {
        readonly requestInProgress?: boolean;
        readonly supportsInterruption?: boolean;
        readonly activeResponseHandle?: unknown | null;
        readonly stopSession?: (() => void) | null;
      },
    ) => void;
    awaitPendingLexRequestCompleted?: (sessionId: string | null | undefined) => Promise<void>;
  };
  triggerSyncDetectChanges?: () => void;
};

function readElectronEnv(key: string): Promise<string | undefined> {
  const electronApi = (window as unknown as {
    electronAPI?: { env?: { get?: (name: string) => Promise<string | undefined> } };
  }).electronAPI;
  return electronApi?.env?.get?.(key) ?? Promise.resolve(undefined);
}

function getCurrentSessionId(engine: EnginePrivateAccess): string {
  const viewSessionId = engine.resolveCurrentViewSessionResource?.();
  if (typeof viewSessionId === 'string' && viewSessionId.trim().length > 0) {
    return viewSessionId.trim();
  }

  const runtimeSessionId = engine.resolveActiveRuntimeSessionId?.();
  if (typeof runtimeSessionId === 'string' && runtimeSessionId.trim().length > 0) {
    return runtimeSessionId.trim();
  }

  return typeof engine.sessionId === 'string' ? engine.sessionId.trim() : '';
}

function withHostLifecyclePerformanceSnapshot(
  performance: unknown,
  hostItemLifecycle: unknown,
): unknown {
  if (!hostItemLifecycle) {
    return performance;
  }
  const base = performance && typeof performance === 'object' && !Array.isArray(performance)
    ? performance as Record<string, unknown>
    : {};
  const externalSnapshots = base['externalSnapshots'] && typeof base['externalSnapshots'] === 'object' && !Array.isArray(base['externalSnapshots'])
    ? base['externalSnapshots'] as Record<string, unknown>
    : {};
  return {
    ...base,
    externalSnapshots: {
      ...externalSnapshots,
      host_item_lifecycle: externalSnapshots['host_item_lifecycle'] ?? hostItemLifecycle,
    },
  };
}

function cloneTurnResponseTurn(turn: TurnResponseTurn): TurnResponseTurn {
  return {
    ...turn,
    request: {
      ...turn.request,
      metadata: turn.request.metadata ? { ...turn.request.metadata } : undefined,
    },
    rounds: [...turn.rounds],
    response: {
      ...turn.response,
      parts: turn.response.parts.map((part) => ({ ...part })),
      continuation: turn.response.continuation
        ? {
            ...turn.response.continuation,
            pendingState: turn.response.continuation.pendingState
              ? { ...turn.response.continuation.pendingState }
              : undefined,
            budgets: turn.response.continuation.budgets
              ? { ...turn.response.continuation.budgets }
              : undefined,
            diagnostics: turn.response.continuation.diagnostics
              ? { ...turn.response.continuation.diagnostics }
              : undefined,
          }
        : undefined,
    },
    responseModel: turn.responseModel
      ? { ...turn.responseModel }
      : undefined,
  };
}

function createFrozenHistoryTurn(index: number): TurnResponseTurn {
  const createdAt = 1_700_000_000_000 + index;
  const requestText = `Frozen history request ${index}`;
  const responseText = `Frozen historical answer ${index}`;
  return {
    turnId: `e2e-frozen-history-turn-${index}`,
    request: {
      content: requestText,
      displayContent: requestText,
      metadata: {
        e2eFrozenHistory: true,
        historyIndex: index,
      },
      createdAt,
      updatedAt: createdAt,
    } as TurnResponseTurn['request'],
    rounds: [],
    response: {
      id: `e2e-frozen-history-response-${index}`,
      status: 'completed',
      participant: 'main',
      parts: [{
        type: 'markdown',
        content: responseText,
      }],
      resultText: responseText,
      createdAt,
      updatedAt: createdAt,
    } as TurnResponseTurn['response'],
    createdAt,
    updatedAt: createdAt,
  } as TurnResponseTurn;
}

function buildDeterministicResponse(engine: EnginePrivateAccess, prompt: string): {
  readonly text: string;
  readonly parts?: NonNullable<TurnResponseTurn['response']['parts']>;
  readonly continuation?: TurnResponseTurn['response']['continuation'];
} {
  const selectedMode = engine.selectedMode as { readonly modeId?: string; readonly customAgentTarget?: string } | null | undefined;
  const normalizedPrompt = prompt.trim();
  const selectedModeId = typeof selectedMode?.modeId === 'string'
    ? selectedMode.modeId.trim().toLowerCase()
    : '';

  if (engine.currentMode === 'plan' || selectedModeId === 'plan') {
    const planSteps = /long|large|stress|长/.test(normalizedPrompt)
      ? Array.from(
          { length: 96 },
          (_value, index) => `${index + 1}. Deterministic long plan step ${index + 1}: inspect, implement, and verify one bounded surface.`,
        )
      : [
          '1. Inspect the requested change.',
          '2. Identify affected files.',
          '3. Hand off implementation to Agent when approved.',
        ];
    const text = [
      planSteps.length > 3 ? 'Deterministic long plan:' : 'Deterministic plan:',
      ...planSteps,
    ].join('\n');
    return {
      text,
      parts: [{
        type: 'plan',
        partId: 'plan:e2e-proposed',
        status: 'completed',
        text,
        source: 'proposed_plan',
      } as any],
    };
  }

  if (engine.currentMode === 'ask' && /write|edit|modify|create|delete|实现|修改|写入/.test(normalizedPrompt)) {
    return {
      text: 'Ask mode is read-only. Switch to Agent before making workspace changes.',
    };
  }

  if (/^@Explore\b/i.test(normalizedPrompt)) {
    return {
      text: 'Explore completed as an explicit invocation without changing the selected chat mode.',
    };
  }

  return {
    text: `Deterministic ${engine.currentMode} response: ${normalizedPrompt}`,
  };
}

function completeLatestTurn(engine: EnginePrivateAccess, sessionId: string, prompt: string): void {
  const turns = engine.readSessionTurnResponses?.(sessionId) ?? [];
  if (!turns.length) {
    return;
  }

  const now = Date.now();
  const response = buildDeterministicResponse(engine, prompt);
  engine.lexStream?.turns?.complete?.(response.text);
  const nextTurns = turns.map((turn, index) => {
    if (index !== turns.length - 1) {
      return cloneTurnResponseTurn(turn);
    }

    return {
      ...cloneTurnResponseTurn(turn),
      response: {
        ...turn.response,
        status: 'completed',
        parts: response.parts ?? [{ type: 'markdown', content: response.text }],
        resultText: response.text,
        updatedAt: now,
        ...(response.continuation ? { continuation: response.continuation } : {}),
      },
      updatedAt: now,
    } satisfies TurnResponseTurn;
  });

  const committed = engine.replaceSessionModelTurnResponses?.(sessionId, nextTurns);
  const committedTurns = Array.isArray(committed) ? committed : nextTurns;
  engine.syncExecutionRuntimeTurnResponses?.(sessionId, committedTurns, terminalTranscriptProjection('execution'));
  engine.lexStream?.hydrateTurnResponses?.(sessionId, committedTurns, { visibility: 'visibleAttach' });
  engine.triggerSyncDetectChanges?.();
}

function settlePartForCancellation(part: NonNullable<TurnResponseTurn['response']['parts']>[number]): NonNullable<TurnResponseTurn['response']['parts']>[number] {
  if (part.type === 'tool_call' && (part as { readonly state?: string }).state === 'doing') {
    return {
      ...part,
      state: 'done',
      isComplete: true,
    } as NonNullable<TurnResponseTurn['response']['parts']>[number];
  }

  if (part.type === 'thinking' && (part as { readonly isComplete?: boolean }).isComplete === false) {
    return {
      ...part,
      isComplete: true,
    } as NonNullable<TurnResponseTurn['response']['parts']>[number];
  }

  return part;
}

function cancelLatestTurn(engine: EnginePrivateAccess, sessionId: string): void {
  const turns = engine.readSessionTurnResponses?.(sessionId) ?? [];
  if (!turns.length) {
    return;
  }

  const now = Date.now();
  const nextTurns = turns.map((turn, index) => {
    if (index !== turns.length - 1) {
      return cloneTurnResponseTurn(turn);
    }

    const cloned = cloneTurnResponseTurn(turn);
    return {
      ...cloned,
      response: {
        ...cloned.response,
        status: 'cancelled',
        parts: cloned.response.parts.map(settlePartForCancellation),
        updatedAt: now,
      },
      updatedAt: now,
    } satisfies TurnResponseTurn;
  });

  const committed = engine.replaceSessionModelTurnResponses?.(sessionId, nextTurns, {
    allowForkedTurns: true,
    source: 'e2e-cancellable-subagent-stop',
  });
  const committedTurns = Array.isArray(committed) ? committed : nextTurns;
  engine.syncExecutionRuntimeTurnResponses?.(sessionId, committedTurns, terminalTranscriptProjection('execution'));
  engine.lexStream?.hydrateTurnResponses?.(sessionId, committedTurns, { visibility: 'visibleAttach' });
  engine.triggerSyncDetectChanges?.();
}

function createHarness(options: AilyChatE2eHarnessOptions): AilyChatE2eHarnessApi {
  const engine = options.engine as unknown as EnginePrivateAccess;
  let installed = false;
  let originalRun: DeterministicRun | undefined;
  let pendingCancellableTurn: Promise<unknown> | null = null;
  let cancellableTurnReady: Promise<void> | null = null;
  let resolveCancellableTurnReady: (() => void) | null = null;
  let abortCancellableTurn: (() => void) | null = null;
  let pendingCancellableStreamingTurn: Promise<unknown> | null = null;
  let cancellableStreamingTurnReady: Promise<void> | null = null;
  let resolveCancellableStreamingTurnReady: (() => void) | null = null;
  let abortCancellableStreamingTurn: (() => void) | null = null;
  let pendingCancellableEditorOperationTurn: Promise<unknown> | null = null;
  let cancellableEditorOperationReady: Promise<void> | null = null;
  let resolveCancellableEditorOperationReady: (() => void) | null = null;
  let abortCancellableEditorOperation: (() => void) | null = null;

  const countActiveLoadingIndicators = (): number => {
    const root = document.querySelector('app-aily-chat');
    if (!root) {
      return 0;
    }
    return root.querySelectorAll([
      '.lloading',
      '.fa-spinner',
      '.fa-circle-notch',
      '.loading-icon',
      '[aria-busy="true"]',
    ].join(',')).length;
  };

  const snapshot = (): AilyChatE2eSnapshot => {
    const sessionId = getCurrentSessionId(engine);
    const turnResponses = sessionId
      ? (engine.readSessionTurnResponses?.(sessionId) ?? []).map(cloneTurnResponseTurn)
      : [];
    const runtimeState = engine.chatSessionRuntimeStore?.read?.(sessionId) ?? null;
    const visibleText = document.querySelector('app-aily-chat')?.textContent ?? '';
    const rendering = options.readRenderingDiagnostics?.();
    const performance = withHostLifecyclePerformanceSnapshot(
      options.readPerformanceDiagnostics?.(),
      engine.readHostItemLifecycleSnapshot?.(),
    );
    const dialogItems = Array.isArray(engine.dialogItems)
      ? engine.dialogItems.map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        turnId: typeof item.turnId === 'string' ? item.turnId : undefined,
        responseId: typeof item.responseId === 'string' ? item.responseId : undefined,
        role: typeof item.role === 'string' ? item.role : undefined,
        isStreaming: item.isStreaming === true,
      }))
      : [];

    return {
      currentMode: engine.currentMode,
      selectedMode: engine.selectedMode,
      currentCustomAgentTarget: engine.chatService.currentCustomAgentTarget,
      currentResolvedMode: engine.currentResolvedMode,
      currentPaneSurface: (options.viewState as unknown as { currentPaneSurface?: string }).currentPaneSurface,
      currentViewSessionResource: (options.viewState as unknown as { currentViewSessionResource?: string }).currentViewSessionResource,
      inputValue: engine.inputValue,
      isWaiting: engine.isWaiting,
      sessionId,
      runtimeState,
      visibleText,
      activeLoadingIndicators: countActiveLoadingIndicators(),
      turnResponses,
      dialogItems,
      ...(rendering ? { rendering } : {}),
      ...(performance ? { performance } : {}),
    };
  };

  const installDeterministicRuntime = async (): Promise<AilyChatE2eSnapshot> => {
    if (!installed && engine.lexStream?.turn?.run) {
      originalRun = engine.lexStream.turn.run.bind(engine.lexStream.turn);
      engine.lexStream.turn.run = async (llmText: string, displayText?: string): Promise<void> => {
        const sessionId = getCurrentSessionId(engine);
        completeLatestTurn(engine, sessionId, displayText || llmText);
      };
      installed = true;
    }

    return snapshot();
  };

  const api: AilyChatE2eHarnessApi = {
    installDeterministicRuntime,
    async selectAsk() {
      await installDeterministicRuntime();
      await engine.switchToMode('ask');
      return snapshot();
    },
    async selectAgent() {
      await installDeterministicRuntime();
      await engine.switchToMode('agent');
      return snapshot();
    },
    async selectPlan() {
      await installDeterministicRuntime();
      await engine.switchToMode('plan');
      return snapshot();
    },
    async newSession() {
      await installDeterministicRuntime();
      await engine.newChat?.();
      return snapshot();
    },
    readTurns(sessionId: string) {
      const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
      return targetSessionId
        ? (engine.readSessionTurnResponses?.(targetSessionId) ?? []).map(cloneTurnResponseTurn)
        : [];
    },
    async seedLargeFrozenHistory(count = 128) {
      await installDeterministicRuntime();
      const sessionId = await engine.ensureSessionReadyForSubmit() ?? getCurrentSessionId(engine);
      const boundedCount = Math.max(1, Math.min(Math.floor(Number(count) || 128), 512));
      const turns = Array.from({ length: boundedCount }, (_value, index) => createFrozenHistoryTurn(index));
      const committed = engine.replaceSessionModelTurnResponses?.(sessionId, turns, {
        allowForkedTurns: true,
        source: 'e2e-large-frozen-history',
      });
      const committedTurns = Array.isArray(committed) ? committed : turns;
      engine.syncExecutionRuntimeTurnResponses?.(sessionId, committedTurns, terminalTranscriptProjection('history'));
      engine.lexStream?.hydrateTurnResponses?.(sessionId, committedTurns, { visibility: 'visibleAttach' });
      engine.triggerSyncDetectChanges?.();
      return snapshot();
    },
    async send(text: string) {
      await installDeterministicRuntime();
      const sessionId = await engine.ensureSessionReadyForSubmit();
      await engine.submitUserText(text, { clearInput: true, sessionId });
      return snapshot();
    },
    async startImplementation() {
      await installDeterministicRuntime();
      const sessionId = getCurrentSessionId(engine);
      if (typeof engine.startImplementationFromPlanPart === 'function') {
        await engine.startImplementationFromPlanPart(sessionId);
        return snapshot();
      }

      await engine.applyPlanReviewTransitionBeforeResume?.(
        sessionId,
        {
          id: 'e2e-plan-review',
          title: 'Review Plan',
          content: 'Deterministic plan review',
          canProvideFeedback: true,
          actions: [
            { id: 'start_implementation', label: 'Start Implementation', permissionLevel: 'autopilot' },
            { id: 'exit', label: 'Exit Plan Mode' },
          ],
        },
        { approved: true, actionId: 'start_implementation' },
      );
      return snapshot();
    },
    async sendWhileDetached(text: string) {
      await installDeterministicRuntime();
      const sessionId = await engine.ensureSessionReadyForSubmit() ?? getCurrentSessionId(engine);
      const run = engine.lexStream?.turn?.run;
      let resolveRun: (() => void) | undefined;
      if (run) {
        engine.lexStream!.turn!.run = async (llmText: string, displayText?: string): Promise<void> => {
          await new Promise<void>((resolve) => {
            resolveRun = resolve;
            window.setTimeout(resolve, 50);
          });
          completeLatestTurn(engine, sessionId, displayText || llmText);
        };
      }
      const sendPromise = engine.submitUserText(text, { clearInput: true, sessionId });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      engine.detachView();
      resolveRun?.();
      await sendPromise;
      await engine.attachCurrentSessionView?.();
      if (run) {
        engine.lexStream!.turn!.run = run;
      }
      return snapshot();
    },
    async startCancellableStreamingTurn() {
      await installDeterministicRuntime();
      if (!engine.lexStream?.turn?.run) {
        throw new Error('Aily chat E2E harness requires lexStream.turn.run');
      }

      const previousRun = engine.lexStream.turn.run;
      const previousAgentStop = engine.lexStream.agent?.stop?.bind(engine.lexStream.agent);
      cancellableStreamingTurnReady = new Promise<void>((resolve) => {
        resolveCancellableStreamingTurnReady = resolve;
      });
      if (engine.lexStream.agent && typeof engine.lexStream.agent.stop === 'function') {
        engine.lexStream.agent.stop = (sessionId?: string | null): unknown => {
          abortCancellableStreamingTurn?.();
          return previousAgentStop?.(sessionId);
        };
      }

      engine.lexStream.turn.run = async (llmText: string, displayText?: string): Promise<void> => {
        const sessionId = getCurrentSessionId(engine);
        const turnId = engine.lexStream?.turns?.currentId?.() || `e2e-cancellable-streaming-turn-${Date.now()}`;
        const abortController = new AbortController();
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          abortController.abort();
        };
        abortCancellableStreamingTurn = finish;

        try {
          engine.chatSessionRuntimeRegistry?.setAbortController?.(sessionId, abortController);
          engine.chatSessionRuntimeRegistry?.syncHandleState?.(sessionId, {
            requestInProgress: true,
            supportsInterruption: true,
            activeResponseHandle: `e2e-cancellable-streaming:${turnId}`,
            stopSession: finish,
          });

          const renderBridge = engine.lexStream?._renderEventBridge;
          renderBridge?.prepareTurnRequest?.(
            displayText || llmText,
            displayText,
            engine.lexStream?.turns?.currentRequestMetadata?.() as Record<string, unknown> | undefined,
          );
          const now = Date.now();
          let offset = 0;
          const emit = (event: Record<string, unknown>): void => {
            offset += 1;
            renderBridge?.processEvent?.({
              timestamp: now + offset,
              ...event,
            });
          };

          emit({ type: 'turn_begin', turnId });
          emit({
            type: 'thinking_delta',
            text: 'Streaming route probe is preparing the canonical response owner. ',
          });
          emit({
            type: 'markdown_delta',
            text: 'Streaming route probe chunk before route detach. ',
          });
          engine.triggerSyncDetectChanges?.();
          resolveCancellableStreamingTurnReady?.();
          resolveCancellableStreamingTurnReady = null;
        } catch (error) {
          console.error('[AilyChat][E2E] cancellable streaming setup failed', error);
          resolveCancellableStreamingTurnReady?.();
          resolveCancellableStreamingTurnReady = null;
          throw error;
        }

        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) {
            resolve();
            return;
          }
          abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });

        engine.lexStream?.finalizeCurrentTurnResponse?.('cancelled');
        cancelLatestTurn(engine, sessionId);
        engine.chatSessionRuntimeRegistry?.setAbortController?.(sessionId, null);
        engine.lexStream!.turn!.run = previousRun;
        if (engine.lexStream?.agent && previousAgentStop) {
          engine.lexStream.agent.stop = previousAgentStop;
        }
        abortCancellableStreamingTurn = null;
        const abortError = new Error('Cancellable streaming E2E turn was stopped.');
        abortError.name = 'AbortError';
        throw abortError;
      };

      const sessionId = await engine.ensureSessionReadyForSubmit();
      pendingCancellableStreamingTurn = engine.submitUserText('Start a cancellable streaming E2E turn', {
        clearInput: true,
        sessionId,
      });
      try {
        await Promise.race([
          cancellableStreamingTurnReady,
          new Promise<void>((_resolve, reject) => window.setTimeout(() => {
            reject(new Error('Timed out waiting for cancellable streaming E2E turn to enter running state.'));
          }, 5000)),
        ]);
      } catch (error) {
        engine.lexStream.turn.run = previousRun;
        if (engine.lexStream.agent && previousAgentStop) {
          engine.lexStream.agent.stop = previousAgentStop;
        }
        pendingCancellableStreamingTurn = null;
        cancellableStreamingTurnReady = null;
        resolveCancellableStreamingTurnReady = null;
        abortCancellableStreamingTurn = null;
        throw error;
      }
      return snapshot();
    },
    async awaitCancellableStreamingTurnSettled() {
      const pending = pendingCancellableStreamingTurn;
      if (pending) {
        await Promise.race([
          pending.catch(() => undefined),
          new Promise<void>((resolve) => window.setTimeout(resolve, 2000)),
        ]);
      }
      const sessionId = getCurrentSessionId(engine);
      await Promise.race([
        engine.chatSessionRuntimeRegistry?.awaitPendingLexRequestCompleted?.(sessionId)?.catch(() => undefined) ?? Promise.resolve(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1000)),
      ]);
      engine.lexStream?.finalizeCurrentTurnResponse?.('cancelled');
      cancelLatestTurn(engine, sessionId);
      pendingCancellableStreamingTurn = null;
      cancellableStreamingTurnReady = null;
      resolveCancellableStreamingTurnReady = null;
      abortCancellableStreamingTurn = null;
      engine.triggerSyncDetectChanges?.();
      return snapshot();
    },
    async runLongSubagentTurn() {
      await installDeterministicRuntime();
      if (!engine.lexStream?.turn?.run) {
        throw new Error('Aily chat E2E harness requires lexStream.turn.run');
      }

      const previousRun = engine.lexStream.turn.run;
      engine.lexStream.turn.run = async (llmText: string, displayText?: string): Promise<void> => {
        const turnId = engine.lexStream?.turns?.currentId?.() || `e2e-long-subagent-turn-${Date.now()}`;
        const renderBridge = engine.lexStream?._renderEventBridge;
        const sessionId = getCurrentSessionId(engine);
        const existingTurns = sessionId ? (engine.readSessionTurnResponses?.(sessionId) ?? []) : [];
        renderBridge?.finalizeCurrentTurn?.('completed');
        renderBridge?.setProjectionSessionResource?.(sessionId || null);
        engine.lexStream?.hydrateTurnResponses?.(sessionId, existingTurns, { visibility: 'visibleAttach' });
        renderBridge?.prepareTurnRequest?.(displayText || llmText, displayText, engine.lexStream?.turns?.currentRequestMetadata?.() as Record<string, unknown> | undefined);
        const now = Date.now();
        let offset = 0;
        const emit = (event: Record<string, unknown>): void => {
          offset += 1;
          renderBridge?.processEvent?.({
            timestamp: now + offset,
            ...event,
          });
        };

        emit({ type: 'turn_begin', turnId });
        emit({
          type: 'subagent_begin',
          toolCallId: 'e2e-long-subagent-tool',
          subAgentInvocationId: 'e2e-long-subagent-invocation',
          agentName: 'Explore',
          description: 'E2E long subagent with child tools',
        });
        for (let index = 0; index < 24; index += 1) {
          emit({
            type: 'subagent_activity',
            toolCallId: 'e2e-long-subagent-tool',
            subAgentInvocationId: 'e2e-long-subagent-invocation',
            activityKind: 'thinking',
            content: `Long subagent reasoning segment ${index + 1}. `,
          });
          emit({
            type: 'subagent_activity',
            toolCallId: 'e2e-long-subagent-tool',
            subAgentInvocationId: 'e2e-long-subagent-invocation',
            activityKind: 'text',
            content: `Long subagent text segment ${index + 1}. `,
          });
          emit({
            type: 'subagent_activity',
            toolCallId: 'e2e-long-subagent-tool',
            subAgentInvocationId: 'e2e-long-subagent-invocation',
            activityKind: 'tool_started',
            childToolCallId: `e2e-long-subagent-child-tool-${index + 1}`,
            toolName: 'read_file',
            argsSummary: `src/example-${index + 1}.ts`,
            state: 'doing',
          });
          emit({
            type: 'subagent_activity',
            toolCallId: 'e2e-long-subagent-tool',
            subAgentInvocationId: 'e2e-long-subagent-invocation',
            activityKind: 'tool_completed',
            childToolCallId: `e2e-long-subagent-child-tool-${index + 1}`,
            toolName: 'read_file',
            content: `Completed child tool ${index + 1}`,
            durationMs: 10 + index,
          });
        }
        emit({
          type: 'subagent_end',
          toolCallId: 'e2e-long-subagent-tool',
          subAgentInvocationId: 'e2e-long-subagent-invocation',
          agentName: 'Explore',
          resultText: 'Long subagent completed child tool sweep.',
          state: 'done',
          durationMs: 240,
        });
        emit({
          type: 'markdown_delta',
          text: '[Explore/search] Long subagent completed child tool sweep.',
        });
        emit({ type: 'turn_end', turnId });
        engine.lexStream?.turns?.complete?.('Long subagent completed child tool sweep.');
      };

      try {
        const sessionId = await engine.ensureSessionReadyForSubmit();
        await engine.submitUserText('Run a long subagent E2E turn', { clearInput: true, sessionId });
        engine.lexStream?.finalizeCurrentTurnResponse?.('completed');
        const finalizedTurns = engine.lexStream?.turnResponses ?? [];
        if (finalizedTurns.length > 0) {
          const committed = engine.replaceSessionModelTurnResponses?.(sessionId, finalizedTurns, {
            allowForkedTurns: true,
            source: 'e2e-long-subagent-canonical-run',
          });
          const committedTurns = Array.isArray(committed) ? committed : finalizedTurns;
          engine.syncExecutionRuntimeTurnResponses?.(sessionId, committedTurns, terminalTranscriptProjection('execution'));
          engine.lexStream?.hydrateTurnResponses?.(sessionId, committedTurns, { visibility: 'visibleAttach' });
        }
      } finally {
        engine.lexStream.turn.run = previousRun;
      }
      engine.triggerSyncDetectChanges?.();
      return snapshot();
    },
    async runWorkspaceFinalizeBoundaryProbe() {
      await installDeterministicRuntime();
      if (typeof options.runWorkspaceFinalizeBoundaryProbe !== 'function') {
        throw new Error('Aily chat E2E harness requires runWorkspaceFinalizeBoundaryProbe');
      }

      await options.runWorkspaceFinalizeBoundaryProbe();
      return snapshot();
    },
    async runEditorOperationStreamingProbe() {
      await installDeterministicRuntime();
      if (!engine.lexStream?.turn?.run) {
        throw new Error('Aily chat E2E harness requires lexStream.turn.run');
      }

      const previousRun = engine.lexStream.turn.run;
      engine.lexStream.turn.run = async (llmText: string, displayText?: string): Promise<void> => {
        const sessionId = getCurrentSessionId(engine);
        const turnId = engine.lexStream?.turns?.currentId?.() || `e2e-editor-operation-streaming-turn-${Date.now()}`;
        const toolCallId = 'e2e-editor-operation-streaming-tool';
        const renderBridge = engine.lexStream?._renderEventBridge;
        const existingTurns = sessionId ? (engine.readSessionTurnResponses?.(sessionId) ?? []) : [];
        const yieldToBrowser = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

        renderBridge?.finalizeCurrentTurn?.('completed');
        renderBridge?.setProjectionSessionResource?.(sessionId || null);
        engine.lexStream?.hydrateTurnResponses?.(sessionId, existingTurns, { visibility: 'visibleAttach' });
        renderBridge?.prepareTurnRequest?.(
          displayText || llmText,
          displayText,
          engine.lexStream?.turns?.currentRequestMetadata?.() as Record<string, unknown> | undefined,
        );

        const emit = (event: Record<string, unknown>): void => {
          renderBridge?.processEvent?.({
            timestamp: Date.now(),
            ...event,
          });
        };

        emit({ type: 'turn_begin', turnId });
        emit({
          type: 'tool_call_begin',
          toolCallId,
          toolName: 'syncAbs',
          input: { action: 'import', source: 'e2e-editor-operation-streaming-probe' },
        });

        const progressSink = createToolCallProgressEditorOperationSink({
          // Keep this deterministic probe on the same bounded bus as real tool paths,
          // while making the assertion stable by preventing timer flushes mid-loop.
          progressBatchMs: 1000,
          emitEvent: (event: unknown) => {
            if (event && typeof event === 'object') {
              renderBridge?.processEvent?.({
                timestamp: Date.now(),
                ...(event as Record<string, unknown>),
              });
            }
          },
        });

        const operation = getSharedBlocklyEditorOperationQueue().enqueue(
          'blockly.syncAbs.import',
          'E2E editor operation while chat streams',
          async (reportProgress) => {
            for (let index = 0; index < 48; index += 1) {
              await reportProgress({
                summary: `Applying Blockly batch ${index + 1}`,
                progress: (index + 1) / 48,
              });
              if (index % 4 === 3) {
                await yieldToBrowser();
              }
            }
            return 'editor-operation-streaming-ok';
          },
          {
            sessionId,
            turnId,
            toolCallId,
            progressSink,
            runOutsideAngular: operationRunner => operationRunner(),
          },
        );

        for (let index = 0; index < 18; index += 1) {
          emit({
            type: 'thinking_delta',
            text: `Streaming probe reasoning chunk ${index + 1}. `,
          });
          emit({
            type: 'markdown_delta',
            text: `Live markdown chunk ${index + 1}. `,
          });
          await yieldToBrowser();
        }
        emit({ type: 'thinking_complete' });

        await operation;
        emit({
          type: 'tool_call_end',
          toolCallId,
          toolName: 'syncAbs',
          resultText: 'Editor operation streaming probe completed',
          state: 'done',
        });
        emit({
          type: 'markdown_delta',
          text: 'Streaming/editor operation probe completed.',
        });
        emit({ type: 'turn_end', turnId });
        engine.lexStream?.turns?.complete?.('Streaming/editor operation probe completed.');
      };

      try {
        const sessionId = await engine.ensureSessionReadyForSubmit();
        await engine.submitUserText('Run editor operation streaming probe', { clearInput: true, sessionId });
        engine.lexStream?.finalizeCurrentTurnResponse?.('completed');
        const finalizedTurns = engine.lexStream?.turnResponses ?? [];
        if (finalizedTurns.length > 0) {
          const committed = engine.replaceSessionModelTurnResponses?.(sessionId, finalizedTurns, {
            allowForkedTurns: true,
            source: 'e2e-editor-operation-streaming-probe',
          });
          const committedTurns = Array.isArray(committed) ? committed : finalizedTurns;
          engine.syncExecutionRuntimeTurnResponses?.(sessionId, committedTurns, terminalTranscriptProjection('execution'));
          engine.lexStream?.hydrateTurnResponses?.(sessionId, committedTurns, { visibility: 'visibleAttach' });
        }
      } finally {
        engine.lexStream.turn.run = previousRun;
      }
      engine.triggerSyncDetectChanges?.();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
      engine.triggerSyncDetectChanges?.();
      return snapshot();
    },
    async startCancellableSubagentTurn() {
      await installDeterministicRuntime();
      if (!engine.lexStream?.turn?.run) {
        throw new Error('Aily chat E2E harness requires lexStream.turn.run');
      }

      const previousRun = engine.lexStream.turn.run;
      const previousAgentStop = engine.lexStream.agent?.stop?.bind(engine.lexStream.agent);
      cancellableTurnReady = new Promise<void>((resolve) => {
        resolveCancellableTurnReady = resolve;
      });
      if (engine.lexStream.agent && typeof engine.lexStream.agent.stop === 'function') {
        engine.lexStream.agent.stop = (sessionId?: string | null): unknown => {
          abortCancellableTurn?.();
          return previousAgentStop?.(sessionId);
        };
      }

      engine.lexStream.turn.run = async (llmText: string, displayText?: string): Promise<void> => {
        const sessionId = getCurrentSessionId(engine);
        const turnId = engine.lexStream?.turns?.currentId?.() || `e2e-turn-${Date.now()}`;
        const abortController = new AbortController();
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          abortController.abort();
        };
        abortCancellableTurn = finish;

        try {
          engine.chatSessionRuntimeRegistry?.setAbortController?.(sessionId, abortController);
          engine.chatSessionRuntimeRegistry?.syncHandleState?.(sessionId, {
            requestInProgress: true,
            supportsInterruption: true,
            activeResponseHandle: `e2e-cancellable-subagent:${turnId}`,
            stopSession: finish,
          });

          const renderBridge = engine.lexStream?._renderEventBridge;
          const existingTurns = sessionId ? (engine.readSessionTurnResponses?.(sessionId) ?? []) : [];
          renderBridge?.finalizeCurrentTurn?.('completed');
          renderBridge?.setProjectionSessionResource?.(sessionId || null);
          engine.lexStream?.hydrateTurnResponses?.(sessionId, existingTurns, { visibility: 'visibleAttach' });
          renderBridge?.prepareTurnRequest?.(displayText || llmText, displayText, engine.lexStream?.turns?.currentRequestMetadata?.() as Record<string, unknown> | undefined);
          const now = Date.now();
          const emit = (event: Record<string, unknown>, offset = 0): void => {
            renderBridge?.processEvent?.({
              timestamp: now + offset,
              ...event,
            });
          };

          emit({ type: 'turn_begin', turnId }, 0);
          emit({
            type: 'subagent_begin',
            toolCallId: 'e2e-subagent-tool',
            subAgentInvocationId: 'e2e-subagent-invocation',
            agentName: 'Explore',
            description: 'E2E cancellable subagent',
          }, 1);
          emit({
            type: 'subagent_activity',
            toolCallId: 'e2e-subagent-tool',
            subAgentInvocationId: 'e2e-subagent-invocation',
            activityKind: 'thinking',
            content: 'Subagent is inspecting project state...',
          }, 2);
          emit({
            type: 'subagent_activity',
            toolCallId: 'e2e-subagent-tool',
            subAgentInvocationId: 'e2e-subagent-invocation',
            activityKind: 'tool_started',
            childToolCallId: 'e2e-subagent-child-tool',
            toolName: 'read_file',
            argsSummary: 'generator.js',
            state: 'doing',
          }, 3);
          emit({
            type: 'subagent_activity',
            toolCallId: 'e2e-subagent-tool',
            subAgentInvocationId: 'e2e-subagent-invocation',
            activityKind: 'tool_progress',
            childToolCallId: 'e2e-subagent-child-tool',
            toolName: 'read_file',
            content: 'Reading generator.js',
            state: 'doing',
          }, 4);
          engine.triggerSyncDetectChanges?.();
          resolveCancellableTurnReady?.();
          resolveCancellableTurnReady = null;
        } catch (error) {
          console.error('[AilyChat][E2E] cancellable subagent setup failed', error);
          resolveCancellableTurnReady?.();
          resolveCancellableTurnReady = null;
          throw error;
        }

        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) {
            resolve();
            return;
          }
          abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });

        engine.lexStream?.finalizeCurrentTurnResponse?.('cancelled');
        cancelLatestTurn(engine, sessionId);
        engine.chatSessionRuntimeRegistry?.setAbortController?.(sessionId, null);
        engine.lexStream!.turn!.run = previousRun;
        if (engine.lexStream?.agent && previousAgentStop) {
          engine.lexStream.agent.stop = previousAgentStop;
        }
        abortCancellableTurn = null;
        const abortError = new Error('Cancellable subagent E2E turn was stopped.');
        abortError.name = 'AbortError';
        throw abortError;
      };

      const sessionId = await engine.ensureSessionReadyForSubmit();
      pendingCancellableTurn = engine.submitUserText('Start a cancellable subagent E2E turn', {
        clearInput: true,
        sessionId,
      });
      try {
        await Promise.race([
          cancellableTurnReady,
          new Promise<void>((_resolve, reject) => window.setTimeout(() => {
            reject(new Error('Timed out waiting for cancellable subagent E2E turn to enter running state.'));
          }, 5000)),
        ]);
      } catch (error) {
        engine.lexStream.turn.run = previousRun;
        if (engine.lexStream.agent && previousAgentStop) {
          engine.lexStream.agent.stop = previousAgentStop;
        }
        pendingCancellableTurn = null;
        cancellableTurnReady = null;
        resolveCancellableTurnReady = null;
        abortCancellableTurn = null;
        throw error;
      }
      return snapshot();
    },
    async awaitCancellableSubagentTurnSettled() {
      const pending = pendingCancellableTurn;
      if (pending) {
        await Promise.race([
          pending.catch(() => undefined),
          new Promise<void>((resolve) => window.setTimeout(resolve, 2000)),
        ]);
      }
      const sessionId = getCurrentSessionId(engine);
      await Promise.race([
        engine.chatSessionRuntimeRegistry?.awaitPendingLexRequestCompleted?.(sessionId)?.catch(() => undefined) ?? Promise.resolve(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1000)),
      ]);
      engine.lexStream?.finalizeCurrentTurnResponse?.('cancelled');
      cancelLatestTurn(engine, sessionId);
      pendingCancellableTurn = null;
      cancellableTurnReady = null;
      resolveCancellableTurnReady = null;
      abortCancellableTurn = null;
      engine.triggerSyncDetectChanges?.();
      return snapshot();
    },
    async startCancellableEditorOperationTurn() {
      await installDeterministicRuntime();
      if (!engine.lexStream?.turn?.run) {
        throw new Error('Aily chat E2E harness requires lexStream.turn.run');
      }

      const previousRun = engine.lexStream.turn.run;
      const previousAgentStop = engine.lexStream.agent?.stop?.bind(engine.lexStream.agent);
      cancellableEditorOperationReady = new Promise<void>((resolve) => {
        resolveCancellableEditorOperationReady = resolve;
      });
      if (engine.lexStream.agent && typeof engine.lexStream.agent.stop === 'function') {
        engine.lexStream.agent.stop = (sessionId?: string | null): unknown => {
          abortCancellableEditorOperation?.();
          return previousAgentStop?.(sessionId);
        };
      }

      engine.lexStream.turn.run = async (llmText: string, displayText?: string): Promise<void> => {
        const sessionId = getCurrentSessionId(engine);
        const turnId = engine.lexStream?.turns?.currentId?.() || `e2e-editor-operation-turn-${Date.now()}`;
        const toolCallId = 'e2e-editor-operation-tool';
        const abortController = new AbortController();
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          abortController.abort();
        };
        abortCancellableEditorOperation = finish;

        const renderBridge = engine.lexStream?._renderEventBridge;
        const existingTurns = sessionId ? (engine.readSessionTurnResponses?.(sessionId) ?? []) : [];
        renderBridge?.finalizeCurrentTurn?.('completed');
        renderBridge?.setProjectionSessionResource?.(sessionId || null);
        engine.lexStream?.hydrateTurnResponses?.(sessionId, existingTurns, { visibility: 'visibleAttach' });
        renderBridge?.prepareTurnRequest?.(displayText || llmText, displayText, engine.lexStream?.turns?.currentRequestMetadata?.() as Record<string, unknown> | undefined);

        const emit = (event: Record<string, unknown>): void => {
          renderBridge?.processEvent?.({
            timestamp: Date.now(),
            ...event,
          });
        };

        try {
          engine.chatSessionRuntimeRegistry?.setAbortController?.(sessionId, abortController);
          engine.chatSessionRuntimeRegistry?.syncHandleState?.(sessionId, {
            requestInProgress: true,
            supportsInterruption: true,
            activeResponseHandle: `e2e-cancellable-editor-operation:${turnId}`,
            stopSession: finish,
          });

          emit({ type: 'turn_begin', turnId });
          emit({
            type: 'tool_call_begin',
            toolCallId,
            toolName: 'syncAbs',
            input: { action: 'import', source: 'e2e-cancellable-editor-operation' },
          });

          const progressSink = createToolCallProgressEditorOperationSink({
            batchProgress: false,
            emitEvent: (event: unknown) => {
              if (event && typeof event === 'object') {
                renderBridge?.processEvent?.({
                  timestamp: Date.now(),
                  ...(event as Record<string, unknown>),
                });
              }
            },
          });

          const operation = getSharedBlocklyEditorOperationQueue().enqueue(
            'blockly.syncAbs.import',
            'E2E cancellable editor operation',
            async (reportProgress) => {
              await reportProgress({ summary: 'Preparing Blockly workspace import', progress: 0.25 });
              engine.triggerSyncDetectChanges?.();
              resolveCancellableEditorOperationReady?.();
              resolveCancellableEditorOperationReady = null;
              await new Promise<void>((resolve) => {
                if (abortController.signal.aborted) {
                  resolve();
                  return;
                }
                abortController.signal.addEventListener('abort', () => resolve(), { once: true });
              });
              const abortError = new Error('Editor operation cancelled by Stop');
              abortError.name = 'AbortError';
              throw abortError;
            },
            {
              sessionId,
              turnId,
              toolCallId,
              signal: abortController.signal,
              progressSink,
              runOutsideAngular: operation => operation(),
            },
          );

          await operation;
          emit({
            type: 'tool_call_end',
            toolCallId,
            toolName: 'syncAbs',
            resultText: 'Editor operation completed',
            state: 'done',
          });
          emit({ type: 'turn_end', turnId });
          engine.lexStream?.turns?.complete?.('Editor operation completed.');
        } catch (error) {
          if (!abortController.signal.aborted) {
            throw error;
          }
          renderBridge?.finalizeCurrentTurn?.('cancelled');
          engine.lexStream?.finalizeCurrentTurnResponse?.('cancelled');
          cancelLatestTurn(engine, sessionId);
          throw error;
        } finally {
          engine.chatSessionRuntimeRegistry?.setAbortController?.(sessionId, null);
          engine.lexStream!.turn!.run = previousRun;
          if (engine.lexStream?.agent && previousAgentStop) {
            engine.lexStream.agent.stop = previousAgentStop;
          }
          abortCancellableEditorOperation = null;
        }
      };

      const sessionId = await engine.ensureSessionReadyForSubmit();
      pendingCancellableEditorOperationTurn = engine.submitUserText('Start a cancellable editor operation E2E turn', {
        clearInput: true,
        sessionId,
      });
      try {
        await Promise.race([
          cancellableEditorOperationReady,
          pendingCancellableEditorOperationTurn.then(
            () => {
              throw new Error('Cancellable editor operation E2E turn completed before entering running state.');
            },
            (error) => {
              throw error instanceof Error ? error : new Error(String(error));
            },
          ),
          new Promise<void>((_resolve, reject) => window.setTimeout(() => {
            reject(new Error('Timed out waiting for cancellable editor operation E2E turn to enter running state.'));
          }, 5000)),
        ]);
      } catch (error) {
        engine.lexStream.turn.run = previousRun;
        if (engine.lexStream.agent && previousAgentStop) {
          engine.lexStream.agent.stop = previousAgentStop;
        }
        pendingCancellableEditorOperationTurn = null;
        cancellableEditorOperationReady = null;
        resolveCancellableEditorOperationReady = null;
        abortCancellableEditorOperation = null;
        throw error;
      }
      return snapshot();
    },
    async awaitCancellableEditorOperationTurnSettled() {
      const pending = pendingCancellableEditorOperationTurn;
      if (pending) {
        await Promise.race([
          pending.catch(() => undefined),
          new Promise<void>((resolve) => window.setTimeout(resolve, 2000)),
        ]);
      }
      const sessionId = getCurrentSessionId(engine);
      await Promise.race([
        engine.chatSessionRuntimeRegistry?.awaitPendingLexRequestCompleted?.(sessionId)?.catch(() => undefined) ?? Promise.resolve(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1000)),
      ]);
      engine.lexStream?.finalizeCurrentTurnResponse?.('cancelled');
      cancelLatestTurn(engine, sessionId);
      pendingCancellableEditorOperationTurn = null;
      cancellableEditorOperationReady = null;
      resolveCancellableEditorOperationReady = null;
      abortCancellableEditorOperation = null;
      engine.triggerSyncDetectChanges?.();
      return snapshot();
    },
    snapshot,
  };

  Object.defineProperty(api, 'originalRun', {
    value: originalRun,
    enumerable: false,
  });

  return api;
}

export function exposeAilyChatE2eHarness(options: AilyChatE2eHarnessOptions): void {
  void readElectronEnv('AILY_E2E').then((value) => {
    if (value !== '1') {
      return;
    }

    window.__AILY_CHAT_E2E__ = createHarness(options);
  });
}
