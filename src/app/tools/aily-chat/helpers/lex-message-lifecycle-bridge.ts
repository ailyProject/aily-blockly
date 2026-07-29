import type { IAgentLifecycle, IChatCoordination, IChatViewAccess } from '../core/chat-context';
import type { ChatPart } from '../core/chat-parts';
import type { ChatRuntimeOwnerScheduler } from '../core/chat-runtime-owner-scheduler';
import type { TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';
import type { HostSessionSaveTarget } from './host-session-save-bridge';
import type { ChatPartStoreResponseHandle } from '../core/chat-part-store';
import { yieldToBrowserFrame, yieldToBrowserIdle, yieldToBrowserTask } from '../tools/browserTaskScheduler';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';
import { notifyAilyChatIfBackground } from './user-feedback-notify.helper';


function isFinalizeTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceFinalize', [
    '__AILY_CHAT_TRACE_FINALIZE__',
    'AILY_CHAT_TRACE_FINALIZE',
  ]);
}

const FINALIZE_SLOW_STAGE_LOG_MS = 32;

type LexMessageLifecycleContext = Pick<IChatViewAccess, 'partStore' | 'viewAdapter'>
  & Pick<IAgentLifecycle, 'isWaiting' | 'isCompleted' | 'isCancelled'>
  & Pick<IChatCoordination, 'session' | 'applyPendingSwitch'>
  & {
    readonly sessionId: string;
    readonly ownerScheduler: Pick<ChatRuntimeOwnerScheduler, 'run'>;
    readCurrentViewSessionResource?(): string | null;
    syncExecutionRuntimeState?(saveTarget?: HostSessionSaveTarget | null): void;
  };

export interface LexTurnDraft {
  assistantText: string;
  toolCallCount: number;
  partCount: number;
}

/**
 * Handles assistant message lifecycle concerns for the lex stream path.
 *
 * Keeps message creation, native thinking state, Parts -> content rebuild,
 * and finalize side effects out of LexOwnerFacade.
 */
export class LexMessageLifecycleBridge {
  /** 原生 thinking 事件是否已开启（已输出 <think> 标签，等待闭合） */
  private _nativeThinkStarted = false;
  private _currentTurnId: string | null = null;

  constructor(
    private readonly ctx: LexMessageLifecycleContext,
    private readonly partProcessor: { reset(): void; finalize?(): void },
    private readonly runFinalizeCompaction?: () => Promise<boolean> | boolean,
    private readonly finalizeCurrentTurnResponse?: (fallbackStatus?: TurnResponseStatus) => boolean,
    private readonly readCurrentTurnResponses?: () => readonly TurnResponseTurn[] | null | undefined,
  ) {}

  get currentTurnId(): string | null {
    return this._currentTurnId;
  }

  get currentResponseHandle(): ChatPartStoreResponseHandle | null {
    return this._currentTurnId
      ? this.ctx.partStore.createResponseHandle(this._currentTurnId)
      : null;
  }

  startNativeThinking(): void {
    if (!this._nativeThinkStarted) {
      this._nativeThinkStarted = true;
    }
  }

  closeNativeThinking(): void {
    if (this._nativeThinkStarted) {
      this._nativeThinkStarted = false;
    }
  }

  resetTurnState(): void {
    this.closeNativeThinking();
    this._currentTurnId = null;
    this.partProcessor.reset();
  }

  getCurrentTurnDraft(): LexTurnDraft {
    const handle = this.currentPartStoreHandle;
    if (!handle) {
      return { assistantText: '', toolCallCount: 0, partCount: 0 };
    }

    const parts = this.ctx.partStore.getPartsForHandle(handle);
    let assistantText = '';
    let toolCallCount = 0;

    for (const part of parts) {
      if (part.type === 'markdown') {
        assistantText += part.content;
        continue;
      }

      if (this.isToolBearingPart(part)) {
        toolCallCount++;
      }
    }

    return { assistantText, toolCallCount, partCount: parts.length };
  }

  /**
   * Ensures the current live response is addressed by canonical response key.
   *
   * The visible row itself is owned by TurnResponse/ChatVisibleTranscriptModel.
   * This method intentionally does not create or search a trailing ChatListItem.
   */
  ensureResponseItem(turnId?: string): void {
    const normalizedTurnId = normalizeTurnId(turnId);
    const effectiveTurnId = normalizedTurnId || this._currentTurnId;
    if (!effectiveTurnId) {
      throw new Error('Cannot ensure assistant response without a canonical turn id.');
    }

    this._currentTurnId = effectiveTurnId;
  }

