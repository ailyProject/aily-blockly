import type { TurnResponseTurn } from 'aily-lex/browser';
import {
  buildDialogTurnContext,
  type DialogTurnContext,
} from '../core/user-turn-action-target';
import { AilyHost } from '../core/host';
import type {
  WorkspaceCheckpointAvailabilityDetail,
  WorkspaceCheckpointPresentationMode,
} from '../services/edit-checkpoint.service';
import type { EditActionsHelper } from './edit-actions.helper';
import {
  canRedoSessionCheckpointTimeline,
  type SessionCheckpointTimelineEntry,
  type SessionCheckpointTimelineState,
} from './session-checkpoint-timeline-model';

export interface ChatSessionBoundaryActionController {
  regenerateTurn(target?: DialogTurnContext | null): Promise<void> | void;
  redoEdits(): Promise<void> | void;
  restoreCheckpoint(target: DialogTurnContext): Promise<boolean | void> | boolean | void;
  forkSession(target: DialogTurnContext): Promise<boolean | void> | boolean | void;
}

export type ChatSessionBoundaryBlockedAction = 'redoCheckpoint' | 'restoreCheckpoint' | 'forkSession';
export type ChatSessionBoundaryUnavailableAction = ChatSessionBoundaryBlockedAction;

export interface ChatSessionBoundaryUnavailableReason {
  readonly action: ChatSessionBoundaryUnavailableAction;
  readonly reason:
    | 'session-unavailable'
    | 'workspace-checkpoint-unavailable'
    | 'checkpoint-unavailable'
    | 'checkpoint-session-mismatch';
  readonly checkpointId?: string;
  readonly workspaceCheckpointDetail?: WorkspaceCheckpointAvailabilityDetail;
}

export interface ChatSessionBoundaryControllerContext {
  isBoundaryRewriteInProgress?(): boolean;
  warnBoundaryRewriteBlocked?(action: ChatSessionBoundaryBlockedAction): void;
  readCurrentSessionResource?(): string | null | undefined;
  readSessionCheckpointTimelineState?(sessionResource: string): SessionCheckpointTimelineState | null | undefined;
  readSessionTurnResponses?(sessionResource: string): readonly TurnResponseTurn[];
  getWorkspaceCheckpointPresentationMode?(): WorkspaceCheckpointPresentationMode;
  ensureWorkspaceCheckpointPresentationMode?(): Promise<WorkspaceCheckpointPresentationMode> | WorkspaceCheckpointPresentationMode;
  getWorkspaceCheckpointAvailabilityDetail?(): WorkspaceCheckpointAvailabilityDetail | null | undefined;
  warnBoundaryActionUnavailable?(reason: ChatSessionBoundaryUnavailableReason): void;
  logBoundaryDiagnostic?(message: string): void;
}

/**
 * Single UI-facing owner for actions that rewrite chat/session history.
 *
 * The implementation still delegates to the existing edit helper while the
 * transaction internals are moved under this owner.
 */
export class ChatSessionBoundaryController implements ChatSessionBoundaryActionController {
  constructor(
    private readonly editActions: EditActionsHelper,
    private readonly ctx: ChatSessionBoundaryControllerContext = {},
  ) {}

  regenerateTurn(target?: DialogTurnContext | null): Promise<void> | void {
    return this.editActions.regenerateTurn(target);
  }

  async redoEdits(): Promise<void> {
    if (this.isBoundaryRewriteBlocked('redoCheckpoint')) {
      return;
    }
    if (!await this.canRunRedoCheckpointBoundary()) {
      return;
    }
    await this.editActions.redoEdits();
  }

  async restoreCheckpoint(target: DialogTurnContext): Promise<boolean | void> {
    if (this.isBoundaryRewriteBlocked('restoreCheckpoint')) {
      return false;
    }
    const resolved = await this.resolveRestoreCheckpointBoundary(target);
    if (!resolved) {
      return false;
    }
    return await this.editActions.restoreToCheckpoint(resolved.target);
  }

  async forkSession(target: DialogTurnContext): Promise<boolean | void> {
    if (this.isBoundaryRewriteBlocked('forkSession')) {
      return false;
    }
    const resolved = await this.resolveForkBoundary(target);
    if (!resolved) {
      return false;
    }
    return await this.editActions.forkSessionFromTurn(resolved.target);
  }

