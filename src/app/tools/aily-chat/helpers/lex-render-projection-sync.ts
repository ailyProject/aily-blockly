import type { IChatViewAccess } from '../core/chat-context';
import {
  type IncrementalTurnResponsePartSource,
} from '../core/turn-response-host-projection-builder';
import type { TurnResponseTurn } from 'aily-lex/browser';

import { ChatPerformanceTracer } from '../services/chat-perf-tracer';
import type {
  CanonicalRenderItemStatus,
  CanonicalRenderLifecycleEvent,
} from '../core/render-event-item-lifecycle';
import { CanonicalRenderPayloadProjector } from '../core/canonical-render-payload-projector';

type LexRenderProjectionSyncContext = Pick<
  IChatViewAccess,
  'partStore' | 'invalidateHostRequestGraph' | 'triggerSyncDetectChanges'
>;

type RenderProjectionVisibilityAccess = {
  readProjectionSessionResource?(): string | null | undefined;
  readProjectionVisibleAttachmentGeneration?(): number | null | undefined;
  isRuntimeViewAttached?(sessionId: string | null | undefined): boolean;
  isRuntimeViewAttachmentCurrent?(
    sessionId: string | null | undefined,
    generation: number | null | undefined,
  ): boolean;
};

type ViewRefreshHandle = {
  dispose(): void;
};

export class LexRenderProjectionSync {
  private readonly _canonicalPayloadProjector: CanonicalRenderPayloadProjector;
  private _viewRefreshHandle: ViewRefreshHandle | null = null;
  private _viewRefreshPending = false;

  constructor(
    private readonly ctx: LexRenderProjectionSyncContext,
    private readonly visibility: RenderProjectionVisibilityAccess = {},
  ) {
    this._canonicalPayloadProjector = new CanonicalRenderPayloadProjector(ctx.partStore);
  }

  projectCanonicalChanges(
    currentTurn: Pick<TurnResponseTurn, 'turnId' | 'response'> | null,
    _source: IncrementalTurnResponsePartSource,
    lifecycleEvents: readonly CanonicalRenderLifecycleEvent[],
    options: {
      syncContent?: boolean;
      applyTurnCompletion?: boolean;
    } = {},
  ): void {
    this.syncProjectedMessageMeta(currentTurn);
    this.applyCanonicalLifecycleEvents(currentTurn, lifecycleEvents, {
      applyTurnCompletion: options.applyTurnCompletion,
    });
  }

  projectCanonicalLifecycleOnly(
    currentTurn: Pick<TurnResponseTurn, 'turnId'> | null,
    events: readonly CanonicalRenderLifecycleEvent[],
    options: { applyTurnCompletion?: boolean } = {},
  ): void {
    this.applyCanonicalLifecycleEvents(currentTurn, events, options);
  }