  async finalize(saveTarget?: HostSessionSaveTarget | null): Promise<void> {
    let resolvedSaveTarget = saveTarget ? { ...saveTarget } : null;
    const visibleResponseHandle = this.currentPartStoreHandle;
    const shouldFinalizeVisibleOwner = this.shouldFinalizeVisibleOwner(resolvedSaveTarget) && !!visibleResponseHandle;
    const terminalStatus = this.resolveTerminalTurnResponseStatus();
    const finalizeStartedAt = Date.now();
    let stageStartedAt = finalizeStartedAt;
    const logFinalizeStage = (stage: string): void => {
      const now = Date.now();
      const stageMs = now - stageStartedAt;
      ChatPerformanceTracer.recordDuration(
        'finalize_stage',
        stageMs,
        `stage=${stage},session=${resolvedSaveTarget?.sessionId ?? this.ctx.sessionId ?? '<none>'},elapsed=${now - finalizeStartedAt}`,
        { slowThresholdMs: 16 },
      );
      if (stageMs >= FINALIZE_SLOW_STAGE_LOG_MS) {
        console.info('[AilyChat][FinalizeDebug] slow finalize stage', {
          sessionId: resolvedSaveTarget?.sessionId ?? this.ctx.sessionId ?? null,
          stage,
          stageMs,
          elapsedMs: now - finalizeStartedAt,
        });
      }
      if (!isFinalizeTraceEnabled()) {
        stageStartedAt = now;
        return;
      }
      console.info('[AilyChat][FinalizeDebug] finalize stage', {
        sessionId: resolvedSaveTarget?.sessionId ?? this.ctx.sessionId ?? null,
        stage,
        stageMs,
        elapsedMs: now - finalizeStartedAt,
      });
      stageStartedAt = now;
    };

    if (shouldFinalizeVisibleOwner) {
      this.closeNativeThinking();
      await this.partProcessor.finalize?.();
      this.ctx.partStore.finalizeRunningPartsForHandle(visibleResponseHandle, {
        status: terminalStatus,
      });
      logFinalizeStage('part_processor_finalize');

      this.ctx.viewAdapter.markLastMessageDone();
    } else {
      logFinalizeStage(visibleResponseHandle ? 'skip_detached_visible_finalize' : 'skip_missing_visible_response_owner');
    }

    if (shouldFinalizeVisibleOwner) {
      try {
        await this.runFinalizeCompaction?.();
      } catch (error) {
        console.warn('[LexStream] finalize-time compaction failed:', error);
      }
    }
    logFinalizeStage('finalize_compaction');

    resolvedSaveTarget = this.commitTerminalTurnResponseState(resolvedSaveTarget, terminalStatus);
    logFinalizeStage('terminal_response_commit');

    this.ctx.ownerScheduler.run(() => {
      this.ctx.isWaiting = false;
      this.ctx.isCompleted = true;
    });
    logFinalizeStage('mark_completed');

    void this.runDeferredFinalizeSideEffects({
      finalizeStartedAt,
      resolvedSaveTarget,
      shouldFinalizeVisibleOwner,
      terminalStatus,
    });
  }

  private async runDeferredFinalizeSideEffects(input: {
    readonly finalizeStartedAt: number;
    readonly resolvedSaveTarget: HostSessionSaveTarget | null;
    readonly shouldFinalizeVisibleOwner: boolean;
    readonly terminalStatus: Exclude<TurnResponseStatus, 'streaming'>;
  }): Promise<void> {
    const { finalizeStartedAt, resolvedSaveTarget, shouldFinalizeVisibleOwner, terminalStatus } = input;
    const deferredSaveTarget = resolvedSaveTarget ? { ...resolvedSaveTarget } : null;
    let stageStartedAt = Date.now();
    const logDeferredStage = (stage: string): void => {
      const now = Date.now();
      const stageMs = now - stageStartedAt;
      ChatPerformanceTracer.recordDuration(
        'finalize_deferred_stage',
        stageMs,
        `stage=${stage},session=${deferredSaveTarget?.sessionId ?? this.ctx.sessionId ?? '<none>'},elapsed=${now - finalizeStartedAt}`,
        { slowThresholdMs: 16 },
      );
      if (stageMs >= FINALIZE_SLOW_STAGE_LOG_MS) {
        console.info('[AilyChat][FinalizeDebug] slow deferred finalize stage', {
          sessionId: deferredSaveTarget?.sessionId ?? this.ctx.sessionId ?? null,
          stage,
          stageMs,
          elapsedMs: now - finalizeStartedAt,
        });
      }
      if (!isFinalizeTraceEnabled()) {
        stageStartedAt = now;
        return;
      }
      console.info('[AilyChat][FinalizeDebug] deferred finalize stage', {
        sessionId: deferredSaveTarget?.sessionId ?? this.ctx.sessionId ?? null,
        stage,
        stageMs,
        elapsedMs: now - finalizeStartedAt,
      });
      stageStartedAt = now;
    };

    try {
      await yieldToBrowserFrame();
      await yieldToBrowserIdle(750);
      await yieldToBrowserTask(0);
      logDeferredStage('idle_boundary');

      this.ctx.session.saveCurrentSession(deferredSaveTarget ? { target: deferredSaveTarget } : undefined);
      logDeferredStage('save_session_dispatch');

      notifyAilyChatIfBackground('Aily', '对话已完成');
      logDeferredStage('notify_if_needed');

      await this.ctx.applyPendingSwitch(deferredSaveTarget?.sessionId);
      logDeferredStage('apply_pending_switch');
    } catch (error) {
      console.warn('[LexStream] deferred finalize side effects failed:', error);
    }
  }