  private isBoundaryRewriteBlocked(action: ChatSessionBoundaryBlockedAction): boolean {
    if (this.ctx.isBoundaryRewriteInProgress?.() !== true) {
      return false;
    }

    this.ctx.warnBoundaryRewriteBlocked?.(action);
    return true;
  }

  private async canRunRedoCheckpointBoundary(): Promise<boolean> {
    const sessionResource = this.resolveCurrentSessionResource();
    if (!sessionResource) {
      return this.blockUnavailable({ action: 'redoCheckpoint', reason: 'session-unavailable' });
    }

    const timelineState = this.ctx.readSessionCheckpointTimelineState?.(sessionResource) ?? null;
    if (!canRedoSessionCheckpointTimeline(timelineState)) {
      return this.blockUnavailable({ action: 'redoCheckpoint', reason: 'checkpoint-unavailable' });
    }

    if (!await this.isWorkspaceCheckpointAvailable('redoCheckpoint')) {
      return false;
    }

    const nextCheckpoint = timelineState!.checkpoints[timelineState!.currentCheckpointIndex + 1];
    return this.hasTimelineCheckpointBoundary(
      'redoCheckpoint',
      sessionResource,
      nextCheckpoint?.checkpointId,
    );
  }

  private async resolveRestoreCheckpointBoundary(
    target: DialogTurnContext,
  ): Promise<{ checkpointId: string; target: DialogTurnContext } | null> {
    const sessionResource = this.resolveCurrentSessionResource();
    if (!sessionResource) {
      this.blockUnavailable({ action: 'restoreCheckpoint', reason: 'session-unavailable' });
      return null;
    }

    if (!await this.isWorkspaceCheckpointAvailable('restoreCheckpoint')) {
      return null;
    }

    const resolved = this.resolveTargetCheckpoint(sessionResource, target);
    if (!this.hasTimelineCheckpointBoundary('restoreCheckpoint', sessionResource, resolved?.checkpointId)) {
      return null;
    }

    return resolved;
  }

  private async resolveForkBoundary(
    target: DialogTurnContext,
  ): Promise<{ checkpointId: string | null; target: DialogTurnContext } | null> {
    const sessionResource = this.resolveCurrentSessionResource();
    if (!sessionResource) {
      this.blockUnavailable({ action: 'forkSession', reason: 'session-unavailable' });
      return null;
    }

    if (!await this.isWorkspaceCheckpointAvailable('forkSession')) {
      return null;
    }

    const timelineState = this.ctx.readSessionCheckpointTimelineState?.(sessionResource) ?? null;
    const resolved = this.resolveTargetCheckpoint(sessionResource, target);
    const resolvedTarget = resolved?.target ?? target;
    const targetTurnId = normalizeString(resolvedTarget.turnId);
    const targetIndex = timelineState?.turnResponses.findIndex(turn => normalizeString(turn.turnId) === targetTurnId) ?? -1;
    if (!timelineState || targetIndex < 0) {
      return { checkpointId: resolved?.checkpointId ?? null, target: resolvedTarget };
    }

    return { checkpointId: resolved?.checkpointId ?? null, target: resolvedTarget };
  }

  private async isWorkspaceCheckpointAvailable(action: ChatSessionBoundaryUnavailableAction): Promise<boolean> {
    const mode = await Promise.resolve(
      this.ctx.ensureWorkspaceCheckpointPresentationMode?.()
        ?? this.ctx.getWorkspaceCheckpointPresentationMode?.()
        ?? 'unknown',
    );
    if (mode === 'git' || mode === 'timeline') {
      return true;
    }
    if (this.hasCurrentSessionTimelineCheckpointBoundary()) {
      return true;
    }
    return this.blockUnavailable({
      action,
      reason: 'workspace-checkpoint-unavailable',
      workspaceCheckpointDetail: this.ctx.getWorkspaceCheckpointAvailabilityDetail?.() ?? undefined,
    });
  }

