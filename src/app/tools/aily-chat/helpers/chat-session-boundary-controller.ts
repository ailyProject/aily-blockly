import {
  type DialogTurnContext,
} from '../core/user-turn-action-target';
import type {
  ChatRuntimeHostCheckpointNavigationRequest,
  ChatRuntimeHostCheckpointNavigationState,
} from '../core/chat-runtime-host-contract';
import { AilyHost } from '../core/host';
import type {
  WorkspaceCheckpointAvailabilityDetail,
  WorkspaceCheckpointPresentationMode,
} from '../services/edit-checkpoint.service';
import type { EditActionsHelper } from './edit-actions.helper';

export interface ChatSessionBoundaryActionController {
  regenerateTurn(target?: DialogTurnContext | null): Promise<void> | void;
  redoEdits(sessionResource?: string): Promise<void> | void;
  restoreCheckpoint(target: DialogTurnContext, sessionResource?: string): Promise<boolean | void> | boolean | void;
  forkSession(target: DialogTurnContext, sessionResource?: string): Promise<boolean | void> | boolean | void;
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
  readCheckpointNavigationState?(
    request: ChatRuntimeHostCheckpointNavigationRequest,
  ): Promise<ChatRuntimeHostCheckpointNavigationState | null>;
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

  async regenerateTurn(target?: DialogTurnContext | null): Promise<void> {
    await this.editActions.regenerateTurn(target);
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
    const navigation = await this.canRunRedoCheckpointBoundary(sessionResource);
    if (!navigation) {
      return;
    }
    await this.editActions.redoEdits(navigation.nextCheckpoint!.checkpointId, { sessionResource });
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

  private async canRunRedoCheckpointBoundary(
    explicitSessionResource?: string,
  ): Promise<ChatRuntimeHostCheckpointNavigationState | null> {
    const sessionResource = this.resolveActionSessionResource(explicitSessionResource);
    if (!sessionResource) {
      this.blockUnavailable({ action: 'redoCheckpoint', reason: 'session-unavailable' });
      return null;
    }

    const navigation = await this.readCheckpointNavigationState({ sessionId: sessionResource });
    if (!navigation?.canRedo || !navigation.nextCheckpoint) {
      this.blockUnavailable({ action: 'redoCheckpoint', reason: 'checkpoint-unavailable' });
      return null;
    }

    if (!await this.isWorkspaceCheckpointAvailable('redoCheckpoint', sessionResource, navigation)) {
      return null;
    }

    return navigation;
  }

  private async resolveRestoreCheckpointBoundary(
    sessionResource: string,
    target: DialogTurnContext,
  ): Promise<{ checkpointId: string; target: DialogTurnContext } | null> {
    const resolved = await this.resolveTargetCheckpoint(sessionResource, target);
    if (!resolved) {
      return null;
    }
    if (!await this.isWorkspaceCheckpointAvailable('restoreCheckpoint', sessionResource, resolved.navigation)) {
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

  private async isWorkspaceCheckpointAvailable(
    action: ChatSessionBoundaryUnavailableAction,
    sessionResource: string,
    navigation?: ChatRuntimeHostCheckpointNavigationState | null,
  ): Promise<boolean> {
    const mode = await Promise.resolve(
      this.ctx.ensureWorkspaceCheckpointPresentationMode?.()
        ?? this.ctx.getWorkspaceCheckpointPresentationMode?.()
        ?? 'unknown',
    );
    if (mode === 'git' || mode === 'timeline') {
      return true;
    }
    if (this.hasCurrentSessionTimelineCheckpointBoundary(sessionResource, navigation)) {
      return true;
    }
    return this.blockUnavailable({
      action,
      reason: 'workspace-checkpoint-unavailable',
      workspaceCheckpointDetail: this.ctx.getWorkspaceCheckpointAvailabilityDetail?.() ?? undefined,
    });
  }

  private hasCurrentSessionTimelineCheckpointBoundary(
    sessionResource?: string | null,
    navigation?: ChatRuntimeHostCheckpointNavigationState | null,
  ): boolean {
    if (this.hasOpenProjectWorkspace()) {
      return false;
    }

    return normalizeString(navigation?.sessionId) === normalizeString(sessionResource)
      && (navigation?.checkpointCount ?? 0) > 0;
  }

  private hasOpenProjectWorkspace(): boolean {
    try {
      const currentProjectPath = AilyHost.get().project?.currentProjectPath;
      return typeof currentProjectPath === 'string' && currentProjectPath.trim().length > 0;
    } catch {
      return false;
    }
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

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