  private applyCanonicalLifecycleEvents(
    currentTurn: Pick<TurnResponseTurn, 'turnId'> | null,
    events: readonly CanonicalRenderLifecycleEvent[],
    options: { applyTurnCompletion?: boolean } = {},
  ): void {
    if (!events.length || !this.canProjectToVisible()) {
      return;
    }

    const handle = this.resolveCanonicalResponseHandle(currentTurn);
    if (!handle) {
      return;
    }

    let changed = false;
    const lifecycleStartedAt = performance.now();
    changed = this._canonicalPayloadProjector.project(handle, events) || changed;

    for (const event of events) {
      if (event.type === 'itemCompleted') {
        if (event.itemKind === 'thinking') {
          this.ctx.partStore.completeThinkingHandle(handle, event.scope);
          changed = true;
        } else if (event.itemKind === 'tool') {
          const toolCallId = parseLifecycleToolCallId(event.itemId);
          if (toolCallId) {
            changed = this.ctx.partStore.patchToolCallForHandle(handle, toolCallId, {
              state: toToolCallState(event.status),
            }) || changed;
          }
        } else if (event.itemKind === 'state') {
          const stateId = parseLifecycleStateId(event.itemId);
          if (stateId) {
            changed = this.ctx.partStore.patchStateForHandle(handle, stateId, {
              state: toStatePartState(event.status),
            }) || changed;
          }
        } else if (event.itemKind === 'confirmation') {
          const confirmationPartId = parseLifecycleConfirmationPartId(event.itemId);
          if (confirmationPartId) {
            changed = this.ctx.partStore.updateConfirmationResultForHandle(handle, confirmationPartId, {
              resolved: true,
              result: event.status === 'cancelled' ? 'rejected' : 'approved',
            }) || changed;
          }
        } else if (event.itemKind === 'plan') {
          changed = this.ctx.partStore.completePlanPartForHandle(
            handle,
            `canonical:plan:${event.itemId}`,
            event.status === 'failed' ? 'failed' : 'completed',
          ) || changed;
        } else if (event.itemKind === 'terminal') {
          const terminalIdentity = parseLifecycleTerminalIdentity(event.itemId);
          if (terminalIdentity) {
            changed = this.ctx.partStore.patchTerminalForHandle(handle, terminalIdentity, {
              isRunning: false,
              status: event.status === 'failed' ? 'failed' : event.status === 'cancelled' ? 'killed' : 'completed',
            }) || changed;
          }
        } else if (event.itemKind === 'subagent') {
          const subagentScope = parseLifecycleSubagentScope(event.itemId);
          if (subagentScope) {
            this.ctx.partStore.finalizeSubagentScopedPartsForHandle(handle, subagentScope, {
              status: toRunningPartFinalizeStatus(event.status),
            });
            changed = true;
          }
        }
        continue;
      }

      if (event.type === 'turnCompleted' && options.applyTurnCompletion === true) {
        this.ctx.partStore.finalizeRunningPartsForHandle(handle, {
          status: toRunningPartFinalizeStatus(event.status),
        });
        changed = true;
      }
    }

    ChatPerformanceTracer.recordDuration(
      'visible_lifecycle_projection',
      performance.now() - lifecycleStartedAt,
      `events=${events.length},changed=${changed}`,
      { slowThresholdMs: 8 },
    );

    if (changed) {
      this.scheduleViewRefresh();
    }
  }

  clearProjectedMessage(currentTurn: Pick<TurnResponseTurn, 'turnId'> | null): void {
    if (!this.canProjectToVisible()) {
      return;
    }

    const handle = this.resolveCanonicalResponseHandle(currentTurn);
    if (!handle) {
      return;
    }

    this.ctx.partStore.clearMessageHandle(handle);
    this.scheduleViewRefresh();
  }

  syncProjectedMessageMeta(currentTurn: Pick<TurnResponseTurn, 'turnId' | 'response'> | null): void {
    if (currentTurn && this.canProjectToVisible()) {
      this.scheduleViewRefresh();
    }
  }

  dispose(): void {
    this.clearPendingViewRefresh();
  }

  private scheduleViewRefresh(): void {
    this._viewRefreshPending = true;
    if (this._viewRefreshHandle !== null) {
      return;
    }

    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? (callback: () => void) => {
        const frameId = globalThis.requestAnimationFrame(callback);
        return {
          dispose: () => globalThis.cancelAnimationFrame?.(frameId),
        };
      }
      : (callback: () => void) => {
        const timerId = setTimeout(callback, 16);
        return {
          dispose: () => clearTimeout(timerId),
        };
      };

    this._viewRefreshHandle = schedule(() => {
      const refreshStartedAt = performance.now();
      this._viewRefreshHandle = null;
      if (!this._viewRefreshPending) {
        return;
      }
      this._viewRefreshPending = false;
      this.ctx.invalidateHostRequestGraph();
      this.ctx.triggerSyncDetectChanges();
      ChatPerformanceTracer.recordDuration('visible_view_refresh', performance.now() - refreshStartedAt, undefined, {
        slowThresholdMs: 12,
      });
    });
  }

  private clearPendingViewRefresh(): void {
    this._viewRefreshHandle?.dispose();
    this._viewRefreshHandle = null;
    this._viewRefreshPending = false;
  }