  private hasCurrentSessionTimelineCheckpointBoundary(): boolean {
    if (this.hasOpenProjectWorkspace()) {
      return false;
    }

    const sessionResource = this.resolveCurrentSessionResource();
    if (!sessionResource) {
      return false;
    }

    const timelineState = this.ctx.readSessionCheckpointTimelineState?.(sessionResource) ?? null;
    return normalizeString(timelineState?.sessionResource) === sessionResource
      && (timelineState?.checkpoints.length ?? 0) > 0;
  }

  private hasOpenProjectWorkspace(): boolean {
    try {
      const currentProjectPath = AilyHost.get().project?.currentProjectPath;
      return typeof currentProjectPath === 'string' && currentProjectPath.trim().length > 0;
    } catch {
      return false;
    }
  }

  private hasTimelineCheckpointBoundary(
    action: ChatSessionBoundaryUnavailableAction,
    sessionResource: string,
    checkpointId: string | null | undefined,
  ): boolean {
    const normalizedCheckpointId = normalizeString(checkpointId);
    if (!normalizedCheckpointId) {
      return this.blockUnavailable({ action, reason: 'checkpoint-unavailable' });
    }

    const timelineState = this.ctx.readSessionCheckpointTimelineState?.(sessionResource) ?? null;
    if (normalizeString(timelineState?.sessionResource) !== sessionResource) {
      return this.blockUnavailable({
        action,
        reason: 'checkpoint-session-mismatch',
        checkpointId: normalizedCheckpointId,
      });
    }

    if (!findTimelineCheckpointByCheckpointId(timelineState, normalizedCheckpointId)) {
      return this.blockUnavailable({ action, reason: 'checkpoint-unavailable', checkpointId: normalizedCheckpointId });
    }

    return true;
  }

  private resolveTargetCheckpoint(
    sessionResource: string,
    target: DialogTurnContext,
  ): { checkpointId: string; target: DialogTurnContext } | null {
    const timelineState = this.ctx.readSessionCheckpointTimelineState?.(sessionResource) ?? null;
    const turnResponses = timelineState?.turnResponses?.length
      ? timelineState.turnResponses
      : this.ctx.readSessionTurnResponses?.(sessionResource) ?? [];
    const checkpointIdFromTarget = readCheckpointIdFromTarget(target);
    const targetTurnId = normalizeString(target.turnId);
    const checkpoint = checkpointIdFromTarget
      ? findTimelineCheckpointByCheckpointId(timelineState, checkpointIdFromTarget)
      : findTimelineCheckpointByTurnId(timelineState, targetTurnId);
    const checkpointId = checkpointIdFromTarget
      || normalizeString(checkpoint?.checkpointId)
      || findTurnCheckpointId(turnResponses, targetTurnId);
    if (!checkpointId) {
      this.ctx.logBoundaryDiagnostic?.(
        `target-checkpoint-missing; session=${sessionResource}; targetTurnId=${targetTurnId || 'none'}; `
        + `targetCheckpointId=${checkpointIdFromTarget || 'none'}; `
        + `timeline=${summarizeCheckpointTimeline(timelineState)}; `
        + `turns=${summarizeCheckpointTurnResponses(turnResponses)}`,
      );
      return null;
    }

    const canonicalTurn = findCanonicalCheckpointTurn(turnResponses, {
      checkpointId,
      requestId: checkpoint?.requestId,
      turnId: checkpoint?.turnId ?? targetTurnId,
    });
    const canonicalTarget = canonicalTurn
      ? buildDialogTurnContext({
          turnResponse: canonicalTurn,
          requestDisabled: target.requestDisabled,
          requestContent: target.requestContent ?? canonicalTurn.request?.content,
          displayContent: target.displayContent
            ?? canonicalTurn.request?.displayContent
            ?? canonicalTurn.request?.content,
        }) ?? target
      : target;

    return { checkpointId, target: canonicalTarget };
  }

  private resolveCurrentSessionResource(): string {
    return normalizeString(this.ctx.readCurrentSessionResource?.());
  }

