import {
  type DialogTurnContext,
} from '../core/user-turn-action-target';
import type {
  ChatRuntimeHostCheckpointNavigationRequest,
  ChatRuntimeHostCheckpointNavigationState,
} from '../core/chat-runtime-host-contract';
import type { EditActionsHelper } from './edit-actions.helper';

export interface ChatSessionBoundaryActionController {
  regenerateTurn(target?: DialogTurnContext | null): Promise<void> | void;
  undoEdits(sessionResource?: string): Promise<void> | void;
  redoFileEdits(sessionResource?: string): Promise<void> | void;
  redoEdits(sessionResource?: string): Promise<void> | void;
  restoreCheckpoint(target: DialogTurnContext, sessionResource?: string): Promise<boolean | void> | boolean | void;
  forkSession(target: DialogTurnContext, sessionResource?: string): Promise<boolean | void> | boolean | void;
}

export type ChatSessionBoundaryBlockedAction =
  | 'undoEditingSession'
  | 'redoEditingSession'
  | 'redoCheckpoint'
  | 'restoreCheckpoint'
  | 'forkSession';
export type ChatSessionBoundaryUnavailableAction = ChatSessionBoundaryBlockedAction;

export interface ChatSessionBoundaryUnavailableReason {
  readonly action: ChatSessionBoundaryUnavailableAction;
  readonly reason:
    | 'session-unavailable'
    | 'checkpoint-unavailable'
    | 'checkpoint-session-mismatch';
  readonly checkpointId?: string;
}

export interface ChatSessionBoundaryControllerContext {
  isBoundaryRewriteInProgress?(): boolean;
  warnBoundaryRewriteBlocked?(action: ChatSessionBoundaryBlockedAction): void;
  readCurrentSessionResource?(): string | null | undefined;
  readCheckpointNavigationState?(
    request: ChatRuntimeHostCheckpointNavigationRequest,
  ): Promise<ChatRuntimeHostCheckpointNavigationState | null>;
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

  async regenerateTurn(target?: DialogTurnContext | null): Promise<void> {
    await this.editActions.regenerateTurn(target);
  }

  async undoEdits(explicitSessionResource?: string): Promise<void> {
    if (this.isBoundaryRewriteBlocked('undoEditingSession')) {
      return;
    }
    const sessionResource = this.resolveActionSessionResource(explicitSessionResource);
    this.traceActionSession('undoEditingSession', explicitSessionResource, sessionResource);
    if (!sessionResource) {
      this.blockUnavailable({ action: 'undoEditingSession', reason: 'session-unavailable' });
      return;
    }
    await this.editActions.undoLastEdit({ sessionResource });
  }

  async redoFileEdits(explicitSessionResource?: string): Promise<void> {
    if (this.isBoundaryRewriteBlocked('redoEditingSession')) {
      return;
    }
    const sessionResource = this.resolveActionSessionResource(explicitSessionResource);
    this.traceActionSession('redoEditingSession', explicitSessionResource, sessionResource);
    if (!sessionResource) {
      this.blockUnavailable({ action: 'redoEditingSession', reason: 'session-unavailable' });
      return;
    }
    await this.editActions.redoLastEdit({ sessionResource });
  }

  async redoEdits(explicitSessionResource?: string): Promise<void> {
    if (this.isBoundaryRewriteBlocked('redoCheckpoint')) {
      return;
    }
    const sessionResource = this.resolveActionSessionResource(explicitSessionResource);
    this.traceActionSession('redoCheckpoint', explicitSessionResource, sessionResource);
    if (!sessionResource) {
      this.blockUnavailable({ action: 'redoCheckpoint', reason: 'session-unavailable' });
      return;
    }
    // Match VS Code's redoInteraction boundary: the UI submits only the redo
    // intent. The canonical host owns the timeline cursor and selects the next
    // checkpoint atomically with the workspace/response-model transaction.
    await this.editActions.redoEdits({ sessionResource });
  }

  async restoreCheckpoint(target: DialogTurnContext, explicitSessionResource?: string): Promise<boolean | void> {
    if (this.isBoundaryRewriteBlocked('restoreCheckpoint')) {
      return false;
    }
    const sessionResource = this.resolveActionSessionResource(explicitSessionResource);
    this.traceActionSession('restoreCheckpoint', explicitSessionResource, sessionResource, target);
    if (!sessionResource) {
      return this.blockUnavailable({ action: 'restoreCheckpoint', reason: 'session-unavailable' });
    }
    const resolved = await this.resolveRestoreCheckpointBoundary(sessionResource, target);
    if (!resolved) {
      return false;
    }
    return await this.editActions.restoreToCheckpoint(resolved.target, {
      sessionResource,
      checkpointId: resolved.checkpointId,
    });
  }