  private resolveCanonicalResponseHandle(
    currentTurn: Pick<TurnResponseTurn, 'turnId'> | null,
  ) {
    const turnId = normalizeSessionResource(currentTurn?.turnId);
    return turnId ? this.ctx.partStore.createResponseHandle(turnId) : null;
  }

  private canProjectToVisible(): boolean {
    const readProjectionSessionResource = this.visibility.readProjectionSessionResource;
    const projectionSessionResource = normalizeSessionResource(readProjectionSessionResource?.());
    if (!projectionSessionResource) {
      return true;
    }

    const isRuntimeViewAttached = this.visibility.isRuntimeViewAttached;
    if (typeof isRuntimeViewAttached === 'function' && !isRuntimeViewAttached(projectionSessionResource)) {
      return false;
    }

    const isRuntimeViewAttachmentCurrent = this.visibility.isRuntimeViewAttachmentCurrent;
    if (typeof isRuntimeViewAttachmentCurrent !== 'function') {
      return true;
    }

    const expectedGeneration = normalizeVisibleAttachmentGeneration(
      this.visibility.readProjectionVisibleAttachmentGeneration?.(),
    );
    if (expectedGeneration === null) {
      return false;
    }

    return isRuntimeViewAttachmentCurrent(projectionSessionResource, expectedGeneration);
  }
}

function normalizeVisibleAttachmentGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function parseLifecycleToolCallId(itemId: string): string | null {
  const marker = ':tool:';
  const markerIndex = itemId.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const toolCallId = itemId.slice(markerIndex + marker.length).trim();
  return toolCallId || null;
}

function parseLifecycleStateId(itemId: string): string | null {
  const statePrefixes = ['state:', 'background:', 'todo:'];
  for (const prefix of statePrefixes) {
    if (itemId.startsWith(prefix)) {
      const stateId = itemId.slice(prefix.length).trim();
      return stateId || null;
    }
  }
  return null;
}

function parseLifecycleConfirmationPartId(itemId: string): string | null {
  const marker = ':approval:';
  const markerIndex = itemId.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const askId = itemId.slice(markerIndex + marker.length).trim();
    return askId ? `confirmation:${askId}` : null;
  }

  const directPrefix = 'confirmation:';
  if (itemId.startsWith(directPrefix)) {
    return itemId.trim() || null;
  }

  return null;
}

function parseLifecycleTerminalIdentity(itemId: string): { partId: string; processId?: string; outputSessionId?: string; terminalId?: string } | null {
  const trimmed = itemId.trim();
  if (!trimmed.startsWith('terminal:')) {
    return null;
  }
  const sessionId = trimmed.slice('terminal:'.length).trim();
  if (!sessionId) {
    return null;
  }
  return {
    partId: `canonical:terminal:${trimmed}`,
    processId: sessionId,
    outputSessionId: sessionId,
    terminalId: sessionId,
  };
}

function parseLifecycleSubagentScope(itemId: string): { subAgentInvocationId: string; parentToolCallId: string; toolCallId: string } | null {
  const trimmed = itemId.trim();
  if (!trimmed.startsWith('subagent:')) {
    return null;
  }
  const id = trimmed.slice('subagent:'.length).trim();
  if (!id) {
    return null;
  }
  return {
    subAgentInvocationId: id,
    parentToolCallId: id,
    toolCallId: id,
  };
}

function toToolCallState(status: CanonicalRenderItemStatus): 'done' | 'warn' | 'error' {
  if (status === 'failed') {
    return 'error';
  }
  if (status === 'cancelled') {
    return 'warn';
  }
  return 'done';
}

function toStatePartState(status: CanonicalRenderItemStatus): 'done' | 'warn' | 'error' {
  if (status === 'failed') {
    return 'error';
  }
  if (status === 'cancelled') {
    return 'warn';
  }
  return 'done';
}

function toRunningPartFinalizeStatus(status: CanonicalRenderItemStatus): 'completed' | 'cancelled' | 'error' {
  if (status === 'failed') {
    return 'error';
  }
  if (status === 'cancelled') {
    return 'cancelled';
  }
  return 'completed';
}

function normalizeSessionResource(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}