  private blockUnavailable(reason: ChatSessionBoundaryUnavailableReason): false {
    this.ctx.logBoundaryDiagnostic?.(
      `blocked action=${reason.action}; reason=${reason.reason}; checkpointId=${reason.checkpointId ?? 'none'}; `
      + `workspaceMode=${reason.workspaceCheckpointDetail?.mode ?? 'unknown'}; `
      + `workspaceReason=${reason.workspaceCheckpointDetail?.reason ?? 'none'}; `
      + `workspaceMessage=${reason.workspaceCheckpointDetail?.message ?? ''}`,
    );
    this.ctx.warnBoundaryActionUnavailable?.(reason);
    return false;
  }
}

function readCheckpointIdFromTarget(target: DialogTurnContext | null | undefined): string | null {
  const requestMetadata = target?.request?.metadata ?? target?.turnResponse?.request?.metadata;
  if (!requestMetadata || typeof requestMetadata !== 'object') {
    return null;
  }

  const checkpointId = (requestMetadata as Record<string, unknown>)['checkpointId'];
  return normalizeString(checkpointId);
}

function findTimelineCheckpointByCheckpointId(
  state: SessionCheckpointTimelineState | null | undefined,
  checkpointId: string,
): SessionCheckpointTimelineEntry | undefined {
  const normalizedCheckpointId = normalizeString(checkpointId);
  return normalizedCheckpointId
    ? state?.checkpoints.find(entry => normalizeString(entry.checkpointId) === normalizedCheckpointId)
    : undefined;
}

function findTimelineCheckpointByTurnId(
  state: SessionCheckpointTimelineState | null | undefined,
  turnId: string,
): SessionCheckpointTimelineEntry | undefined {
  const normalizedTurnId = normalizeString(turnId);
  return normalizedTurnId
    ? state?.checkpoints.find(entry => isCheckpointForTurn(entry, normalizedTurnId))
    : undefined;
}

function isCheckpointForTurn(entry: SessionCheckpointTimelineEntry, turnId: string): boolean {
  return !!turnId && normalizeString(entry.turnId) === turnId;
}

function findTurnCheckpointId(
  turnResponses: readonly TurnResponseTurn[],
  turnId: string,
): string | null {
  const normalizedTurnId = normalizeString(turnId);
  if (!normalizedTurnId) {
    return null;
  }
  const turn = turnResponses.find(candidate => normalizeString(candidate.turnId) === normalizedTurnId);
  return normalizeString(turn?.request?.metadata?.checkpointId);
}

function findCanonicalCheckpointTurn(
  turnResponses: readonly TurnResponseTurn[],
  identity: {
    readonly checkpointId?: string | null;
    readonly requestId?: string | null;
    readonly turnId?: string | null;
  },
): TurnResponseTurn | undefined {
  const checkpointId = normalizeString(identity.checkpointId);
  if (checkpointId) {
    const turn = turnResponses.find(candidate => normalizeString(candidate.request?.metadata?.checkpointId) === checkpointId);
    if (turn) {
      return turn;
    }
  }

  const turnId = normalizeString(identity.turnId);
  if (turnId) {
    const turn = turnResponses.find(candidate => normalizeString(candidate.turnId) === turnId);
    if (turn) {
      return turn;
    }
  }

  const requestId = normalizeString(identity.requestId);
  if (requestId) {
    return turnResponses.find(candidate => normalizeString(candidate.request?.metadata?.['requestId']) === requestId);
  }

  return undefined;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function summarizeCheckpointTimeline(state: SessionCheckpointTimelineState | null | undefined): string {
  if (!state) {
    return '<none>';
  }
  const checkpointSummary = state.checkpoints
    .map(checkpoint => [
      checkpoint.turnIndex,
      checkpoint.turnId ?? '<no-turn>',
      checkpoint.requestId || '<no-request>',
      checkpoint.checkpointId || '<no-checkpoint>',
    ].join(':'))
    .join(',');
  return `current=${state.currentCheckpointIndex}/${state.currentTurnResponseCount}; checkpoints=[${checkpointSummary}]`;
}

function summarizeCheckpointTurnResponses(turnResponses: readonly TurnResponseTurn[]): string {
  return turnResponses
    .map((turn, index) => [
      index,
      turn.turnId || '<no-turn>',
      normalizeString(turn.request?.metadata?.['requestId']) || '<no-request>',
      normalizeString(turn.request?.metadata?.['checkpointId']) || '<no-checkpoint>',
    ].join(':'))
    .join(',');
}