  async forkSession(target: DialogTurnContext, explicitSessionResource?: string): Promise<boolean | void> {
    if (this.isBoundaryRewriteBlocked('forkSession')) {
      return false;
    }
    const sessionResource = this.resolveActionSessionResource(explicitSessionResource);
    this.traceActionSession('forkSession', explicitSessionResource, sessionResource, target);
    if (!sessionResource) {
      return this.blockUnavailable({ action: 'forkSession', reason: 'session-unavailable' });
    }
    const resolved = await this.resolveForkBoundary(sessionResource, target);
    if (!resolved) {
      return false;
    }
    return await this.editActions.forkSessionFromTurn(resolved.target, { sessionResource });
  }

  private isBoundaryRewriteBlocked(action: ChatSessionBoundaryBlockedAction): boolean {
    if (this.ctx.isBoundaryRewriteInProgress?.() !== true) {
      return false;
    }

    this.ctx.warnBoundaryRewriteBlocked?.(action);
    return true;
  }

  private async resolveRestoreCheckpointBoundary(
    sessionResource: string,
    target: DialogTurnContext,
  ): Promise<{ checkpointId: string; target: DialogTurnContext } | null> {
    const resolved = await this.resolveTargetCheckpoint(sessionResource, target);
    if (!resolved) {
      return null;
    }
    return resolved;
  }

  private async resolveForkBoundary(
    sessionResource: string,
    target: DialogTurnContext,
  ): Promise<{ checkpointId: string | null; target: DialogTurnContext } | null> {
    return { checkpointId: readCheckpointIdFromTarget(target), target };
  }

  private async resolveTargetCheckpoint(
    sessionResource: string,
    target: DialogTurnContext,
  ): Promise<{
    checkpointId: string;
    target: DialogTurnContext;
    navigation: ChatRuntimeHostCheckpointNavigationState;
  } | null> {
    const checkpointIdFromTarget = readCheckpointIdFromTarget(target);
    const targetTurnId = normalizeString(target.turnId);
    if (!checkpointIdFromTarget && !targetTurnId) {
      this.ctx.logBoundaryDiagnostic?.(
        `target-identity-missing; session=${sessionResource}; targetTurnId=none; `
        + 'targetCheckpointId=none',
      );
      return null;
    }
    const navigation = await this.readCheckpointNavigationState({
      sessionId: sessionResource,
      ...(checkpointIdFromTarget
        ? { checkpointId: checkpointIdFromTarget }
        : { turnId: targetTurnId }),
    });
    if (!navigation?.requestedCheckpoint) {
      this.blockUnavailable({
        action: 'restoreCheckpoint',
        reason: 'checkpoint-unavailable',
        checkpointId: checkpointIdFromTarget || undefined,
      });
      return null;
    }
    return {
      checkpointId: navigation.requestedCheckpoint.checkpointId,
      target,
      navigation,
    };
  }

  private async readCheckpointNavigationState(
    request: ChatRuntimeHostCheckpointNavigationRequest,
  ): Promise<ChatRuntimeHostCheckpointNavigationState | null> {
    return await this.ctx.readCheckpointNavigationState?.(request) ?? null;
  }

  private resolveCurrentSessionResource(): string {
    return normalizeString(this.ctx.readCurrentSessionResource?.());
  }

  private resolveActionSessionResource(explicitSessionResource?: string | null): string {
    return normalizeString(explicitSessionResource) || this.resolveCurrentSessionResource();
  }

  private traceActionSession(
    action: ChatSessionBoundaryUnavailableAction,
    explicitSessionResource: string | null | undefined,
    resolvedSessionResource: string,
    target?: DialogTurnContext,
  ): void {
    console.info('[AilyChat][CheckpointActionSessionTrace]', {
      action,
      rowSessionResource: normalizeString(explicitSessionResource) || null,
      currentViewSessionResource: this.resolveCurrentSessionResource() || null,
      resolvedSessionResource: resolvedSessionResource || null,
      turnId: normalizeString(target?.turnId) || null,
      checkpointId: readCheckpointIdFromTarget(target) || null,
    });
  }

  private blockUnavailable(reason: ChatSessionBoundaryUnavailableReason): false {
    this.ctx.logBoundaryDiagnostic?.(
      `blocked action=${reason.action}; reason=${reason.reason}; checkpointId=${reason.checkpointId ?? 'none'}; `
      + `session=${this.resolveCurrentSessionResource() || 'none'}`,
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

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