  private commitTerminalTurnResponseState(
    saveTarget: HostSessionSaveTarget | null,
    terminalStatus: Exclude<TurnResponseStatus, 'streaming'>,
  ): HostSessionSaveTarget | null {
    try {
      this.finalizeCurrentTurnResponse?.(terminalStatus);
    } catch (error) {
      console.warn('[LexStream] finalize current turn response failed:', error);
    }

    let committedSaveTarget = saveTarget;
    if (saveTarget) {
      // Execution-owned save targets already carry the authoritative session-scoped
      // turnResponses. Do not let visible-bridge snapshots overwrite detached owner truth.
      const candidateTurnResponses = Array.isArray(saveTarget.turnResponses)
        ? saveTarget.turnResponses
        : this.readCurrentTurnResponses?.();
      if (Array.isArray(candidateTurnResponses)) {
        committedSaveTarget = {
          ...saveTarget,
          turnResponses: this.normalizeTerminalTurnResponses(candidateTurnResponses),
        };
      }
    }

    this.ctx.syncExecutionRuntimeState?.(committedSaveTarget);
    return committedSaveTarget;
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private shouldFinalizeVisibleOwner(saveTarget: HostSessionSaveTarget | null): boolean {
    const targetSessionId = typeof saveTarget?.sessionId === 'string' ? saveTarget.sessionId.trim() : '';
    if (!targetSessionId) {
      return true;
    }

    const currentViewSessionResource = typeof this.ctx.readCurrentViewSessionResource === 'function'
      ? this.ctx.readCurrentViewSessionResource()
      : null;
    const visibleSessionId = typeof currentViewSessionResource === 'string' && currentViewSessionResource.trim().length > 0
      ? currentViewSessionResource.trim()
      : typeof this.ctx.sessionId === 'string'
        ? this.ctx.sessionId.trim()
        : '';
    return !!visibleSessionId && targetSessionId === visibleSessionId;
  }

  private get currentPartStoreHandle(): ChatPartStoreResponseHandle | null {
    return this.currentResponseHandle;
  }

  private normalizeTerminalTurnResponses(turnResponses: readonly TurnResponseTurn[]): TurnResponseTurn[] {
    const fallbackStatus = this.resolveTerminalTurnResponseStatus();
    let hasStreaming = false;
    for (const turn of turnResponses) {
      if (turn?.response?.status === 'streaming') {
        hasStreaming = true;
        break;
      }
    }

    if (!hasStreaming) {
      return [...turnResponses];
    }

    const now = Date.now();
    return turnResponses.map((turn) => {
      if (turn?.response?.status !== 'streaming') {
        return turn;
      }

      return {
        ...turn,
        updatedAt: now,
        response: {
          ...turn.response,
          status: fallbackStatus,
          updatedAt: now,
        },
      };
    });
  }

  private isToolBearingPart(part: ChatPart): boolean {
    return part.type === 'tool_call';
  }

  private resolveTerminalTurnResponseStatus(): Exclude<TurnResponseStatus, 'streaming'> {
    if (this.ctx.isCancelled) {
      return 'cancelled';
    }

    const currentTurnId = this._currentTurnId;
    const turnResponses = this.readCurrentTurnResponses?.();
    if (!currentTurnId || !Array.isArray(turnResponses)) {
      return 'completed';
    }

    const currentTurn = turnResponses.find(turn => turn?.turnId === currentTurnId);
    if (currentTurn?.response?.status === 'error') {
      return 'error';
    }

    return 'completed';
  }
}

function normalizeTurnId(turnId: unknown): string {
  return typeof turnId === 'string' ? turnId.trim() : '';
}

