import type { TurnResponseTurn } from 'aily-lex/browser';

import type { IAgentLifecycle, IChatCoordination, IChatServiceAccess } from '../core/chat-context';
import { AilyHost } from '../core/host';
import type {
  RollbackResult,
  WorkspaceCheckpointPresentationMode,
} from '../services/edit-checkpoint.service';
import type { RestorePlan } from '../services/editing-timeline.types';
import type { HostSessionRecord, PersistedHostResponseData } from '../services/chat-history.service';
import {
  appendEditActionResult,
  buildRedoApplyActionResult,
  type EditActionResultDescriptor,
} from './edit-action-result-projection';
import {
  buildHostProjectionStateFromPersistedRecord,
  buildTurnNativeRestoreChatList,
  type HostResponseProjection,
  type HostTurnResponseState,
} from './host-turn-response-state';
import {
  cloneTurnResponseModelSidecar,
  normalizeTurnResponseSummaryPreview,
} from './turn-response-response-model';
import { projectTurnResponsesToHistory } from './turn-response-history-projector';
import type { ChatViewWriteBridge, ChatViewWriteBridgeContext } from './chat-view-write-bridge';
import type { HostSessionSaveTarget } from './host-session-save-bridge';
import {
  restoreSessionBoundaryTransaction,
  type SessionModelBoundaryTransactionContext,
} from './session-model-boundary-transaction';
import type { SessionCheckpointTimelineState } from './session-checkpoint-timeline-model';
import type { ChatSessionRequestListTransactionResult } from '../services/chat-session-model-store.service';

export type CheckpointRedoChatReplayResult =
  | { ok: true }
  | {
    ok: false;
    errorMessage: string;
    rollbackErrors: string[];
    rolledBackOnError: boolean;
  };

export type CheckpointRedoChatReplayFailure = Extract<CheckpointRedoChatReplayResult, { ok: false }>;

export type CheckpointProjectionOutcome = EditActionResultDescriptor & {
  pendingEditFeedback?: string | null;
};

type CheckpointWorkspaceAccess = {
  buildRestorePlan?(checkpointId: string): Promise<RestorePlan | null> | RestorePlan | null;
  buildRedoPlan?(checkpointId: string): Promise<RestorePlan | null> | RestorePlan | null;
  applyRestorePlan?(plan: RestorePlan): Promise<RollbackResult | null> | RollbackResult | null;
  getPresentationMode?(): WorkspaceCheckpointPresentationMode;
};

type CheckpointRestoreTarget = {
  checkpointId: string;
  sessionResource: string;
  requestId: string;
  turnId?: string;
};

type CheckpointWorkspaceApplyResult = NonNullable<
  Awaited<ReturnType<NonNullable<CheckpointWorkspaceAccess['applyRestorePlan']>>>
>;

type CheckpointPreparedSyncAction = () => Promise<void> | void;
type CheckpointRedoRequestListCommitAction = () =>
  | ChatSessionRequestListTransactionResult
  | null
  | undefined
  | Promise<ChatSessionRequestListTransactionResult | null | undefined>;
type CheckpointRedoRequestListRollbackAction = () =>
  | ChatSessionRequestListTransactionResult
  | null
  | undefined;

type CheckpointRedoBoundaryCommitHooks = {
  applyCheckpointTimelineCommit?: CheckpointRedoRequestListCommitAction;
  rollbackCheckpointTimelineCommit?: CheckpointRedoRequestListRollbackAction;
};

type CheckpointPreparedTransition<TResult extends { ok: boolean }> =
  Promise<DeferredCheckpointTransitionResult<TResult>> | DeferredCheckpointTransitionResult<TResult>;

type CheckpointPreparedExecution<TResult extends { ok: boolean }> =
  CheckpointPreparedSequentialExecution<any, TResult>;

type CheckpointPreparedCollectedCommit<TResult extends { ok: boolean }> = {
  commitCallbacks: CheckpointDeferredCommitCallback[];
  resolveResult: () => Promise<TResult> | TResult;
};

type CheckpointPreparedCollectedCommitResult<TResult extends { ok: boolean }> =
  | CheckpointPreparedCollectedCommit<TResult>
  | { result: DeferredCheckpointTransitionFailure<TResult> };

type CheckpointRedoPreparedResultFactory = {
  buildFileFailure(result: CheckpointWorkspaceApplyResult): CheckpointRedoFileFailureResult;
  buildSuccessExecution(
    result: CheckpointWorkspaceApplyResult,
  ): Promise<CheckpointPreparedExecution<CheckpointRedoExecutionResult>>
    | CheckpointPreparedExecution<CheckpointRedoExecutionResult>;
};

type CheckpointRedoPreparedFinalizationActions = {
  applyPreparedFailureFinalization: () => Promise<string | null>;
  applyPreparedSuccessFinalization: () => Promise<CheckpointRedoCommitFailureResult | null>;
};

type CheckpointRedoPreparedFailureActions = {
  applyPreparedFailureTransition: (
    replayResult: CheckpointRedoChatReplayFailure,
  ) => Promise<CheckpointRedoChatFailureResult>;
};

type CheckpointRedoPreparedReplayAction = () => Promise<CheckpointRedoChatReplayResult>;

type CheckpointRedoPreparedSuccessActions = {
  preparedFailureActions: CheckpointRedoPreparedFailureActions;
  preparedFinalizationActions: CheckpointRedoPreparedFinalizationActions;
};

type CheckpointRedoWorkspaceRollbackAction = () => Promise<RollbackResult | null> | RollbackResult | null;

type CheckpointRestorePreparedResultFactory = {
  buildFileFailure(result: CheckpointWorkspaceApplyResult): CheckpointRestoreFileFailureResult;
  buildSuccessExecution(
    result: CheckpointWorkspaceApplyResult,
  ): Promise<CheckpointPreparedExecution<CheckpointRestoreExecutionResult>>
    | CheckpointPreparedExecution<CheckpointRestoreExecutionResult>;
};

type CheckpointRedoSuccessResult = {
  ok: true;
  rolledBackFiles: number;
  chatTurnCount: number;
  outcome: CheckpointProjectionOutcome;
};

type CheckpointRedoFailurePhase = 'file' | 'chat' | 'commit';
type CheckpointRedoFailureDisposition = 'safe-rollback' | 'hard-fail';
type CheckpointRedoPreparedFileFailureKind = 'workspace-unavailable' | 'plan-unavailable' | 'plan-missing';
type CheckpointRedoPreparedFileApplyResult = CheckpointWorkspaceApplyResult & {
  failureKind?: CheckpointRedoPreparedFileFailureKind;
};

type CheckpointRedoFailureBase = {
  ok: false;
  detailErrors: string[];
  rollbackErrorCount: number;
  disposition: CheckpointRedoFailureDisposition;
  outcome: CheckpointProjectionOutcome;
};

type CheckpointRedoFileFailureResult = CheckpointRedoFailureBase & {
  phase: 'file';
};

type CheckpointRedoChatFailureResult = CheckpointRedoFailureBase & {
  phase: 'chat';
};

type CheckpointRedoCommitFailureResult = CheckpointRedoFailureBase & {
  phase: 'commit';
};

export type CheckpointRedoExecutionResult =
  | CheckpointRedoSuccessResult
  | CheckpointRedoFileFailureResult
  | CheckpointRedoChatFailureResult
  | CheckpointRedoCommitFailureResult;

type CheckpointRedoFailureResult = Extract<CheckpointRedoExecutionResult, { ok: false }>;

type CheckpointRestoreSuccessResult = {
  ok: true;
  rolledBackFiles: number;
  outcome: CheckpointProjectionOutcome;
};

type CheckpointRestoreFileFailureResult = {
  ok: false;
  phase: 'file';
  detailErrors: string[];
  rollbackErrorCount: number;
  rolledBackOnError: boolean;
  outcome: CheckpointProjectionOutcome;
};

type CheckpointRestoreCommitFailureResult = {
  ok: false;
  phase: 'commit';
  detailErrors: string[];
  rollbackErrorCount: number;
  rolledBackOnError: boolean;
  outcome: CheckpointProjectionOutcome;
};

export type CheckpointRestoreFileExecutionResult =
  | CheckpointRestoreSuccessResult
  | CheckpointRestoreFileFailureResult;

export type CheckpointRestoreExecutionResult =
  | CheckpointRestoreSuccessResult
  | CheckpointRestoreFileFailureResult
  | CheckpointRestoreCommitFailureResult;

type CheckpointPreparedFailureTransitionConfig<TFailure extends { ok: false }> = {
  result: TFailure;
  skipPreparedFailureSync?: boolean | undefined;
  applyPreparedFailureSync?: CheckpointPreparedSyncAction | undefined;
};

type DeferredCheckpointTransitionFailure<TResult extends { ok: boolean }> = Extract<TResult, { ok: false }>;
type DeferredCheckpointTransitionSuccess<TResult extends { ok: boolean }> = Extract<TResult, { ok: true }>;

class CheckpointPreparedFailureSignal extends Error {
  constructor(
    readonly failure: CheckpointPreparedFailureTransitionConfig<{ ok: false } & Record<string, unknown>>,
  ) {
    super('Checkpoint prepared failure');
  }
}

function normalizeString(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function summarizeTurnResponseIds(turnResponses: readonly TurnResponseTurn[] | null | undefined): string[] {
  return (turnResponses ?? []).map(turn => normalizeString(turn.turnId) || '<missing-turn-id>');
}

function summarizeTurnResponseCheckpointIds(turnResponses: readonly TurnResponseTurn[] | null | undefined): string[] {
  return (turnResponses ?? []).map(turn => normalizeString(turn.request?.metadata?.checkpointId) || '<missing-checkpoint-id>');
}

function summarizeCheckpointTimeline(state: SessionCheckpointTimelineState | null | undefined): Record<string, unknown> | null {
  if (!state) {
    return null;
  }
  return {
    sessionResource: state.sessionResource,
    currentCheckpointIndex: state.currentCheckpointIndex,
    currentTurnResponseCount: state.currentTurnResponseCount,
    checkpoints: state.checkpoints.map(checkpoint => ({
      checkpointId: checkpoint.checkpointId,
      requestId: checkpoint.requestId,
      turnId: checkpoint.turnId ?? null,
      turnIndex: checkpoint.turnIndex,
    })),
    turnIds: summarizeTurnResponseIds(state.turnResponses),
    checkpointIds: summarizeTurnResponseCheckpointIds(state.turnResponses),
  };
}
type CheckpointTransitionCommitSuccess = { ok: true };
type CheckpointRestoreCommitTransitionResult =
  | CheckpointTransitionCommitSuccess
  | CheckpointRestoreCommitFailureResult;

type CheckpointRedoPreparedCommitResult = CheckpointPreparedTransition<CheckpointRedoExecutionResult>;

type CheckpointRestorePreparedCommitResult = CheckpointPreparedTransition<CheckpointRestoreExecutionResult>;

type DeferredCheckpointTransitionResult<TResult extends { ok: boolean }> =
  | {
    ok: true;
    commitCallbacks: CheckpointDeferredCommitCallback[];
    resolveResult: () => Promise<TResult> | TResult;
  }
  | {
    ok: false;
    result: DeferredCheckpointTransitionFailure<TResult>;
  };

type CheckpointDeferredCommitCallback = () => Promise<void> | void;
type CheckpointDeferredCommitCollection = CheckpointDeferredCommitCallback | readonly CheckpointDeferredCommitCallback[];

type CheckpointSequentialOperationStep<TState> = {
  label: string;
  run: (state: TState) => Promise<CheckpointDeferredCommitCollection | void> | CheckpointDeferredCommitCollection | void;
};

type CheckpointPreparedSequentialExecution<TState, TResult extends { ok: boolean }> = {
  state: TState;
  steps: CheckpointSequentialOperationStep<TState>[];
  prepareDeferredCommitCallbacks?: (state: TState) => CheckpointDeferredCommitCollection | void;
  resolveResult: (state: TState) => Promise<TResult> | TResult;
  onIOFailure: (
    error: unknown,
    state: TState,
    failedStep: string,
  ) => Promise<DeferredCheckpointTransitionResult<TResult> | DeferredCheckpointTransitionFailure<TResult>>
    | DeferredCheckpointTransitionResult<TResult>
    | DeferredCheckpointTransitionFailure<TResult>;
};

type CheckpointFileApplyExecutionState<TResult extends { ok: boolean }> = {
  applyResult?: CheckpointWorkspaceApplyResult;
  preparedFailureResult?: TResult;
  resolvePreparedResult?: () => Promise<TResult> | TResult;
};

type CheckpointReplayCoordinatorContext = ChatViewWriteBridgeContext
  & Pick<IChatServiceAccess, 'editCheckpointService'>
  & Pick<IAgentLifecycle, 'isCompleted' | 'isCancelled' | 'pendingEditFeedback'>
  & Pick<IChatCoordination, 'lexStream' | 'session'>
  & {
    workspaceCheckpointAccess?: CheckpointWorkspaceAccess;
    syncWorkspaceState?(): Promise<void> | void;
    buildExecutionSaveTarget?(sessionId: string | null | undefined): HostSessionSaveTarget | null;
    readCurrentViewSessionResource?(): string | null | undefined;
    readSessionTurnResponses(sessionId: string | null | undefined): readonly TurnResponseTurn[];
    replaceSessionModelTurnResponses?(
      sessionId: string | null | undefined,
      turnResponses: readonly TurnResponseTurn[],
      ownerPolicy?: { readonly allowForkedTurns?: boolean; readonly source?: string },
    ): readonly TurnResponseTurn[] | null | undefined;
    readonly hostResponseProjection?: HostResponseProjection | null;
    restoreSharedHostProjectionState?(
      state: HostTurnResponseState | null,
      options: { readonly sessionId: string | null; readonly attachedView?: boolean },
    ): void;
    replaceSharedHostProjectionState?(
      state: HostTurnResponseState | null,
      options: { readonly sessionId: string | null; readonly attachedView?: boolean },
    ): void;
    projectRestoredHostProjection?(
      sessionId: string,
      turnResponses: readonly TurnResponseTurn[],
      hostProjectionState: HostTurnResponseState,
      options?: { readonly attachedView?: boolean },
    ): void;
    readSessionCheckpointTimelineState?(sessionId: string | null | undefined): SessionCheckpointTimelineState | null;
    commitCheckpointRestoreRequestListTransaction?(
      sessionId: string | null | undefined,
      checkpointId: string | null | undefined,
    ): ChatSessionRequestListTransactionResult | null | undefined;
    rollbackCheckpointRestoreRequestListTransaction?(
      sessionId: string | null | undefined,
      committed: ChatSessionRequestListTransactionResult | null | undefined,
    ): ChatSessionRequestListTransactionResult | null | undefined;
    applyRequestListTransactionEffects?(
      sessionId: string,
      transaction: ChatSessionRequestListTransactionResult,
      options?: { readonly persist?: boolean },
    ): void;
  };

type CheckpointReplayViewWriteAccess = Pick<
  ChatViewWriteBridge,
  'appendAilyPartsMessageHandle' | 'restoreLegacyHistoryList' | 'restoreTurnNativeHistoryList' | 'truncateFromTurnId' | 'truncateFrom'
>;

type CheckpointRedoLocalRollbackState = {
  appliedRollbackSteps: CheckpointRedoLocalRollbackStep[];
};

type CheckpointRedoReplayExecutionState = {
  artifact: CheckpointReplayArtifact;
  restoreAttempted: boolean;
  restoreCompleted: boolean;
  restoredSessionModel: boolean | void | undefined;
  deferredCommitFailureResult?: CheckpointRedoChatReplayResult;
} & CheckpointRedoLocalRollbackState;

interface CheckpointReplayArtifact {
  turnResponses: readonly TurnResponseTurn[];
  applyPreparedCheckpointTimelineCommit: () => Promise<void> | void;
  readCommittedRequestListTransaction?: () => ChatSessionRequestListTransactionResult | null;
  applyPreparedSessionSave: () => void;
  applyPreparedReplayRestore: () => Promise<boolean | void | undefined>;
  rollbackPreparedLocalStateOnFailure: (state: CheckpointRedoLocalRollbackState) => string[];
  applyPreparedReplayModelRollback: () => Promise<CheckpointRedoReplayLifecycleRollbackResult>;
  applyPreparedLocalCommit: (state: CheckpointRedoLocalRollbackState) => Promise<void> | void;
  preparedSequentialExecution: CheckpointPreparedSequentialExecution<
    CheckpointRedoReplayExecutionState,
    CheckpointRedoChatReplayResult
  >;
}

type CheckpointRedoReplayLifecycleRollbackResult = {
  rollbackErrors: string[];
  rolledBackOnError: boolean;
};

type CheckpointRedoLocalRollbackStep = {
  failureMessage: string;
  apply: () => void;
};

type CheckpointRestoreCommitFailureHandler = (
  error: unknown,
  failedStep: string,
) => Promise<CheckpointRestoreCommitFailureResult> | CheckpointRestoreCommitFailureResult;

interface CheckpointRestoreCommitArtifact {
  checkpointId: string;
  turnId?: string;
  listIndex?: number;
  truncateIndex: number;
  captureRedoTurns: boolean;
  truncateLiveTurnResponses: boolean;
  liveTurnResponses: TurnResponseTurn[];
  restoreBeforeHostRecord: ReturnType<CheckpointReplayCoordinatorContext['session']['buildHostSessionRecord']>;
  persistedVisibleHostRecord: ReturnType<CheckpointReplayCoordinatorContext['session']['buildHostSessionRecord']>;
  persistedVisibleProjectionState: HostTurnResponseState;
  applyPreparedSyncWorkspaceState: CheckpointPreparedSyncAction;
  applyPreparedSessionSave: () => void;
  handlePreparedCommitIOFailure: CheckpointRestoreCommitFailureHandler;
  applyPreparedLocalCommit: CheckpointPreparedSyncAction;
  preparedSequentialExecution: CheckpointPreparedSequentialExecution<
    { artifact: CheckpointRestoreCommitArtifact },
    CheckpointRestoreCommitTransitionResult
  >;
}

export class CheckpointReplayCoordinator {
  private static readonly redoStagedRebuildRequiredError =
    '检查点重做缺少 staged rebuild seam，已停止兼容旧版 live rebuild 回退';
  private static readonly redoPreparedSummaryRequiredError =
    '检查点重做缺少 prepared summary seam，已停止兼容旧版 live summary 回退';

  constructor(
    private readonly ctx: CheckpointReplayCoordinatorContext,
    private readonly viewWriteBridge: CheckpointReplayViewWriteAccess,
  ) {}

  async restoreCheckpointRedoChat(
    turnResponses: readonly TurnResponseTurn[],
    options: {
      publishSummary?: boolean;
      saveSession?: boolean;
    } = {},
  ): Promise<CheckpointRedoChatReplayResult> {
    const preparedReplayArtifact = await this.prepareCheckpointRedoReplayArtifact(turnResponses, options);
    return this.executePreparedCheckpointRedoReplayArtifact(preparedReplayArtifact);
  }

  async redoCheckpoint(
    turnResponses: readonly TurnResponseTurn[],
    previousTurnResponses: readonly TurnResponseTurn[],
    boundaryCommitHooks: CheckpointRedoBoundaryCommitHooks = {},
  ): Promise<CheckpointRedoExecutionResult> {
    const preparedTransition = await this.prepareCheckpointRedoCommit(
      turnResponses,
      previousTurnResponses,
      boundaryCommitHooks,
    );

    return this.executeDeferredCheckpointTransition(preparedTransition) as Promise<CheckpointRedoExecutionResult>;
  }

  private async prepareCheckpointRedoCommit(
    turnResponses: readonly TurnResponseTurn[],
    _previousTurnResponses: readonly TurnResponseTurn[],
    boundaryCommitHooks: CheckpointRedoBoundaryCommitHooks,
  ): Promise<CheckpointRedoPreparedCommitResult> {
    const applyPreparedFailureSync = this.createPreparedSyncWorkspaceAction();
    const applyPreparedFinalizerSync = this.createPreparedSyncWorkspaceAction();
    const preparedFinalizationActions = this.createPreparedCheckpointRedoFinalizationActions({
      applyPreparedFinalizerSync,
    });
    const rollbackWorkspaceCheckpointAccess = this.getWorkspaceCheckpointAccess();
    const rollbackPresentationMode = rollbackWorkspaceCheckpointAccess.getPresentationMode?.();
    const buildPreparedRedoPlan = rollbackWorkspaceCheckpointAccess.buildRedoPlan?.bind(rollbackWorkspaceCheckpointAccess);
    const buildRollbackRestorePlan = rollbackWorkspaceCheckpointAccess.buildRestorePlan?.bind(rollbackWorkspaceCheckpointAccess);
    const applyRollbackRestorePlan = rollbackWorkspaceCheckpointAccess.applyRestorePlan?.bind(rollbackWorkspaceCheckpointAccess);

    let preparedRedoReplayExecution: CheckpointPreparedSequentialExecution<
      CheckpointRedoReplayExecutionState,
      CheckpointRedoChatReplayResult
    >;
    try {
      const preparedRedoReplayArtifact = await this.prepareCheckpointRedoReplayArtifact(turnResponses, boundaryCommitHooks);
      preparedRedoReplayExecution = preparedRedoReplayArtifact.preparedSequentialExecution;
    } catch (error) {
      if (this.isRedoMissingStagedRebuildError(error)) {
        return this.createPreparedCheckpointFailureTransition(this.withoutPreparedFailureSync(
          this.buildRedoMissingStagedRebuildFailure(),
        ));
      }
      return this.createPreparedCheckpointFailureTransition(this.withoutPreparedFailureSync(
        this.buildRedoReplayPreparationFailure(error),
      ));
    }

    const preparedRollbackReplayAction: CheckpointRedoPreparedReplayAction | null = null;

    const rollbackCheckpointId = this.getCheckpointIdFromTurnResponses(turnResponses);

    const preparedRedoFilesAction = await this.createPreparedCheckpointRedoFilesAction(
      turnResponses,
      {
        presentationMode: rollbackPresentationMode,
        buildRedoPlan: buildPreparedRedoPlan,
        applyRestorePlan: applyRollbackRestorePlan,
      },
    );

    const preparedResultFactory = this.createCheckpointRedoPreparedResultFactory({
      preparedReplayExecution: preparedRedoReplayExecution,
      chatTurnCount: turnResponses.length,
      preparePreparedSuccessActions: workspaceApplyResult => this.prepareCheckpointRedoSuccessActions({
        workspaceApplyResult,
        rollbackCheckpointId,
        rollbackPresentationMode,
        buildRollbackRestorePlan,
        applyRollbackRestorePlan,
        preparedRollbackReplayAction,
        preparedFinalizationActions,
      }),
    });

    return this.createCheckpointFileApplyTransitionBuilder<
      CheckpointRedoExecutionResult,
      CheckpointRedoFileFailureResult | CheckpointRedoChatFailureResult
    >({
      applyFiles: preparedRedoFilesAction.apply,
      buildFileFailure: result => this.withPreparedFailureSync(
        preparedResultFactory.buildFileFailure(result),
        applyPreparedFailureSync,
      ),
      buildSuccessExecution: result => preparedResultFactory.buildSuccessExecution(result),
      mapSuccessExecutionError: error => this.withoutPreparedFailureSync(
        this.buildRedoRollbackPreparationFailure(error),
      ),
    });
  }

  async restoreCheckpoint(
    checkpointId: string,
    options: {
      turnId?: string;
      listIndex?: number;
      captureRedoTurns?: boolean;
      truncateLiveTurnResponses?: boolean;
    } = {},
  ): Promise<CheckpointRestoreExecutionResult> {
    const preparedTransition = await this.prepareCheckpointRestoreCommit(checkpointId, options);

    return this.executeDeferredCheckpointTransition(preparedTransition);
  }

  private async prepareCheckpointRestoreCommit(
    checkpointId: string,
    options: {
      turnId?: string;
      listIndex?: number;
      captureRedoTurns?: boolean;
      truncateLiveTurnResponses?: boolean;
    },
  ): Promise<CheckpointRestorePreparedCommitResult> {
    const applyPreparedFailureSync = this.createPreparedSyncWorkspaceAction();
    let restoreTarget: CheckpointRestoreTarget;
    try {
      restoreTarget = this.resolveCheckpointRestoreTarget(checkpointId, options.turnId);
    } catch (error) {
      return this.createPreparedCheckpointFailureTransition(
        this.withPreparedFailureSync(
          this.buildRestoreCommitPreparationFailureResult(error),
          applyPreparedFailureSync,
        ),
      );
    }

    const workspaceCheckpointAccess = this.getWorkspaceCheckpointAccess();
    const preparedRestoreFilesAction = await this.createPreparedCheckpointRestoreCommitFilesAction(restoreTarget.checkpointId, {
      presentationMode: workspaceCheckpointAccess.getPresentationMode?.(),
      buildRestorePlan: workspaceCheckpointAccess.buildRestorePlan?.bind(workspaceCheckpointAccess),
      applyRestorePlan: workspaceCheckpointAccess.applyRestorePlan?.bind(workspaceCheckpointAccess),
      allowRequestListOnlyRestore: this.canRestoreCheckpointAsRequestListOnly(
        restoreTarget.sessionResource,
        restoreTarget.checkpointId,
      ),
    });
    let preparedRestoreCommitExecution: CheckpointPreparedSequentialExecution<
      { artifact: CheckpointRestoreCommitArtifact; deferredCommitFailureResult?: CheckpointRestoreCommitTransitionResult; },
      CheckpointRestoreCommitTransitionResult
    >;
    try {
      const preparedRestoreCommitArtifact = await this.prepareCheckpointRestoreCommitArtifact(
        restoreTarget,
        options,
        applyPreparedFailureSync,
      );
      preparedRestoreCommitExecution = preparedRestoreCommitArtifact.preparedSequentialExecution;
    } catch (error) {
      return this.createPreparedCheckpointFailureTransition(
        this.withPreparedFailureSync(
          this.buildRestoreCommitPreparationFailureResult(error),
          applyPreparedFailureSync,
        ),
      );
    }

    const preparedResultFactory = this.createCheckpointRestorePreparedResultFactory({
      preparedRestoreCommitExecution,
    });

    return this.createCheckpointFileApplyTransitionBuilder<
      CheckpointRestoreExecutionResult,
      CheckpointRestoreFileFailureResult | CheckpointRestoreCommitFailureResult
    >({
      applyFiles: preparedRestoreFilesAction.apply,
      buildFileFailure: result => this.withPreparedFailureSync(
        preparedResultFactory.buildFileFailure(result),
        applyPreparedFailureSync,
      ),
      buildSuccessExecution: result => preparedResultFactory.buildSuccessExecution(result),
      mapApplyError: error => this.withPreparedFailureSync(
        this.buildRestorePreparationFailureResult(error),
        applyPreparedFailureSync,
      ),
    });
  }

  private async prepareCheckpointRestoreCommitArtifact(
    restoreTarget: CheckpointRestoreTarget,
    options: {
      turnId?: string;
      listIndex?: number;
      captureRedoTurns?: boolean;
      truncateLiveTurnResponses?: boolean;
    },
    applyPreparedSyncWorkspaceState: CheckpointPreparedSyncAction,
  ): Promise<CheckpointRestoreCommitArtifact> {
    return this.buildCheckpointRestoreCommitArtifact(
      restoreTarget,
      options,
      applyPreparedSyncWorkspaceState,
    );
  }

  private async buildCheckpointRestoreCommitArtifact(
    restoreTarget: CheckpointRestoreTarget,
    options: {
      turnId?: string;
      listIndex?: number;
      captureRedoTurns?: boolean;
      truncateLiveTurnResponses?: boolean;
    },
    applyPreparedSyncWorkspaceState: CheckpointPreparedSyncAction,
  ): Promise<CheckpointRestoreCommitArtifact> {
    const checkpointId = restoreTarget.checkpointId;
    const saveCurrentSession = this.ctx.session.saveCurrentSession.bind(this.ctx.session);
    const hasRequestListTransactionEffectRunner = typeof this.ctx.applyRequestListTransactionEffects === 'function';
    const sessionId = restoreTarget.sessionResource;
    const saveTarget = this.resolveCheckpointSaveTarget(sessionId);
    const liveTurnResponses = [...this.readSessionModelTurnResponses(sessionId)];
    const restoreBoundary = this.resolveCheckpointRestoreTruncationBoundary({
      checkpointId,
      sessionId,
      liveTurnResponses,
      restoreTargetTurnId: restoreTarget.turnId,
      restoreTargetRequestId: restoreTarget.requestId,
      requestedTurnId: options.turnId,
      requestedListIndex: options.listIndex,
    });
    const truncateIndex = restoreBoundary.truncateIndex;
    const restoreTurnId = restoreBoundary.turnId;
    const restoreListIndex = restoreBoundary.listIndex;
    const retainedTurnResponses = liveTurnResponses.slice(0, truncateIndex);
    const discardedTurnResponses = liveTurnResponses.slice(truncateIndex);
    const checkpointTimelineState = this.ctx.readSessionCheckpointTimelineState?.(sessionId) ?? null;

    const shouldCaptureRestoreBeforeHostRecord = options.captureRedoTurns !== false;
    const restoreBeforeTurnResponses = shouldCaptureRestoreBeforeHostRecord
      ? [...liveTurnResponses]
      : null;
    const restoreBeforeHostRecord = restoreBeforeTurnResponses
      ? this.ctx.session.buildHostSessionRecord?.({
        visibleChatList: this.ctx.list,
        turnResponsesOverride: restoreBeforeTurnResponses,
        target: saveTarget,
      }) ?? null
      : null;
    const persistedVisibleTurnResponses = retainedTurnResponses;
    console.info('[AilyChat][CheckpointRestoreTrace]', {
      phase: 'prepare-commit',
      sessionId,
      checkpointId,
      restoreTargetTurnId: restoreTarget.turnId ?? null,
      restoreTargetRequestId: restoreTarget.requestId,
      requestedTurnId: options.turnId ?? null,
      requestedListIndex: typeof options.listIndex === 'number' ? options.listIndex : null,
      resolvedTurnId: restoreTurnId ?? null,
      resolvedListIndex: typeof restoreListIndex === 'number' ? restoreListIndex : null,
      truncateIndex,
      liveTurnIds: summarizeTurnResponseIds(liveTurnResponses),
      liveCheckpointIds: summarizeTurnResponseCheckpointIds(liveTurnResponses),
      retainedTurnIds: summarizeTurnResponseIds(retainedTurnResponses),
      discardedTurnIds: summarizeTurnResponseIds(discardedTurnResponses),
      timeline: summarizeCheckpointTimeline(checkpointTimelineState),
    });
    const persistedVisibleProjectionState = buildHostProjectionStateFromPersistedRecord({
      turnResponses: persistedVisibleTurnResponses,
    });
    const persistedVisibleHostRecord = this.ctx.session.buildHostSessionRecord?.({
      hostProjection: persistedVisibleProjectionState,
      visibleChatList: persistedVisibleProjectionState.chatList,
      turnResponsesOverride: persistedVisibleTurnResponses,
      target: saveTarget,
    }) ?? null;
    const applyPreparedSessionSave = this.createPreparedSessionSaveAction({
      saveCurrentSession,
      saveTarget,
      hostProjectionState: persistedVisibleProjectionState,
      shouldSave: !hasRequestListTransactionEffectRunner,
    });
    const applyPreparedLocalCommit = this.createPreparedRestoreLocalCommitAction({
      checkpointId,
      restoreBeforeHostRecord,
      hostProjectionState: persistedVisibleProjectionState,
      turnId: restoreTurnId,
      listIndex: restoreListIndex,
      truncateIndex,
      truncateLiveTurnResponses: options.truncateLiveTurnResponses !== false,
      liveTurnResponses,
      persistedVisibleTurnResponses,
      persistedVisibleHostRecord,
      sessionId,
      applyPreparedSessionSave,
    });
    const handlePreparedCommitIOFailure = this.createPreparedCheckpointRestoreCommitFailureHandler();

    const artifact = {
      checkpointId,
      turnId: restoreTurnId,
      listIndex: restoreListIndex,
      truncateIndex,
      captureRedoTurns: shouldCaptureRestoreBeforeHostRecord,
      truncateLiveTurnResponses: options.truncateLiveTurnResponses !== false,
      liveTurnResponses,
      restoreBeforeHostRecord,
      persistedVisibleHostRecord,
      persistedVisibleProjectionState,
      applyPreparedSyncWorkspaceState,
      applyPreparedSessionSave,
      handlePreparedCommitIOFailure,
      applyPreparedLocalCommit,
      preparedSequentialExecution: undefined as unknown as CheckpointPreparedSequentialExecution<
        { artifact: CheckpointRestoreCommitArtifact },
        CheckpointRestoreCommitTransitionResult
      >,
    } as CheckpointRestoreCommitArtifact;

    artifact.preparedSequentialExecution = this.createCheckpointRestoreCommitSequentialExecution(artifact);

    return artifact;
  }

  private createPreparedCheckpointRedoLocalCommitActions(params: {
    sessionId: string;
    turnResponses: readonly TurnResponseTurn[];
    visibleProjectionState: HostTurnResponseState;
    previousHostResponseState: HostTurnResponseState;
    rebuildState: ReturnType<CheckpointReplayCoordinatorContext['editCheckpointService']['captureRebuildState']>;
    previousPublishedSummary: ReturnType<CheckpointReplayCoordinatorContext['editCheckpointService']['capturePublishedSummary']>;
    applyPreparedRebuildState: () => void;
    readCommittedRequestListTransaction?: () => ChatSessionRequestListTransactionResult | null;
    readRolledBackRequestListTransaction?: () => ChatSessionRequestListTransactionResult | null;
  }): {
    applyPreparedLocalCommit: (state: CheckpointRedoLocalRollbackState) => Promise<void> | void;
    rollbackPreparedLocalStateOnFailure: (state: CheckpointRedoLocalRollbackState) => string[];
  } {
    const hydrateTurnResponses = this.ctx.lexStream.hydrateTurnResponses?.bind(this.ctx.lexStream);
    const applyRequestListTransactionEffects = this.ctx.applyRequestListTransactionEffects?.bind(this.ctx);
    const replaceSharedHostProjectionState = this.ctx.replaceSharedHostProjectionState?.bind(this.ctx);
    const restoreSharedHostProjectionState = this.ctx.restoreSharedHostProjectionState?.bind(this.ctx);
    const restoreLegacyHistoryList = this.viewWriteBridge.restoreLegacyHistoryList.bind(this.viewWriteBridge);
    const restoreTurnNativeHistoryList = this.viewWriteBridge.restoreTurnNativeHistoryList.bind(this.viewWriteBridge);
    const restoreRebuildState = this.ctx.editCheckpointService.restoreRebuildState?.bind(this.ctx.editCheckpointService);
    const restorePublishedSummary = this.ctx.editCheckpointService.restorePublishedSummary?.bind(this.ctx.editCheckpointService);

    const historyRollbackStep: CheckpointRedoLocalRollbackStep = {
      failureMessage: '恢复先前 host projection 失败',
      apply: () => {
        if (params.previousHostResponseState.turnResponses.length === 0) {
          restoreLegacyHistoryList(params.previousHostResponseState.chatList);
          return;
        }

        const previousTurnIds = new Set(params.previousHostResponseState.turnResponses.map(turn => turn.turnId));
        restoreTurnNativeHistoryList(
          buildTurnNativeRestoreChatList(params.previousHostResponseState.chatList, previousTurnIds),
          previousTurnIds,
        );
        projectTurnResponsesToHistory(this.ctx, params.previousHostResponseState.turnResponses);
      },
    };

    const projectionRollbackStep: CheckpointRedoLocalRollbackStep = {
      failureMessage: '恢复先前 host projection 失败',
      apply: () => {
        restoreSharedHostProjectionState?.(params.previousHostResponseState, {
          sessionId: params.sessionId,
          attachedView: true,
        });
      },
    };

    return {
      applyPreparedLocalCommit: async state => {
        state.appliedRollbackSteps = [];

        const transaction = params.readCommittedRequestListTransaction?.() ?? null;
        if (!transaction) {
          throw new Error(`Checkpoint redo request-list transaction result is required for ${params.sessionId}`);
        }
        const visibleTurnResponses: readonly TurnResponseTurn[] = transaction.effects.hostProjection.turnResponses;
        const visibleProjectionState = visibleTurnResponses === params.visibleProjectionState.turnResponses
          ? params.visibleProjectionState
          : buildHostProjectionStateFromPersistedRecord({ turnResponses: visibleTurnResponses });

        if (applyRequestListTransactionEffects) {
          applyRequestListTransactionEffects(params.sessionId, transaction);
        } else {
          hydrateTurnResponses?.(params.sessionId, transaction.effects.executionHost.hydrateTurnResponses, { visibility: 'visibleAttach' });
        }
        params.applyPreparedRebuildState();

        state.appliedRollbackSteps.push(historyRollbackStep);
        if (!applyRequestListTransactionEffects) {
          if (visibleProjectionState.turnResponses.length === 0) {
            restoreLegacyHistoryList(visibleProjectionState.chatList);
          } else {
            const turnIds = new Set(visibleProjectionState.turnResponses.map(turn => turn.turnId));
            restoreTurnNativeHistoryList(
              buildTurnNativeRestoreChatList(visibleProjectionState.chatList, turnIds),
              turnIds,
            );
            projectTurnResponsesToHistory(this.ctx, visibleProjectionState.turnResponses);
          }
        }

        state.appliedRollbackSteps.push(projectionRollbackStep);
        if (!applyRequestListTransactionEffects) {
          replaceSharedHostProjectionState?.(visibleProjectionState, {
            sessionId: params.sessionId,
            attachedView: true,
          });
        }
      },
      rollbackPreparedLocalStateOnFailure: state => {
        const rollbackErrors: string[] = [];

        try {
          const rollbackTransaction = params.readRolledBackRequestListTransaction?.() ?? null;
          if (!rollbackTransaction) {
            throw new Error(`Checkpoint redo rollback request-list transaction result is required for ${params.sessionId}`);
          }
          if (applyRequestListTransactionEffects) {
            applyRequestListTransactionEffects(params.sessionId, rollbackTransaction);
          } else {
            hydrateTurnResponses?.(
              params.sessionId,
              rollbackTransaction.effects.executionHost.hydrateTurnResponses,
              { visibility: 'visibleAttach' },
            );
          }
        } catch (rollbackError: any) {
          rollbackErrors.push(
            rollbackError?.message
              ? `恢复 session model 失败: ${rollbackError.message}`
              : '恢复 session model 失败',
          );
        }

        if (params.rebuildState) {
          try {
            restoreRebuildState?.(params.rebuildState);
          } catch (rollbackError: any) {
            rollbackErrors.push(
              rollbackError?.message
                ? `恢复 checkpoint owner state 失败: ${rollbackError.message}`
                : '恢复 checkpoint owner state 失败',
            );
          }
        }

        try {
          restorePublishedSummary?.(params.previousPublishedSummary);
        } catch (rollbackError: any) {
          rollbackErrors.push(
            rollbackError?.message
              ? `恢复已发布摘要失败: ${rollbackError.message}`
              : '恢复已发布摘要失败',
          );
        }

        for (const rollbackStep of state.appliedRollbackSteps) {
          try {
            rollbackStep.apply();
          } catch (projectionRestoreError) {
            rollbackErrors.push(
              projectionRestoreError instanceof Error && projectionRestoreError.message
                ? `${rollbackStep.failureMessage}: ${projectionRestoreError.message}`
                : rollbackStep.failureMessage,
            );
          }
        }

        return rollbackErrors;
      },
    };
  }

  private createPreparedCheckpointRedoReplayActions(params: {
    sessionId: string;
    turnResponses: readonly TurnResponseTurn[];
    previousSessionModelTurnResponses: TurnResponseTurn[];
    readRolledBackRequestListTransaction?: () => ChatSessionRequestListTransactionResult | null;
  }): {
    applyPreparedReplayRestore: () => Promise<boolean | void | undefined>;
    applyPreparedReplayModelRollback: () => Promise<CheckpointRedoReplayLifecycleRollbackResult>;
  } {
    const hydrateTurnResponses = this.ctx.lexStream.hydrateTurnResponses?.bind(this.ctx.lexStream);
    return {
      applyPreparedReplayRestore: async () => true,
      applyPreparedReplayModelRollback: async () => {
        try {
          const rollbackTransaction = params.readRolledBackRequestListTransaction?.() ?? null;
          if (!rollbackTransaction) {
            throw new Error(`Checkpoint redo rollback request-list transaction result is required for ${params.sessionId}`);
          }
          hydrateTurnResponses?.(
            params.sessionId,
            rollbackTransaction.effects.executionHost.hydrateTurnResponses,
            { visibility: 'visibleAttach' },
          );
          return {
            rollbackErrors: [],
            rolledBackOnError: true,
          };
        } catch (restoreError) {
          return {
            rollbackErrors: [
              restoreError instanceof Error && restoreError.message
                ? `恢复先前 session model 失败: ${restoreError.message}`
                : '恢复先前 session model 失败',
            ],
            rolledBackOnError: false,
          };
        }
      },
    };
  }

  private async handleCheckpointRedoReplayIOFailure(
    state: CheckpointRedoReplayExecutionState,
    error: unknown,
  ): Promise<CheckpointRedoChatReplayFailure> {
    const rollbackErrors: string[] = [
      ...state.artifact.rollbackPreparedLocalStateOnFailure(state),
    ];

    if (!state.restoreCompleted) {
      return this.buildReplayFailureResult(
        error,
        rollbackErrors,
        rollbackErrors.length === 0 && !state.restoreAttempted,
      );
    }

    const modelRollbackResult = await state.artifact.applyPreparedReplayModelRollback();
    rollbackErrors.push(...modelRollbackResult.rollbackErrors);

    return this.buildReplayFailureResult(
      error,
      rollbackErrors,
      rollbackErrors.length === 0 && modelRollbackResult.rolledBackOnError,
    );
  }

  private createPreparedRebuildStateCommit(params: {
    stagedRebuildState: Awaited<ReturnType<NonNullable<CheckpointReplayCoordinatorContext['editCheckpointService']['buildRebuildStateFromTurnResponses']>>> | null;
    stagedPublishedSummary: Awaited<ReturnType<NonNullable<CheckpointReplayCoordinatorContext['editCheckpointService']['buildPublishedSummaryForRebuildState']>>> | undefined;
    options: {
      publishSummary?: boolean;
      saveSession?: boolean;
    };
  }): () => void {
    const { stagedRebuildState, stagedPublishedSummary, options } = params;

    if (!stagedRebuildState) {
      return () => {};
    }

    if (options.publishSummary !== false) {
      const applyRebuildStateWithSummary = this.ctx.editCheckpointService.applyRebuildStateWithSummary?.bind(this.ctx.editCheckpointService);
      if (!applyRebuildStateWithSummary) {
        throw new Error('Checkpoint rebuild summary commit unavailable.');
      }

      return () => {
        applyRebuildStateWithSummary(stagedRebuildState, stagedPublishedSummary ?? null);
      };
    }

    const applyRebuildState = this.ctx.editCheckpointService.applyRebuildState?.bind(this.ctx.editCheckpointService);
    return () => {
      applyRebuildState?.(stagedRebuildState);
    };
  }

  private createPreparedRestoreLocalCommitAction(params: {
    sessionId: string;
    checkpointId: string;
    restoreBeforeHostRecord: ReturnType<CheckpointReplayCoordinatorContext['session']['buildHostSessionRecord']>;
    hostProjectionState: HostTurnResponseState;
    turnId?: string;
    listIndex?: number;
    truncateIndex: number;
    truncateLiveTurnResponses: boolean;
    liveTurnResponses: TurnResponseTurn[];
    persistedVisibleTurnResponses: readonly TurnResponseTurn[];
    persistedVisibleHostRecord: ReturnType<CheckpointReplayCoordinatorContext['session']['buildHostSessionRecord']>;
    applyPreparedSessionSave?: CheckpointPreparedSyncAction;
  }): CheckpointPreparedSyncAction {
    const truncateStateFromCheckpoint = this.ctx.editCheckpointService.truncateStateFromCheckpoint?.bind(this.ctx.editCheckpointService);
    const captureRebuildState = this.ctx.editCheckpointService.captureRebuildState?.bind(this.ctx.editCheckpointService);
    const restoreRebuildState = this.ctx.editCheckpointService.restoreRebuildState?.bind(this.ctx.editCheckpointService);
    const dismissSummary = this.ctx.editCheckpointService.dismissSummary?.bind(this.ctx.editCheckpointService);
    const truncateFrom = this.viewWriteBridge.truncateFrom.bind(this.viewWriteBridge);
    const truncateFromTurnId = this.viewWriteBridge.truncateFromTurnId.bind(this.viewWriteBridge);
    const restoreLegacyHistoryList = this.viewWriteBridge.restoreLegacyHistoryList.bind(this.viewWriteBridge);
    const restoreTurnNativeHistoryList = this.viewWriteBridge.restoreTurnNativeHistoryList.bind(this.viewWriteBridge);
    const hydrateTurnResponses = this.ctx.lexStream.hydrateTurnResponses?.bind(this.ctx.lexStream);
    const applyRequestListTransactionEffects = this.ctx.applyRequestListTransactionEffects?.bind(this.ctx);
    const commitCheckpointRestoreRequestListTransaction =
      this.ctx.commitCheckpointRestoreRequestListTransaction?.bind(this.ctx);
    const rollbackCheckpointRestoreRequestListTransaction =
      this.ctx.rollbackCheckpointRestoreRequestListTransaction?.bind(this.ctx);
    const restoreTransactionContext: SessionModelBoundaryTransactionContext = {
      ...this.ctx,
      lexStream: {
        ...this.ctx.lexStream,
        hydrateTurnResponses,
        session: undefined,
      },
      projectRestoredHostProjection: this.ctx.projectRestoredHostProjection,
      replaceSessionModelTurnResponses: this.ctx.replaceSessionModelTurnResponses,
      replaceSharedHostProjectionState: this.ctx.replaceSharedHostProjectionState,
      invalidateHostRequestGraph: this.ctx.invalidateHostRequestGraph,
      triggerSyncDetectChanges: this.ctx.triggerSyncDetectChanges,
    };

    return async () => {
      const previousRebuildState = captureRebuildState?.() ?? null;
      const previousCheckpointTimelineState = this.ctx.readSessionCheckpointTimelineState?.(params.sessionId) ?? null;
      const previousHostProjectionState = buildHostProjectionStateFromPersistedRecord({
        turnResponses: params.liveTurnResponses,
      });
      let committedRestoreTransaction: ChatSessionRequestListTransactionResult | null = null;
      console.info('[AilyChat][CheckpointRestoreTrace]', {
        phase: 'apply-local-commit',
        sessionId: params.sessionId,
        checkpointId: params.checkpointId,
        turnId: params.turnId ?? null,
        listIndex: typeof params.listIndex === 'number' ? params.listIndex : null,
        truncateIndex: params.truncateIndex,
        liveTurnIds: summarizeTurnResponseIds(params.liveTurnResponses),
        retainedTurnIds: summarizeTurnResponseIds(params.persistedVisibleTurnResponses),
        discardedTurnIds: summarizeTurnResponseIds(params.liveTurnResponses.slice(params.truncateIndex)),
        previousTimeline: summarizeCheckpointTimeline(previousCheckpointTimelineState),
      });
      try {
        truncateStateFromCheckpoint?.(params.checkpointId);
        let committedVisibleTurnResponses: readonly TurnResponseTurn[] = params.persistedVisibleTurnResponses;
        if (!commitCheckpointRestoreRequestListTransaction) {
          throw new Error(`Checkpoint restore request-list transaction is required for ${params.sessionId}`);
        }

        committedRestoreTransaction = commitCheckpointRestoreRequestListTransaction(
          params.sessionId,
          params.checkpointId,
        ) ?? null;
        if (!committedRestoreTransaction) {
          throw new Error(`Checkpoint restore request-list transaction failed for ${params.sessionId}`);
        }
        committedVisibleTurnResponses = committedRestoreTransaction.effects.hostProjection.turnResponses;
        console.info('[AilyChat][CheckpointRestoreTrace]', {
          phase: 'apply-local-commit-request-list',
          sessionId: params.sessionId,
          checkpointId: params.checkpointId,
          transactionRevision: committedRestoreTransaction.revision ?? null,
          committedTurnIds: summarizeTurnResponseIds(committedVisibleTurnResponses),
        });

        if (!applyRequestListTransactionEffects) {
          if (params.turnId) {
            if (typeof params.listIndex === 'number') {
              truncateFrom(params.listIndex);
            } else {
              truncateFromTurnId(params.turnId);
            }
          } else if (typeof params.listIndex === 'number') {
            truncateFrom(params.listIndex);
          }
        }

        const committedHostProjectionState = committedVisibleTurnResponses === params.persistedVisibleTurnResponses
          ? params.hostProjectionState
          : buildHostProjectionStateFromPersistedRecord({ turnResponses: committedVisibleTurnResponses });
        if (applyRequestListTransactionEffects) {
          applyRequestListTransactionEffects(params.sessionId, committedRestoreTransaction);
        } else {
          const committedRestoreTransactionContext: SessionModelBoundaryTransactionContext = committedRestoreTransaction
            ? {
              ...restoreTransactionContext,
              replaceSessionModelTurnResponses: () => committedVisibleTurnResponses,
            }
            : restoreTransactionContext;

          await restoreSessionBoundaryTransaction(committedRestoreTransactionContext, {
            sessionId: params.sessionId,
            turnResponses: committedVisibleTurnResponses,
            hostProjectionState: committedHostProjectionState,
            hostRecord: params.persistedVisibleHostRecord as HostSessionRecord | null,
            attachedView: true,
            hydrateVisibleTurnResponses: params.truncateLiveTurnResponses && params.truncateIndex >= 0,
            requireLexSnapshotRestore: false,
            acceptRestorePlanTurnResponses: false,
          });
        }

        this.ctx.isCompleted = false;
        this.ctx.isCancelled = false;
        dismissSummary?.();
        if (!applyRequestListTransactionEffects) {
          params.applyPreparedSessionSave?.();
        }
      } catch (error) {
        const rollbackErrors: string[] = [];

        try {
          if (previousRebuildState) {
            restoreRebuildState?.(previousRebuildState);
          }
        } catch (rollbackError: any) {
          rollbackErrors.push(
            rollbackError?.message
              ? `恢复 checkpoint owner state 失败: ${rollbackError.message}`
              : '恢复 checkpoint owner state 失败',
          );
        }

        try {
          let rolledBackRestoreTransaction: ChatSessionRequestListTransactionResult | null = null;
          if (committedRestoreTransaction) {
            rolledBackRestoreTransaction = rollbackCheckpointRestoreRequestListTransaction?.(
              params.sessionId,
              committedRestoreTransaction,
            ) ?? null;
            if (!rolledBackRestoreTransaction) {
              throw new Error(`Checkpoint restore rollback transaction failed for ${params.sessionId}`);
            }
          }
          if (applyRequestListTransactionEffects && rolledBackRestoreTransaction) {
            applyRequestListTransactionEffects(params.sessionId, rolledBackRestoreTransaction);
          } else {
            hydrateTurnResponses?.(
              params.sessionId,
              rolledBackRestoreTransaction?.effects.executionHost.hydrateTurnResponses ?? params.liveTurnResponses,
              { visibility: 'visibleAttach' },
            );
          }
        } catch (rollbackError: any) {
          rollbackErrors.push(
            rollbackError?.message
              ? `恢复 runtime turnResponses 失败: ${rollbackError.message}`
              : '恢复 runtime turnResponses 失败',
          );
        }

        try {
          const previousTurnIds = new Set(previousHostProjectionState.turnResponses.map(turn => turn.turnId));
          restoreTurnNativeHistoryList(
            buildTurnNativeRestoreChatList(previousHostProjectionState.chatList, previousTurnIds),
            previousTurnIds,
          );
          projectTurnResponsesToHistory(this.ctx, previousHostProjectionState.turnResponses);
          this.ctx.restoreSharedHostProjectionState?.(previousHostProjectionState, {
            sessionId: params.sessionId,
            attachedView: true,
          });
        } catch (rollbackError: any) {
          rollbackErrors.push(
            rollbackError?.message
              ? `恢复 host projection 失败: ${rollbackError.message}`
              : '恢复 host projection 失败',
          );
        }

        if (rollbackErrors.length > 0) {
          const message = error instanceof Error && error.message
            ? error.message
            : '检查点本地提交失败';
          throw new Error(`${message}; rollback failed: ${rollbackErrors.join('; ')}`);
        }

        throw error;
      }
    };
  }

  private projectRestoreOutcome(outcome: CheckpointProjectionOutcome): void {
    if (typeof outcome.pendingEditFeedback !== 'undefined') {
      this.ctx.pendingEditFeedback = outcome.pendingEditFeedback;
    }

    appendEditActionResult(this.viewWriteBridge, 'restore', outcome);
  }

  private projectRedoOutcome(outcome: CheckpointProjectionOutcome): void {
    if (typeof outcome.pendingEditFeedback !== 'undefined') {
      this.ctx.pendingEditFeedback = outcome.pendingEditFeedback;
    }

    appendEditActionResult(this.viewWriteBridge, 'redo', outcome);
  }

  projectRestoreExecutionResult(result: CheckpointRestoreExecutionResult): void {
    this.projectRestoreOutcome(result.outcome);
  }

  projectRedoExecutionResult(result: CheckpointRedoExecutionResult): void {
    this.projectRedoOutcome(result.outcome);
  }

  projectRedoFileApplyResult(result: {
    rolledBackFiles: number;
    errors: readonly string[];
  }): void {
    this.projectRedoOutcome({
      ...buildRedoApplyActionResult(result.rolledBackFiles, 0, result.errors),
      pendingEditFeedback: `[用户重新应用了 ${result.rolledBackFiles} 个文件变更。]`,
    });
  }

  private buildProjectionOutcome(
    summaryText: string,
    state: 'done' | 'warn' | 'error' | 'info',
    options: {
      fileCount?: number;
      errorCount?: number;
      detailMessage?: string;
      pendingEditFeedback?: string | null;
    } = {},
  ): CheckpointProjectionOutcome {
    return {
      summaryText,
      state,
      fileCount: options.fileCount,
      errorCount: options.errorCount,
      detailMessage: options.detailMessage,
      pendingEditFeedback: options.pendingEditFeedback,
    };
  }

  private formatEditErrorDetail(errors: readonly string[]): string | undefined {
    if (errors.length === 0) {
      return undefined;
    }

    const lines = errors.slice(0, 3).map((error, index) => `${index + 1}. ${error}`);
    return `以下操作失败（最多显示 3 条）：\n${lines.join('\n')}`;
  }

  private buildRedoFailureSummary(rollbackErrorCount: number): string {
    return rollbackErrorCount > 0
      ? `重做失败，未完全回滚到还原前状态，另有 ${rollbackErrorCount} 个回滚错误`
      : '重做失败，已回滚到还原前状态';
  }

  private buildRedoActionSummary(fileCount: number, chatTurnCount: number): string {
    if (chatTurnCount <= 0) {
      return fileCount > 0
        ? `已重做 ${fileCount} 个文件变更（仅恢复工作区）`
        : '已重做工作区状态（仅恢复工作区）';
    }

    const segments: string[] = [];

    if (fileCount > 0) {
      segments.push(`${fileCount} 个文件变更`);
    }

    if (chatTurnCount > 0) {
      segments.push(`${chatTurnCount} 轮聊天`);
    }

    if (segments.length === 0) {
      return '已重做工作区与聊天状态';
    }

    return `已重做 ${segments.join('、')}`;
  }

  private buildRestoreSuccessSummary(fileCount: number): string {
    return fileCount > 0
      ? `已还原检查点，回滚了 ${fileCount} 个文件变更，并截断了后续聊天`
      : '已还原检查点，并截断了后续聊天';
  }

  private buildRestoreFailureSummary(rollbackErrorCount: number, rolledBackOnError: boolean): string {
    if (rollbackErrorCount > 0) {
      return `检查点还原失败，未完全回滚到还原前状态，未执行聊天截断，另有 ${rollbackErrorCount} 个回滚错误`;
    }

    return rolledBackOnError
      ? '检查点还原失败，已回滚到还原前状态，未执行聊天截断'
      : '检查点还原失败，未执行聊天截断';
  }

  private buildRedoFailureOutcome(
    detailErrors: readonly string[],
    rollbackErrorCount: number,
  ): CheckpointProjectionOutcome {
    return this.buildProjectionOutcome(
      this.buildRedoFailureSummary(rollbackErrorCount),
      rollbackErrorCount > 0 ? 'error' : 'warn',
      {
        errorCount: detailErrors.length,
        detailMessage: this.formatEditErrorDetail(detailErrors),
      },
    );
  }

  private buildRedoFailureWithSyncFailureOutcome(
    detailErrors: readonly string[],
    rollbackErrorCount: number,
  ): CheckpointProjectionOutcome {
    const summaryText = rollbackErrorCount > 0
      ? `重做失败，未完全回滚到还原前状态，另有 ${rollbackErrorCount} 个回滚错误，且工作区同步未完成`
      : '重做失败，已回滚到还原前状态，但工作区同步未完成';

    return this.buildProjectionOutcome(summaryText, 'error', {
      errorCount: detailErrors.length,
      detailMessage: this.formatEditErrorDetail(detailErrors),
    });
  }

  private buildRedoPreApplyHardFailureSummary(kind: CheckpointRedoPreparedFileFailureKind): string {
    switch (kind) {
      case 'workspace-unavailable':
        return '检查点重做失败，当前工作区 checkpoint plan 不可用';
      case 'plan-missing':
        return '检查点重做失败，缺少可用的 workspace checkpoint redo plan';
      case 'plan-unavailable':
      default:
        return '检查点重做失败，workspace checkpoint redo plan 不可用';
    }
  }

  private buildRedoPreApplyHardFailureResult(
    kind: CheckpointRedoPreparedFileFailureKind,
    detailErrors: string[],
  ): CheckpointRedoFileFailureResult {
    return this.buildRedoFailureResult(
      'file',
      'hard-fail',
      detailErrors,
      0,
      this.buildProjectionOutcome(
        this.buildRedoPreApplyHardFailureSummary(kind),
        'error',
        {
          errorCount: detailErrors.length,
          detailMessage: this.formatEditErrorDetail(detailErrors),
        },
      ),
    );
  }

  private buildOperationErrorMessage(prefix: string, error: unknown): string {
    return error instanceof Error && error.message
      ? `${prefix}: ${error.message}`
      : prefix;
  }

  private isHardFailRedoExecutionResult(
    result: CheckpointRedoExecutionResult,
  ): result is CheckpointRedoFailureResult & { disposition: 'hard-fail' } {
    return !result.ok && 'disposition' in result && result.disposition === 'hard-fail';
  }

  private buildRedoFailureResult(
    phase: 'file',
    disposition: CheckpointRedoFailureDisposition,
    detailErrors: string[],
    rollbackErrorCount: number,
    outcome: CheckpointProjectionOutcome,
  ): CheckpointRedoFileFailureResult;
  private buildRedoFailureResult(
    phase: 'chat',
    disposition: CheckpointRedoFailureDisposition,
    detailErrors: string[],
    rollbackErrorCount: number,
    outcome: CheckpointProjectionOutcome,
  ): CheckpointRedoChatFailureResult;
  private buildRedoFailureResult(
    phase: 'commit',
    disposition: CheckpointRedoFailureDisposition,
    detailErrors: string[],
    rollbackErrorCount: number,
    outcome: CheckpointProjectionOutcome,
  ): CheckpointRedoCommitFailureResult;
  private buildRedoFailureResult(
    phase: CheckpointRedoFailurePhase,
    disposition: CheckpointRedoFailureDisposition,
    detailErrors: string[],
    rollbackErrorCount: number,
    outcome: CheckpointProjectionOutcome,
  ): CheckpointRedoFailureResult {
    return {
      ok: false,
      phase,
      detailErrors,
      rollbackErrorCount,
      disposition,
      outcome,
    };
  }

  private buildRedoCommitFailureResult(
    prefix: string,
    error: unknown,
  ): CheckpointRedoCommitFailureResult {
    const message = this.buildOperationErrorMessage(prefix, error);

    return this.buildRedoFailureResult(
      'commit',
      'hard-fail',
      [message],
      0,
      this.buildProjectionOutcome(
        '检查点重做提交失败，工作区与聊天已恢复，但工作区同步未完成',
        'error',
        {
          errorCount: 1,
          detailMessage: this.formatEditErrorDetail([message]),
        },
      ),
    );
  }

  private createCheckpointRedoPreparedResultFactory(config: {
    preparedReplayExecution: CheckpointPreparedSequentialExecution<
      CheckpointRedoReplayExecutionState,
      CheckpointRedoChatReplayResult
    >;
    chatTurnCount: number;
    preparePreparedSuccessActions: (workspaceApplyResult: CheckpointWorkspaceApplyResult) => Promise<CheckpointRedoPreparedSuccessActions>;
  }): CheckpointRedoPreparedResultFactory {
    const {
      preparedReplayExecution,
      chatTurnCount,
      preparePreparedSuccessActions,
    } = config;

    return {
      buildFileFailure: result => {
        const preparedResult = result as CheckpointRedoPreparedFileApplyResult;
        if (preparedResult.failureKind) {
          return this.buildRedoPreApplyHardFailureResult(preparedResult.failureKind, [...preparedResult.errors]);
        }

        const rollbackErrors = result.rollbackErrors ?? [];
        const detailErrors = [
          ...result.errors.map(error => `文件恢复失败: ${error}`),
          ...rollbackErrors,
        ];

        return this.buildRedoFailureResult(
          'file',
          result.rolledBackOnError === true && rollbackErrors.length === 0 ? 'safe-rollback' : 'hard-fail',
          detailErrors,
          rollbackErrors.length,
          this.buildRedoFailureOutcome(detailErrors, rollbackErrors.length),
        );
      },
      buildSuccessExecution: async result => this.buildCheckpointRedoSuccessExecution({
        result,
        preparedReplayExecution,
        chatTurnCount,
        preparedSuccessActions: await preparePreparedSuccessActions(result),
      }),
    };
  }

  private async prepareCheckpointRedoSuccessActions(config: {
    workspaceApplyResult: CheckpointWorkspaceApplyResult;
    rollbackCheckpointId: string | null;
    rollbackPresentationMode: WorkspaceCheckpointPresentationMode | undefined;
    buildRollbackRestorePlan: CheckpointWorkspaceAccess['buildRestorePlan'] | undefined;
    applyRollbackRestorePlan: CheckpointWorkspaceAccess['applyRestorePlan'] | undefined;
    preparedRollbackReplayAction: CheckpointRedoPreparedReplayAction | null;
    preparedFinalizationActions: CheckpointRedoPreparedFinalizationActions;
  }): Promise<CheckpointRedoPreparedSuccessActions> {
    const { preparedFinalizationActions } = config;

    return {
      preparedFailureActions: await this.createPreparedCheckpointRedoFailureActions(config),
      preparedFinalizationActions,
    };
  }

  private buildCheckpointRedoSuccessExecution(config: {
    result: CheckpointWorkspaceApplyResult;
    preparedReplayExecution: CheckpointPreparedSequentialExecution<
      CheckpointRedoReplayExecutionState,
      CheckpointRedoChatReplayResult
    >;
    chatTurnCount: number;
    preparedSuccessActions: CheckpointRedoPreparedSuccessActions;
  }): CheckpointPreparedExecution<CheckpointRedoExecutionResult> {
    const {
      result,
      preparedReplayExecution,
      chatTurnCount,
      preparedSuccessActions,
    } = config;

    return this.composeCheckpointPreparedSequentialExecution<
      CheckpointRedoReplayExecutionState,
      CheckpointRedoChatReplayResult,
      CheckpointRedoExecutionResult
    >(preparedReplayExecution, {
      onFailure: replayResult => preparedSuccessActions.preparedFailureActions.applyPreparedFailureTransition(replayResult),
      onSuccess: async () => {
        const commitFailure = await preparedSuccessActions.preparedFinalizationActions.applyPreparedSuccessFinalization();
        if (commitFailure) {
          return commitFailure;
        }

        return {
          ok: true,
          rolledBackFiles: result.rolledBackFiles,
          chatTurnCount,
          outcome: this.buildRedoSuccessOutcome(result.rolledBackFiles, chatTurnCount),
        };
      },
    });
  }

  private createPreparedCheckpointRedoFinalizationActions(config: {
    applyPreparedFinalizerSync: CheckpointPreparedSyncAction;
  }): CheckpointRedoPreparedFinalizationActions {
    const { applyPreparedFinalizerSync } = config;

    return {
      applyPreparedFailureFinalization: async () => {
        try {
          await applyPreparedFinalizerSync();
          return null;
        } catch (error) {
          return this.buildOperationErrorMessage('工作区同步失败', error);
        }
      },
      applyPreparedSuccessFinalization: async () => {
        try {
          await applyPreparedFinalizerSync();
        } catch (error) {
          return this.buildRedoCommitFailureResult('工作区同步失败', error);
        }

        return null;
      },
    };
  }

  private async createPreparedCheckpointRedoFailureActions(config: {
    workspaceApplyResult: CheckpointWorkspaceApplyResult;
    rollbackCheckpointId: string | null;
    rollbackPresentationMode: WorkspaceCheckpointPresentationMode | undefined;
    buildRollbackRestorePlan: CheckpointWorkspaceAccess['buildRestorePlan'] | undefined;
    applyRollbackRestorePlan: CheckpointWorkspaceAccess['applyRestorePlan'] | undefined;
    preparedRollbackReplayAction: CheckpointRedoPreparedReplayAction | null;
    preparedFinalizationActions: CheckpointRedoPreparedFinalizationActions;
  }): Promise<CheckpointRedoPreparedFailureActions> {
    const {
      rollbackCheckpointId,
      rollbackPresentationMode,
      buildRollbackRestorePlan,
      applyRollbackRestorePlan,
      preparedRollbackReplayAction,
      preparedFinalizationActions,
    } = config;
    const preparedWorkspaceEmergencyRollbackAction: CheckpointRedoWorkspaceRollbackAction | null = typeof config.workspaceApplyResult.emergencyRollback === 'function'
      ? config.workspaceApplyResult.emergencyRollback
      : null;

    const preparedRollbackRestoreAction = !preparedWorkspaceEmergencyRollbackAction && rollbackCheckpointId
      ? await this.createPreparedCheckpointRestoreFilesAction(rollbackCheckpointId, {
        presentationMode: rollbackPresentationMode,
        buildRestorePlan: buildRollbackRestorePlan,
        applyRestorePlan: applyRollbackRestorePlan,
      })
      : null;

    return {
      applyPreparedFailureTransition: async replayResult => {
        const rollbackErrors: string[] = [];
        let workspaceRolledBackOnError = true;

        if (preparedWorkspaceEmergencyRollbackAction) {
          try {
            const rollbackResult = await preparedWorkspaceEmergencyRollbackAction();
            const resultErrors = rollbackResult?.errors ?? [];
            const workspaceRollbackErrors = [
              ...resultErrors,
              ...((rollbackResult?.rollbackErrors ?? []).filter(error => !resultErrors.includes(error))),
            ];
            rollbackErrors.push(...workspaceRollbackErrors.map(error => `文件回滚失败: ${error}`));
            workspaceRolledBackOnError = rollbackResult?.rolledBackOnError === true && workspaceRollbackErrors.length === 0;
          } catch (error) {
            rollbackErrors.push(this.buildOperationErrorMessage('文件回滚失败', error));
            workspaceRolledBackOnError = false;
          }
        } else if (preparedRollbackRestoreAction) {
          const rollbackResult = await preparedRollbackRestoreAction();
          const resultErrors = rollbackResult.errors ?? [];
          const workspaceRollbackErrors = [
            ...resultErrors,
            ...((rollbackResult.rollbackErrors ?? []).filter(error => !resultErrors.includes(error))),
          ];
          rollbackErrors.push(...workspaceRollbackErrors.map(error => `文件回滚失败: ${error}`));
          workspaceRolledBackOnError = rollbackResult.rolledBackOnError !== false && workspaceRollbackErrors.length === 0;
        }

        if (rollbackErrors.length === 0 && replayResult.rolledBackOnError !== true && preparedRollbackReplayAction) {
          const rollbackChatResult = await preparedRollbackReplayAction();
          if (rollbackChatResult.ok === false) {
            rollbackErrors.push(
              rollbackChatResult.errorMessage
                ? `聊天回滚失败: ${rollbackChatResult.errorMessage}`
                : '聊天回滚失败',
            );
          }
        }

        const allRollbackErrors = [...replayResult.rollbackErrors, ...rollbackErrors];
        const detailErrors = [replayResult.errorMessage, ...allRollbackErrors];
        const syncFailureMessage = await preparedFinalizationActions.applyPreparedFailureFinalization();
        if (syncFailureMessage !== null) {
          detailErrors.push(syncFailureMessage);
        }

        return this.buildRedoFailureResult(
          'chat',
          allRollbackErrors.length === 0 && syncFailureMessage === null && workspaceRolledBackOnError ? 'safe-rollback' : 'hard-fail',
          detailErrors,
          allRollbackErrors.length,
          syncFailureMessage !== null
            ? this.buildRedoFailureWithSyncFailureOutcome(detailErrors, allRollbackErrors.length)
            : this.buildRedoFailureOutcome(detailErrors, allRollbackErrors.length),
        );
      },
    };
  }

  private createCheckpointRestorePreparedResultFactory(config: {
    preparedRestoreCommitExecution: CheckpointPreparedSequentialExecution<
      { artifact: CheckpointRestoreCommitArtifact; deferredCommitFailureResult?: CheckpointRestoreCommitTransitionResult; },
      CheckpointRestoreCommitTransitionResult
    >;
  }): CheckpointRestorePreparedResultFactory {
    const { preparedRestoreCommitExecution } = config;

    return {
      buildFileFailure: result => {
        const rollbackErrors = result.rollbackErrors ?? [];
        const detailErrors = [
          ...result.errors.map(error => `文件恢复失败: ${error}`),
          ...rollbackErrors,
        ];

        return {
          ok: false,
          phase: 'file',
          detailErrors,
          rollbackErrorCount: rollbackErrors.length,
          rolledBackOnError: result.rolledBackOnError === true,
          outcome: this.buildRestoreFailureOutcome(
            detailErrors,
            rollbackErrors.length,
            result.rolledBackOnError === true,
          ),
        };
      },
      buildSuccessExecution: result => this.buildCheckpointRestoreSuccessExecution({
        result,
        preparedRestoreCommitExecution,
      }),
    };
  }

  private buildCheckpointRestoreSuccessExecution(config: {
    result: CheckpointWorkspaceApplyResult;
    preparedRestoreCommitExecution: CheckpointPreparedSequentialExecution<
      { artifact: CheckpointRestoreCommitArtifact; deferredCommitFailureResult?: CheckpointRestoreCommitTransitionResult; },
      CheckpointRestoreCommitTransitionResult
    >;
  }): CheckpointPreparedExecution<CheckpointRestoreExecutionResult> {
    const { result, preparedRestoreCommitExecution } = config;

    return this.composeCheckpointPreparedSequentialExecution<
      { artifact: CheckpointRestoreCommitArtifact; deferredCommitFailureResult?: CheckpointRestoreCommitTransitionResult; },
      CheckpointRestoreCommitTransitionResult,
      CheckpointRestoreExecutionResult
    >(preparedRestoreCommitExecution, {
      onFailure: failure => this.withRestoreWorkspaceEmergencyRollback(failure, result),
      onSuccess: () => ({
        ok: true,
        rolledBackFiles: result.rolledBackFiles,
        outcome: this.buildRestoreSuccessOutcome(result.rolledBackFiles),
      }),
    });
  }

  private async withRestoreWorkspaceEmergencyRollback(
    failure: CheckpointRestoreCommitFailureResult,
    workspaceApplyResult: CheckpointWorkspaceApplyResult,
  ): Promise<CheckpointRestoreCommitFailureResult> {
    if (typeof workspaceApplyResult.emergencyRollback !== 'function') {
      return failure;
    }

    try {
      const rollbackResult = await workspaceApplyResult.emergencyRollback();
      const resultErrors = rollbackResult?.errors ?? [];
      const rollbackErrors = [
        ...resultErrors,
        ...((rollbackResult?.rollbackErrors ?? []).filter(error => !resultErrors.includes(error))),
      ];
      const rollbackErrorCount = failure.rollbackErrorCount + rollbackErrors.length;
      const detailErrors = rollbackErrors.length > 0
        ? [
          ...failure.detailErrors,
          ...rollbackErrors.map(error => `工作区补偿回滚失败: ${error}`),
        ]
        : failure.detailErrors;
      const rolledBackOnError = failure.rollbackErrorCount === 0
        && rollbackResult?.rolledBackOnError === true
        && rollbackErrors.length === 0;

      return {
        ...failure,
        detailErrors,
        rollbackErrorCount,
        rolledBackOnError,
        outcome: this.buildRestoreFailureOutcome(detailErrors, rollbackErrorCount, rolledBackOnError),
      };
    } catch (error) {
      const message = error instanceof Error && error.message
        ? `工作区补偿回滚失败: ${error.message}`
        : '工作区补偿回滚失败';
      const detailErrors = [...failure.detailErrors, message];
      const rollbackErrorCount = failure.rollbackErrorCount + 1;

      return {
        ...failure,
        detailErrors,
        rollbackErrorCount,
        rolledBackOnError: false,
        outcome: this.buildRestoreFailureOutcome(detailErrors, rollbackErrorCount, false),
      };
    }
  }

  private createPreparedCheckpointRestoreCommitFailureHandler(): CheckpointRestoreCommitFailureHandler {
    return (error, failedStep) => this.buildRestoreCommitFailureResult(
      failedStep === 'syncWorkspaceState' ? '工作区同步失败' : '检查点提交失败',
      error,
    );
  }

  private buildRedoMissingStagedRebuildFailure(): CheckpointRedoChatFailureResult {
    const detailErrors = [CheckpointReplayCoordinator.redoStagedRebuildRequiredError];
    return this.buildRedoFailureResult(
      'chat',
      'hard-fail',
      detailErrors,
      0,
      this.buildProjectionOutcome(
        '检查点重做失败，当前运行时不支持 staged rebuild 提交',
        'error',
        {
          errorCount: 1,
          detailMessage: this.formatEditErrorDetail(detailErrors),
        },
      ),
    );
  }

  private buildRedoMissingFrozenPlanFailure(
    checkpointId: string | null,
  ): CheckpointRedoFileFailureResult {
    const message = checkpointId
      ? `检查点重做缺少冻结的 git-backed redo plan: ${checkpointId}`
      : '检查点重做缺少冻结的 git-backed redo plan';

    return this.buildRedoFailureResult(
      'file',
      'hard-fail',
      [message],
      0,
      this.buildProjectionOutcome(
        '检查点重做失败，缺少冻结的 workspace checkpoint 锚点',
        'error',
        {
          errorCount: 1,
          detailMessage: this.formatEditErrorDetail([message]),
        },
      ),
    );
  }

  private buildRedoReplayPreparationFailure(error: unknown): CheckpointRedoChatFailureResult {
    const message = error instanceof Error && error.message
      ? `检查点重做准备失败: ${error.message}`
      : '检查点重做准备失败';

    return this.buildRedoFailureResult(
      'chat',
      'safe-rollback',
      [message],
      0,
      this.buildProjectionOutcome(
        '检查点重做准备失败，未应用文件或聊天更改',
        'error',
        {
          errorCount: 1,
          detailMessage: this.formatEditErrorDetail([message]),
        },
      ),
    );
  }

  private buildRedoRollbackPreparationFailure(error: unknown): CheckpointRedoChatFailureResult {
    const message = error instanceof Error && error.message
      ? `检查点重做补偿准备失败: ${error.message}`
      : '检查点重做补偿准备失败';

    return this.buildRedoFailureResult(
      'chat',
      'safe-rollback',
      [message],
      0,
      this.buildProjectionOutcome(
        '检查点重做补偿准备失败，未应用文件或聊天更改',
        'error',
        {
          errorCount: 1,
          detailMessage: this.formatEditErrorDetail([message]),
        },
      ),
    );
  }

  private buildRedoSuccessOutcome(fileCount: number, chatTurnCount: number): CheckpointProjectionOutcome {
    return this.buildProjectionOutcome(
      this.buildRedoActionSummary(fileCount, chatTurnCount),
      'done',
      {
        fileCount,
        pendingEditFeedback: `[用户重新应用了 ${fileCount} 个文件变更，并恢复了 ${chatTurnCount} 轮聊天。]`,
      },
    );
  }

  private buildRestoreSuccessOutcome(fileCount: number): CheckpointProjectionOutcome {
    return this.buildProjectionOutcome(this.buildRestoreSuccessSummary(fileCount), 'done', {
      fileCount: fileCount > 0 ? fileCount : undefined,
    });
  }

  private buildRestoreFailureOutcome(
    detailErrors: readonly string[],
    rollbackErrorCount: number,
    rolledBackOnError: boolean,
  ): CheckpointProjectionOutcome {
    return this.buildProjectionOutcome(
      this.buildRestoreFailureSummary(rollbackErrorCount, rolledBackOnError),
      rollbackErrorCount > 0 ? 'error' : 'warn',
      {
        errorCount: detailErrors.length,
        detailMessage: this.formatEditErrorDetail(detailErrors),
      },
    );
  }

  private buildRestoreCommitFailureResult(
    prefix: string,
    error: unknown,
  ): CheckpointRestoreCommitFailureResult {
    const message = error instanceof Error && error.message
      ? `${prefix}: ${error.message}`
      : prefix;

    return {
      ok: false,
      phase: 'commit',
      detailErrors: [message],
      rollbackErrorCount: 0,
      rolledBackOnError: false,
      outcome: this.buildProjectionOutcome(
        '检查点还原提交失败，工作区已恢复，但聊天或会话提交未完成',
        'error',
        {
          errorCount: 1,
          detailMessage: this.formatEditErrorDetail([message]),
        },
      ),
    };
  }

  private buildRestoreCommitPreparationFailureResult(
    error: unknown,
  ): CheckpointRestoreCommitFailureResult {
    const message = error instanceof Error && error.message
      ? `检查点提交准备失败: ${error.message}`
      : '检查点提交准备失败';

    return {
      ok: false,
      phase: 'commit',
      detailErrors: [message],
      rollbackErrorCount: 0,
      rolledBackOnError: false,
      outcome: this.buildProjectionOutcome(
        '检查点还原提交准备失败，未应用文件或聊天更改',
        'error',
        {
          errorCount: 1,
          detailMessage: this.formatEditErrorDetail([message]),
        },
      ),
    };
  }

  private buildRestorePreparationFailureResult(
    error: unknown,
  ): CheckpointRestoreFileFailureResult {
    const message = error instanceof Error && error.message
      ? `检查点还原准备失败: ${error.message}`
      : '检查点还原准备失败';

    return {
      ok: false,
      phase: 'file',
      detailErrors: [message],
      rollbackErrorCount: 0,
      rolledBackOnError: false,
      outcome: this.buildProjectionOutcome(
        '检查点还原准备失败，未应用文件或聊天更改',
        'error',
        {
          errorCount: 1,
          detailMessage: this.formatEditErrorDetail([message]),
        },
      ),
    };
  }

  private getCheckpointIdFromTurnResponses(turnResponses: readonly TurnResponseTurn[]): string | null {
    const checkpointId = turnResponses.at(-1)?.request?.metadata?.checkpointId;
    return typeof checkpointId === 'string' && checkpointId.length > 0 ? checkpointId : null;
  }

  private async createPreparedCheckpointRedoFilesAction(
    turnResponses: readonly TurnResponseTurn[],
    frozenWorkspaceAction: {
      presentationMode: WorkspaceCheckpointPresentationMode | undefined;
      buildRedoPlan: CheckpointWorkspaceAccess['buildRedoPlan'] | undefined;
      applyRestorePlan: CheckpointWorkspaceAccess['applyRestorePlan'] | undefined;
    },
  ): Promise<{
    presentationMode: ReturnType<CheckpointWorkspaceAccess['getPresentationMode']>;
    apply: () => Promise<CheckpointWorkspaceApplyResult>;
  }> {
    const { presentationMode, buildRedoPlan, applyRestorePlan } = frozenWorkspaceAction;
    const checkpointId = this.getCheckpointIdFromTurnResponses(turnResponses);

    if (!checkpointId || !buildRedoPlan || !applyRestorePlan) {
      return {
        presentationMode,
        apply: async () => ({
          rolledBackFiles: 0,
          errors: ['checkpoint redo timeline plan 不可用'],
          failureKind: 'plan-unavailable',
        }),
      };
    }

    const preparedRedoPlan = await buildRedoPlan(checkpointId);
    if (!preparedRedoPlan) {
      return {
        presentationMode,
        apply: async () => ({
          rolledBackFiles: 0,
          errors: [`未找到检查点 redo plan: ${checkpointId}`],
          failureKind: 'plan-missing',
        }),
      };
    }

    if (this.shouldBlockUnavailableCheckpointPlan(preparedRedoPlan, presentationMode)) {
      return {
        presentationMode,
        apply: async () => ({
          rolledBackFiles: 0,
          errors: ['当前工作区 checkpoint plan 不可用，已阻止检查点恢复'],
          failureKind: 'workspace-unavailable',
        }),
      };
    }

    return {
      presentationMode,
      apply: async () => {
        const applyResult = await applyRestorePlan(preparedRedoPlan);
        return applyResult ?? {
          rolledBackFiles: 0,
          errors: ['checkpoint redo timeline plan 不可用'],
          failureKind: 'plan-unavailable' as const,
        };
      },
    };
  }

  private async createPreparedCheckpointRestoreCommitFilesAction(
    checkpointId: string,
    frozenWorkspaceAction: {
      presentationMode: WorkspaceCheckpointPresentationMode | undefined;
      buildRestorePlan: CheckpointWorkspaceAccess['buildRestorePlan'] | undefined;
      applyRestorePlan: CheckpointWorkspaceAccess['applyRestorePlan'] | undefined;
      allowRequestListOnlyRestore?: boolean;
    },
  ): Promise<{
    presentationMode: ReturnType<CheckpointWorkspaceAccess['getPresentationMode']>;
    apply: () => Promise<CheckpointWorkspaceApplyResult>;
  }> {
    const {
      presentationMode,
      buildRestorePlan,
      applyRestorePlan,
      allowRequestListOnlyRestore = false,
    } = frozenWorkspaceAction;

    if (!buildRestorePlan || !applyRestorePlan) {
      if (allowRequestListOnlyRestore) {
        return {
          presentationMode,
          apply: async () => this.buildRequestListOnlyWorkspaceApplyResult(),
        };
      }
      return {
        presentationMode,
        apply: async () => ({ rolledBackFiles: 0, errors: ['checkpoint restore timeline plan 不可用'] }),
      };
    }

    let restorePlan: Awaited<ReturnType<NonNullable<CheckpointWorkspaceAccess['buildRestorePlan']>>> | null;
    try {
      restorePlan = await buildRestorePlan(checkpointId);
    } catch (error) {
      return {
        presentationMode,
        apply: async () => {
          throw error;
        },
      };
    }

    if (!restorePlan) {
      if (allowRequestListOnlyRestore) {
        return {
          presentationMode,
          apply: async () => this.buildRequestListOnlyWorkspaceApplyResult(),
        };
      }
      return {
        presentationMode,
        apply: async () => ({ rolledBackFiles: 0, errors: [`未找到检查点 restore plan: ${checkpointId}`] }),
      };
    }

    if (this.shouldBlockUnavailableCheckpointPlan(restorePlan, presentationMode)) {
      return {
        presentationMode,
        apply: async () => ({
          rolledBackFiles: 0,
          errors: ['当前工作区 checkpoint plan 不可用，已阻止检查点还原'],
        }),
      };
    }

    return {
      presentationMode,
      apply: async () => await applyRestorePlan(restorePlan)
        ?? { rolledBackFiles: 0, errors: ['checkpoint restore timeline plan 不可用'] },
    };
  }

  private async createPreparedCheckpointRestoreFilesAction(
    checkpointId: string,
    frozenWorkspaceAction: {
      presentationMode: WorkspaceCheckpointPresentationMode | undefined;
      buildRestorePlan: CheckpointWorkspaceAccess['buildRestorePlan'] | undefined;
      applyRestorePlan: CheckpointWorkspaceAccess['applyRestorePlan'] | undefined;
    },
  ): Promise<() => Promise<CheckpointWorkspaceApplyResult>> {
    const { presentationMode, buildRestorePlan, applyRestorePlan } = frozenWorkspaceAction;

    if (!buildRestorePlan || !applyRestorePlan) {
      throw new Error('checkpoint restore timeline plan 不可用');
    }

    const restorePlan = await buildRestorePlan(checkpointId);
    if (!restorePlan) {
      throw new Error(`未找到检查点 restore plan: ${checkpointId}`);
    }

    if (this.shouldBlockUnavailableCheckpointPlan(restorePlan, presentationMode)) {
      throw new Error('当前工作区 checkpoint plan 不可用，已阻止检查点还原');
    }

    return async () => await applyRestorePlan(restorePlan) ?? {
      rolledBackFiles: 0,
      errors: ['checkpoint restore timeline plan 不可用'],
    };
  }

  private shouldBlockUnavailableCheckpointPlan(
    plan: RestorePlan | null,
    presentationMode: WorkspaceCheckpointPresentationMode | undefined,
  ): boolean {
    return presentationMode === 'unknown' || !plan;
  }

  private buildRequestListOnlyWorkspaceApplyResult(): CheckpointWorkspaceApplyResult {
    return { rolledBackFiles: 0, errors: [] };
  }

  private canRestoreCheckpointAsRequestListOnly(
    sessionId: string | null | undefined,
    checkpointId: string | null | undefined,
  ): boolean {
    if (this.hasOpenProjectWorkspace()) {
      return false;
    }

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const normalizedCheckpointId = typeof checkpointId === 'string' ? checkpointId.trim() : '';
    if (!normalizedSessionId || !normalizedCheckpointId) {
      return false;
    }

    const timelineState = this.ctx.readSessionCheckpointTimelineState?.(normalizedSessionId) ?? null;
    return timelineState?.sessionResource === normalizedSessionId
      && timelineState.checkpoints.some(checkpoint => checkpoint.checkpointId === normalizedCheckpointId);
  }

  private hasOpenProjectWorkspace(): boolean {
    try {
      const currentProjectPath = AilyHost.get().project?.currentProjectPath;
      return typeof currentProjectPath === 'string' && currentProjectPath.trim().length > 0;
    } catch {
      return false;
    }
  }

  private getWorkspaceCheckpointAccess(): CheckpointWorkspaceAccess {
    return this.ctx.workspaceCheckpointAccess ?? {};
  }

  private async buildCheckpointRedoReplayArtifact(
    turnResponses: readonly TurnResponseTurn[],
    options: {
      publishSummary?: boolean;
      saveSession?: boolean;
    } & CheckpointRedoBoundaryCommitHooks,
  ): Promise<CheckpointReplayArtifact> {
    const saveCurrentSession = this.ctx.session.saveCurrentSession.bind(this.ctx.session);
    const hasRequestListTransactionEffectRunner = typeof this.ctx.applyRequestListTransactionEffects === 'function';
    const sessionId = this.resolveCheckpointSessionId();
    const saveTarget = this.resolveCheckpointSaveTarget(sessionId);
    const hostResponseState = buildHostProjectionStateFromPersistedRecord({
      turnResponses,
    });
    const rebuildState = this.ctx.editCheckpointService.captureRebuildState?.();
    const previousPublishedSummary = this.ctx.editCheckpointService.capturePublishedSummary?.() ?? null;
    const previousSessionModelTurnResponses = [...this.readSessionModelTurnResponses(sessionId)];
    const previousHostResponseState = buildHostProjectionStateFromPersistedRecord({
      turnResponses: previousSessionModelTurnResponses,
    });
    const stagedRebuildState = this.ctx.editCheckpointService.buildRebuildStateFromTurnResponses
      ? await this.ctx.editCheckpointService.buildRebuildStateFromTurnResponses(hostResponseState.turnResponses)
      : null;
    if (!stagedRebuildState) {
      throw new Error(CheckpointReplayCoordinator.redoStagedRebuildRequiredError);
    }

    const stagedPublishedSummary = stagedRebuildState && options.publishSummary !== false
      ? await this.ctx.editCheckpointService.buildPublishedSummaryForRebuildState?.(stagedRebuildState)
      : undefined;
    if (stagedRebuildState && options.publishSummary !== false && stagedPublishedSummary === undefined) {
      throw new Error(CheckpointReplayCoordinator.redoPreparedSummaryRequiredError);
    }
    const persistedVisibleRecord = options.saveSession !== false
      ? this.ctx.session.buildHostSessionRecord?.({
        hostProjection: hostResponseState,
        visibleChatList: hostResponseState.chatList,
        turnResponsesOverride: hostResponseState.turnResponses,
        target: saveTarget,
      })
      : null;
    const visibleProjectionState = persistedVisibleRecord?.turnResponses?.length || hostResponseState.turnResponses.length === 0
      ? buildHostProjectionStateFromPersistedRecord({
        turnResponses: persistedVisibleRecord?.turnResponses ?? hostResponseState.turnResponses,
      })
      : hostResponseState;
    const applyPreparedSessionSave = this.createPreparedSessionSaveAction({
      saveCurrentSession,
      saveTarget,
      hostProjectionState: visibleProjectionState,
      shouldSave: options.saveSession !== false && !hasRequestListTransactionEffectRunner,
    });
    const applyPreparedRebuildState = this.createPreparedRebuildStateCommit({
      stagedRebuildState,
      stagedPublishedSummary,
      options,
    });

    let checkpointTimelineCommitted = false;
    let committedRequestListTransaction: ChatSessionRequestListTransactionResult | null = null;
    let rolledBackRequestListTransaction: ChatSessionRequestListTransactionResult | null = null;
    const applyPreparedCheckpointTimelineCommit = async () => {
      if (typeof options.applyCheckpointTimelineCommit !== 'function') {
        throw new Error('Checkpoint redo request-list commit hook is required');
      }
      const committedTransaction = await options.applyCheckpointTimelineCommit();
      if (!committedTransaction?.effects) {
        throw new Error('Checkpoint redo request-list commit hook did not return a transaction result');
      }
      committedRequestListTransaction = committedTransaction;
      checkpointTimelineCommitted = true;
    };
    const readCommittedRequestListTransaction = () => committedRequestListTransaction;
    const readRolledBackRequestListTransaction = () => rolledBackRequestListTransaction;

    const { applyPreparedLocalCommit, rollbackPreparedLocalStateOnFailure } = this.createPreparedCheckpointRedoLocalCommitActions({
      sessionId,
      turnResponses,
      visibleProjectionState,
      previousHostResponseState,
      rebuildState,
      previousPublishedSummary,
      applyPreparedRebuildState,
      readCommittedRequestListTransaction,
      readRolledBackRequestListTransaction,
    });

    const { applyPreparedReplayRestore, applyPreparedReplayModelRollback } = this.createPreparedCheckpointRedoReplayActions({
      sessionId,
      turnResponses,
      previousSessionModelTurnResponses,
      readRolledBackRequestListTransaction,
    });
    const rollbackPreparedCheckpointTimelineCommit = (): string[] => {
      if (!checkpointTimelineCommitted) {
        return [];
      }

      try {
        if (typeof options.rollbackCheckpointTimelineCommit !== 'function') {
          throw new Error('Checkpoint redo request-list rollback hook is required');
        }
        const rolledBackTransaction = options.rollbackCheckpointTimelineCommit();
        if (!rolledBackTransaction?.effects) {
          throw new Error('Checkpoint redo request-list rollback hook did not return a transaction result');
        }
        rolledBackRequestListTransaction = rolledBackTransaction;
        checkpointTimelineCommitted = false;
        return [];
      } catch (rollbackError: any) {
        return [
          rollbackError?.message
            ? `恢复 checkpoint timeline pointer 失败: ${rollbackError.message}`
            : '恢复 checkpoint timeline pointer 失败',
        ];
      }
    };

    const artifact = {
      turnResponses,
      applyPreparedCheckpointTimelineCommit,
      readCommittedRequestListTransaction,
      applyPreparedSessionSave,
      applyPreparedReplayRestore,
      rollbackPreparedLocalStateOnFailure: state => {
        const rollbackErrors = rollbackPreparedCheckpointTimelineCommit();
        rollbackErrors.push(...rollbackPreparedLocalStateOnFailure(state));
        return rollbackErrors;
      },
      applyPreparedReplayModelRollback,
      applyPreparedLocalCommit,
      preparedSequentialExecution: undefined as unknown as CheckpointPreparedSequentialExecution<
        CheckpointRedoReplayExecutionState,
        CheckpointRedoChatReplayResult
      >,
    } as CheckpointReplayArtifact;

    artifact.preparedSequentialExecution = this.createCheckpointRedoReplaySequentialExecution(artifact);
    return artifact;
  }

  private async executeDeferredCheckpointTransition<TResult extends { ok: boolean }>(
    transitionResult: CheckpointPreparedTransition<TResult>,
  ): Promise<TResult> {
    const resolved = await transitionResult;
    if (resolved.ok === false) {
      return resolved.result;
    }

    for (const commitCallback of resolved.commitCallbacks) {
      await commitCallback();
    }
    return resolved.resolveResult();
  }

  private withPreparedFailureSync<TFailure extends { ok: false }>(
    result: TFailure,
    applyPreparedFailureSync: CheckpointPreparedSyncAction,
  ): CheckpointPreparedFailureTransitionConfig<TFailure> {
    return {
      result,
      applyPreparedFailureSync,
    };
  }

  private withoutPreparedFailureSync<TFailure extends { ok: false }>(
    result: TFailure,
  ): CheckpointPreparedFailureTransitionConfig<TFailure> {
    return {
      result,
      skipPreparedFailureSync: true,
    };
  }

  private async createPreparedCheckpointFailureTransition<
    TResult extends { ok: boolean },
      TFailure extends Extract<TResult, { ok: false }>,
  >(
      failure: CheckpointPreparedFailureTransitionConfig<TFailure>,
  ): Promise<DeferredCheckpointTransitionResult<TResult>> {
    if (failure.skipPreparedFailureSync !== true) {
      if (!failure.applyPreparedFailureSync) {
        throw new Error('prepared checkpoint failure sync is required before executing failure result');
      }

      await failure.applyPreparedFailureSync();
    }

    return {
      ok: false,
      result: failure.result,
    };
  }

  private createCheckpointFileApplyTransitionBuilder<
    TResult extends { ok: boolean },
    TFailure extends Extract<TResult, { ok: false }>,
  >(config: {
    applyFiles: () => Promise<CheckpointWorkspaceApplyResult>;
    buildFileFailure: (result: CheckpointWorkspaceApplyResult) => CheckpointPreparedFailureTransitionConfig<TFailure>;
    buildSuccessExecution: (
      result: CheckpointWorkspaceApplyResult,
    ) => Promise<CheckpointPreparedExecution<TResult>> | CheckpointPreparedExecution<TResult>;
    mapApplyError?: (error: unknown) => CheckpointPreparedFailureTransitionConfig<TFailure>;
    mapSuccessExecutionError?: (error: unknown) => CheckpointPreparedFailureTransitionConfig<TFailure>;
  }): CheckpointPreparedTransition<TResult> {
    const steps: CheckpointSequentialOperationStep<CheckpointFileApplyExecutionState<TResult>>[] = [
      {
        label: 'applyFiles',
        run: async state => {
          try {
            state.applyResult = await config.applyFiles();
          } catch (error) {
            if (!config.mapApplyError) {
              throw error;
            }

            throw new CheckpointPreparedFailureSignal(config.mapApplyError(error));
          }

          if (state.applyResult.errors.length > 0) {
            throw new CheckpointPreparedFailureSignal(config.buildFileFailure(state.applyResult));
          }
        },
      },
      {
        label: 'collectSuccessExecutionCommit',
        run: async state => {
          if (!state.applyResult) {
            throw new Error('checkpoint file apply result is required before collecting success execution');
          }

          try {
            const successCommit = await this.collectCheckpointPreparedExecution(
              await config.buildSuccessExecution(state.applyResult),
            );

            if ('result' in successCommit) {
              state.preparedFailureResult = successCommit.result;
              return;
            }

            state.resolvePreparedResult = successCommit.resolveResult;
            return successCommit.commitCallbacks;
          } catch (error) {
            if (!config.mapSuccessExecutionError) {
              throw error;
            }

            throw new CheckpointPreparedFailureSignal(config.mapSuccessExecutionError(error));
          }
        },
      },
    ];

    return this.collectCheckpointIOTransition<CheckpointFileApplyExecutionState<TResult>, TResult>({
      state: {},
      steps,
      resolveResult: state => {
        if (state.preparedFailureResult) {
          return state.preparedFailureResult;
        }

        if (!state.resolvePreparedResult) {
          throw new Error('checkpoint success transition is required before resolving local commit');
        }

        return state.resolvePreparedResult();
      },
      onFailure: error => {
        if (!(error instanceof CheckpointPreparedFailureSignal)) {
          throw error;
        }

        return this.createPreparedCheckpointFailureTransition<TResult, TFailure>(
          error.failure as CheckpointPreparedFailureTransitionConfig<TFailure>,
        );
      },
    });
  }

  private async prepareCheckpointRedoReplayArtifact(
    turnResponses: readonly TurnResponseTurn[],
    options: {
      publishSummary?: boolean;
      saveSession?: boolean;
    } & CheckpointRedoBoundaryCommitHooks,
  ): Promise<CheckpointReplayArtifact> {
    return this.buildCheckpointRedoReplayArtifact(turnResponses, options);
  }

  private async executePreparedCheckpointRedoReplayArtifact(
    artifact: CheckpointReplayArtifact,
  ): Promise<CheckpointRedoChatReplayResult> {
    const state: CheckpointRedoReplayExecutionState = {
      artifact,
      restoreAttempted: false,
      restoreCompleted: false,
      restoredSessionModel: undefined,
      appliedRollbackSteps: [],
    };

    artifact.applyPreparedSessionSave();

    try {
      state.restoreAttempted = true;
      state.restoredSessionModel = await artifact.applyPreparedReplayRestore();

      if (state.restoredSessionModel === false) {
        throw new Error('session model restore returned false');
      }

      state.restoreCompleted = true;
      await artifact.applyPreparedLocalCommit(state);
    } catch (error) {
      return this.handleCheckpointRedoReplayIOFailure(state, error);
    }

    if (!state.restoredSessionModel) {
      console.warn('[redoEdits] session model restore returned false while replaying checkpoint chat');
    }

    return { ok: true };
  }

  private isRedoMissingStagedRebuildError(error: unknown): boolean {
    return error instanceof Error
      && error.message === CheckpointReplayCoordinator.redoStagedRebuildRequiredError;
  }

  private composeCheckpointPreparedSequentialExecution<
    TState,
    TInner extends { ok: boolean },
    TOuter extends { ok: boolean },
  >(
    execution: CheckpointPreparedSequentialExecution<TState, TInner>,
    handlers: {
      onFailure: (
        failure: DeferredCheckpointTransitionFailure<TInner>,
      ) => Promise<DeferredCheckpointTransitionFailure<TOuter>> | DeferredCheckpointTransitionFailure<TOuter>;
      onSuccess: (
        success: DeferredCheckpointTransitionSuccess<TInner>,
      ) => Promise<TOuter> | TOuter;
    },
  ): CheckpointPreparedSequentialExecution<TState, TOuter> {
    let resolvedOuterResult: TOuter | undefined;

    return {
      state: execution.state,
      steps: execution.steps,
      prepareDeferredCommitCallbacks: state => {
        const deferredCommitCollection = execution.prepareDeferredCommitCallbacks?.(state);
        const commitCallbacks = deferredCommitCollection
          ? this.normalizeCheckpointDeferredCommitCollection(deferredCommitCollection)
          : [];

        commitCallbacks.push(async () => {
          const innerResult = await execution.resolveResult(state);
          resolvedOuterResult = innerResult.ok === false
            ? await handlers.onFailure(innerResult as DeferredCheckpointTransitionFailure<TInner>)
            : await handlers.onSuccess(innerResult as DeferredCheckpointTransitionSuccess<TInner>);
        });

        return commitCallbacks;
      },
      resolveResult: () => {
        if (!resolvedOuterResult) {
          throw new Error('checkpoint composed execution result is required before resolving local commit');
        }

        return resolvedOuterResult;
      },
      onIOFailure: async (error, state, failedStep) => {
        const failureResult = await execution.onIOFailure(error, state, failedStep);
        if (!this.isDeferredCheckpointTransitionResult(failureResult)) {
          return handlers.onFailure(failureResult as DeferredCheckpointTransitionFailure<TInner>);
        }

        if (failureResult.ok === false) {
          return handlers.onFailure(failureResult.result as DeferredCheckpointTransitionFailure<TInner>);
        }

        let resolvedFallbackResult: TOuter | undefined;
        const resolveFallbackResult = async (): Promise<void> => {
          const innerResult = await failureResult.resolveResult();
          resolvedFallbackResult = innerResult.ok === false
            ? await handlers.onFailure(innerResult as DeferredCheckpointTransitionFailure<TInner>)
            : await handlers.onSuccess(innerResult as DeferredCheckpointTransitionSuccess<TInner>);
        };

        return {
          ok: true,
          commitCallbacks: [...failureResult.commitCallbacks, resolveFallbackResult],
          resolveResult: () => {
            if (!resolvedFallbackResult) {
              throw new Error('checkpoint composed fallback result is required before resolving local commit');
            }

            return resolvedFallbackResult;
          },
        };
      },
    };
  }

  private async collectCheckpointPreparedExecution<TResult extends { ok: boolean }>(
    execution: CheckpointPreparedExecution<TResult>,
  ): Promise<CheckpointPreparedCollectedCommitResult<TResult>> {
    const { state, steps, prepareDeferredCommitCallbacks, resolveResult, onIOFailure } = execution;
    let currentStepLabel = 'io';
    const commitCallbacks: CheckpointDeferredCommitCallback[] = [];

    try {
      for (const step of steps) {
        currentStepLabel = step.label;
        const commitCollection = await step.run(state);
        if (commitCollection) {
          commitCallbacks.push(...this.normalizeCheckpointDeferredCommitCollection(commitCollection));
        }
      }
    } catch (error) {
      const failureResult = await onIOFailure(error, state, currentStepLabel);
      if (!this.isDeferredCheckpointTransitionResult(failureResult)) {
        return { result: failureResult as DeferredCheckpointTransitionFailure<TResult> };
      }

      if (failureResult.ok === false) {
        return { result: failureResult.result };
      }

      return {
        commitCallbacks: [...failureResult.commitCallbacks],
        resolveResult: failureResult.resolveResult,
      };
    }

    const deferredCommitCollection = prepareDeferredCommitCallbacks?.(state);
    if (deferredCommitCollection) {
      commitCallbacks.push(...this.normalizeCheckpointDeferredCommitCollection(deferredCommitCollection));
    }

    return {
      commitCallbacks: [...commitCallbacks],
      resolveResult: () => resolveResult(state),
    };
  }

  private async collectCheckpointIOTransition<TState, TResult extends { ok: boolean }>(config: {
    state: TState;
    steps: CheckpointSequentialOperationStep<TState>[];
    prepareDeferredCommitCallbacks?: (state: TState) => CheckpointDeferredCommitCollection | void;
    resolveResult: (state: TState) => Promise<TResult> | TResult;
    onFailure: (
      error: unknown,
      state: TState,
      failedStep: string,
    ) => Promise<DeferredCheckpointTransitionResult<TResult> | DeferredCheckpointTransitionFailure<TResult>>
      | DeferredCheckpointTransitionResult<TResult>
      | DeferredCheckpointTransitionFailure<TResult>;
  }): Promise<DeferredCheckpointTransitionResult<TResult>> {
    const { state, steps, prepareDeferredCommitCallbacks, resolveResult, onFailure } = config;
    let currentStepLabel = 'io';
    const commitCallbacks: CheckpointDeferredCommitCallback[] = [];

    try {
      for (const step of steps) {
        currentStepLabel = step.label;
        const commitCollection = await step.run(state);
        if (commitCollection) {
          commitCallbacks.push(...this.normalizeCheckpointDeferredCommitCollection(commitCollection));
        }
      }
    } catch (error) {
      const failureResult = await onFailure(error, state, currentStepLabel);
      if (this.isDeferredCheckpointTransitionResult(failureResult)) {
        return failureResult;
      }

      return {
        ok: false,
        result: failureResult,
      };
    }

    const deferredCommitCollection = prepareDeferredCommitCallbacks?.(state);
    if (deferredCommitCollection) {
      commitCallbacks.push(...this.normalizeCheckpointDeferredCommitCollection(deferredCommitCollection));
    }

    return {
      ok: true,
      commitCallbacks: [...commitCallbacks],
      resolveResult: () => resolveResult(state),
    };
  }

  private isDeferredCheckpointTransitionResult<TResult extends { ok: boolean }>(
    value: DeferredCheckpointTransitionResult<TResult> | DeferredCheckpointTransitionFailure<TResult>,
  ): value is DeferredCheckpointTransitionResult<TResult> {
    return typeof value === 'object'
      && value !== null
      && 'ok' in value
      && ('commitCallbacks' in value || 'result' in value);
  }

  private normalizeCheckpointDeferredCommitCollection(
    collection: CheckpointDeferredCommitCollection,
  ): CheckpointDeferredCommitCallback[] {
    return typeof collection === 'function' ? [collection] : [...collection];
  }

  private createPreparedSyncWorkspaceAction(): CheckpointPreparedSyncAction {
    const syncWorkspaceState = this.ctx.syncWorkspaceState?.bind(this.ctx);
    return async () => {
      await syncWorkspaceState?.();
    };
  }

  private createPreparedSessionSaveAction(config: {
    saveCurrentSession: CheckpointReplayCoordinatorContext['session']['saveCurrentSession'];
    saveTarget: HostSessionSaveTarget | null;
    hostProjectionState: HostTurnResponseState;
    shouldSave?: boolean;
  }): () => void {
    const { saveCurrentSession, saveTarget, hostProjectionState, shouldSave = true } = config;
    const frozenHostProjection = buildHostProjectionStateFromPersistedRecord({
      turnResponses: hostProjectionState.turnResponses.map(turn => this.cloneTurnResponseForSave(turn)),
    });

    return () => {
      if (!shouldSave) {
        return;
      }

      saveCurrentSession({
        hostProjection: frozenHostProjection,
        visibleChatList: frozenHostProjection.chatList,
        target: saveTarget,
      });
    };
  }

  private resolveCheckpointRestoreTarget(
    checkpointId: string,
    _requestedTurnId?: string,
  ): CheckpointRestoreTarget {
    const normalizedCheckpointId = typeof checkpointId === 'string' ? checkpointId.trim() : '';
    const timelineSessionResource = this.resolveCheckpointSessionId();
    const timelineState = timelineSessionResource
      ? this.ctx.readSessionCheckpointTimelineState?.(timelineSessionResource) ?? null
      : null;
    const timelineCheckpoint = timelineState?.checkpoints.find(
      candidate => candidate.checkpointId === normalizedCheckpointId,
    );
    if (normalizedCheckpointId && timelineSessionResource && timelineCheckpoint) {
      return {
        checkpointId: timelineCheckpoint.checkpointId,
        sessionResource: timelineSessionResource,
        requestId: timelineCheckpoint.requestId,
        ...(timelineCheckpoint.turnId ? { turnId: timelineCheckpoint.turnId } : {}),
      };
    }

    if (!normalizedCheckpointId) {
      throw new Error('checkpoint restore missing checkpointId');
    }
    if (!timelineSessionResource) {
      throw new Error(`checkpoint restore missing sessionResource: ${normalizedCheckpointId}`);
    }
    if (normalizeString(timelineState?.sessionResource) !== timelineSessionResource) {
      throw new Error(`checkpoint restore sessionResource mismatch: ${normalizedCheckpointId}`);
    }
    throw new Error(`checkpoint restore missing timeline checkpoint: ${normalizedCheckpointId}`);
  }

  private resolveCheckpointRestoreTruncationBoundary(params: {
    checkpointId: string;
    sessionId: string;
    liveTurnResponses: readonly TurnResponseTurn[];
    restoreTargetTurnId?: string;
    restoreTargetRequestId?: string;
    requestedTurnId?: string;
    requestedListIndex?: number;
  }): {
    truncateIndex: number;
    turnId?: string;
    listIndex?: number;
  } {
    const checkpointId = normalizeString(params.checkpointId);
    const restoreTargetTurnId = normalizeString(params.restoreTargetTurnId);
    const restoreTargetRequestId = normalizeString(params.restoreTargetRequestId);
    const requestedTurnId = normalizeString(params.requestedTurnId);
    const timelineState = this.ctx.readSessionCheckpointTimelineState?.(params.sessionId) ?? null;
    const timelineCheckpoint = timelineState?.checkpoints.find(checkpoint => checkpoint.checkpointId === checkpointId);
    const timelineTurnId = normalizeString(timelineCheckpoint?.turnId);

    const findTurnIndexById = (turnId: string): number => {
      if (!turnId) {
        return -1;
      }
      return params.liveTurnResponses.findIndex(turn => normalizeString(turn.turnId) === turnId);
    };

    let truncateIndex = checkpointId
      ? params.liveTurnResponses.findIndex(turn => normalizeString(turn.request?.metadata?.checkpointId) === checkpointId)
      : -1;
    if (truncateIndex < 0) {
      truncateIndex = findTurnIndexById(restoreTargetTurnId);
    }
    if (truncateIndex < 0) {
      truncateIndex = findTurnIndexById(restoreTargetRequestId);
    }
    if (truncateIndex < 0) {
      truncateIndex = findTurnIndexById(timelineTurnId);
    }
    if (
      truncateIndex < 0
      && typeof timelineCheckpoint?.turnIndex === 'number'
      && Number.isFinite(timelineCheckpoint.turnIndex)
    ) {
      const timelineIndex = Math.trunc(timelineCheckpoint.turnIndex);
      const timelineTurn = params.liveTurnResponses[timelineIndex];
      if (timelineTurn && (!checkpointId || normalizeString(timelineTurn.request?.metadata?.checkpointId) === checkpointId)) {
        truncateIndex = timelineIndex;
      }
    }
    if (truncateIndex < 0) {
      throw new Error(`checkpoint restore cannot resolve turn response boundary: ${checkpointId}`);
    }

    const turnId = normalizeString(params.liveTurnResponses[truncateIndex]?.turnId)
      || restoreTargetTurnId
      || restoreTargetRequestId
      || timelineTurnId
      || undefined;
    if (requestedTurnId && turnId && requestedTurnId !== turnId) {
      console.warn('[AilyChat][CheckpointRestoreTrace]', {
        phase: 'stale-ui-target',
        checkpointId,
        requestedTurnId,
        resolvedTurnId: turnId,
        restoreTargetTurnId: restoreTargetTurnId || null,
        restoreTargetRequestId: restoreTargetRequestId || null,
        timelineTurnId: timelineTurnId || null,
        liveTurnIds: summarizeTurnResponseIds(params.liveTurnResponses),
      });
    }
    const listIndex = turnId && requestedTurnId === turnId && typeof params.requestedListIndex === 'number'
      ? params.requestedListIndex
      : undefined;

    return {
      truncateIndex,
      ...(turnId ? { turnId } : {}),
      ...(typeof listIndex === 'number' ? { listIndex } : {}),
    };
  }

  private resolveCheckpointSessionId(): string {
    const viewSessionResource = typeof this.ctx.readCurrentViewSessionResource === 'function'
      ? this.ctx.readCurrentViewSessionResource()
      : null;
    const normalizedViewResource = typeof viewSessionResource === 'string'
      ? viewSessionResource.trim()
      : '';
    if (normalizedViewResource) {
      return normalizedViewResource;
    }

    return '';
  }

  private resolveCheckpointSaveTarget(sessionId: string): HostSessionSaveTarget | null {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return null;
    }

    return this.ctx.buildExecutionSaveTarget?.(normalizedSessionId) ?? null;
  }

  private readSessionModelTurnResponses(sessionId: string | null | undefined): readonly TurnResponseTurn[] {
    return this.ctx.readSessionTurnResponses(sessionId);
  }

  private cloneTurnResponseForSave(turn: TurnResponseTurn): TurnResponseTurn {
    const responseModel = cloneTurnResponseModelSidecar(turn.responseModel);
    const {
      slashCommand: _slashCommand,
      responseId: _responseId,
      responseMarkdownInfo: _responseMarkdownInfo,
      modelState: _modelState,
      vote: _vote,
      timestamp: _timestamp,
      elapsedMs: _elapsedMs,
      timeSpentWaiting: _timeSpentWaiting,
      completionTokens: _completionTokens,
      ...responseWithoutPersistedData
    } = turn.response as TurnResponseTurn['response'] & PersistedHostResponseData;

    return {
      ...turn,
      request: { ...turn.request },
      rounds: turn.rounds.map((round) => {
        const summary = normalizeTurnResponseSummaryPreview(round.summary);

        return {
          ...round,
          toolCalls: (round.toolCalls ?? []).map(toolCall => ({ ...toolCall })),
          ...(summary ? { summary } : {}),
        };
      }),
      ...(turn.usage ? { usage: { ...turn.usage } } : {}),
      response: {
        ...responseWithoutPersistedData,
        ...(turn.response.usedContext
          ? {
            usedContext: {
              ...turn.response.usedContext,
              documents: turn.response.usedContext.documents.map(document => ({
                ...document,
                ranges: document.ranges.map(range => ({ ...range })),
              })),
            },
          }
          : {}),
        ...((turn.response.contentReferences?.length ?? 0) > 0
          ? {
            contentReferences: turn.response.contentReferences!.map(reference => ({
              ...reference,
              ...(reference.options
                ? {
                  options: {
                    ...reference.options,
                    ...(reference.options.status ? { status: { ...reference.options.status } } : {}),
                    ...(reference.options.diffMeta ? { diffMeta: { ...reference.options.diffMeta } } : {}),
                  },
                }
                : {}),
            })),
          }
          : {}),
        ...((turn.response.codeCitations?.length ?? 0) > 0
          ? { codeCitations: turn.response.codeCitations!.map(citation => ({ ...citation })) }
          : {}),
        ...((turn.response.progressMessages?.length ?? 0) > 0
          ? { progressMessages: turn.response.progressMessages!.map(message => ({ ...message })) }
          : {}),
        parts: [...turn.response.parts],
      },
      ...(responseModel ? { responseModel } : {}),
    };
  }

  private createHandledCheckpointDeferredCommitCallback<TState, TResult extends { ok: boolean }>(config: {
    state: TState;
    apply: (state: TState) => Promise<void> | void;
    onFailure: (
      error: unknown,
      state: TState,
    ) => Promise<DeferredCheckpointTransitionFailure<TResult>>
      | DeferredCheckpointTransitionFailure<TResult>;
    storeFailureResult: (state: TState, result: TResult) => void;
    afterApply?: (state: TState) => void;
  }): CheckpointDeferredCommitCallback {
    const { state, apply, onFailure, storeFailureResult, afterApply } = config;

    return async () => {
      try {
        await apply(state);
        afterApply?.(state);
      } catch (error) {
        storeFailureResult(state, await onFailure(error, state));
      }
    };
  }

  private createCheckpointRestoreCommitSequentialExecution(
    artifact: CheckpointRestoreCommitArtifact,
  ): CheckpointPreparedSequentialExecution<
    {
      artifact: CheckpointRestoreCommitArtifact;
      deferredCommitFailureResult?: CheckpointRestoreCommitTransitionResult;
    },
    CheckpointRestoreCommitTransitionResult
  > {
    return {
      state: { artifact },
      steps: [
        {
          label: 'syncWorkspaceState',
          run: ({ artifact: currentArtifact }) => currentArtifact.applyPreparedSyncWorkspaceState(),
        },
      ],
      prepareDeferredCommitCallbacks: state => this.createHandledCheckpointDeferredCommitCallback({
        state,
        apply: ({ artifact: currentArtifact }) => currentArtifact.applyPreparedLocalCommit(),
        onFailure: (error, { artifact: currentArtifact }) =>
          currentArtifact.handlePreparedCommitIOFailure(error, 'applyPreparedLocalCommit'),
        storeFailureResult: (currentState, result) => {
          currentState.deferredCommitFailureResult = result;
        },
      }),
      resolveResult: state => state.deferredCommitFailureResult ?? { ok: true },
      onIOFailure: (error, { artifact: currentArtifact }, failedStep) =>
        currentArtifact.handlePreparedCommitIOFailure(error, failedStep),
    };
  }

  private createCheckpointRedoReplaySequentialExecution(
    artifact: CheckpointReplayArtifact,
  ): CheckpointPreparedSequentialExecution<
    CheckpointRedoReplayExecutionState,
    CheckpointRedoChatReplayResult
  > {
    return {
      state: {
        artifact,
        restoreAttempted: false,
        restoreCompleted: false,
        restoredSessionModel: undefined,
        appliedRollbackSteps: [],
      },
      steps: [
        {
          label: 'checkpointTimelineCommit',
          run: async ({ artifact: currentArtifact }) => {
            await currentArtifact.applyPreparedCheckpointTimelineCommit();
          },
        },
        {
          label: 'saveSession',
          run: ({ artifact: currentArtifact }) => {
            currentArtifact.applyPreparedSessionSave();
          },
        },
        {
          label: 'restoreSessionModel',
          run: async state => {
            state.restoreAttempted = true;
            state.restoredSessionModel = await state.artifact.applyPreparedReplayRestore();

            if (state.restoredSessionModel === false) {
              throw new Error('session model restore returned false');
            }

            state.restoreCompleted = true;
          },
        },
      ],
      prepareDeferredCommitCallbacks: state => this.createHandledCheckpointDeferredCommitCallback({
        state,
        apply: currentState => currentState.artifact.applyPreparedLocalCommit(currentState),
        onFailure: error => this.handleCheckpointRedoReplayIOFailure(state, error),
        storeFailureResult: (currentState, result) => {
          currentState.deferredCommitFailureResult = result;
        },
        afterApply: currentState => {
          if (!currentState.restoredSessionModel) {
            console.warn('[redoEdits] session model restore returned false while replaying checkpoint chat');
          }
        },
      }),
      resolveResult: state => state.deferredCommitFailureResult ?? { ok: true },
      onIOFailure: (error, state) => this.handleCheckpointRedoReplayIOFailure(state, error),
    };
  }

  private buildReplayFailureResult(
    error: unknown,
    rollbackErrors: string[],
    rolledBackOnError: boolean,
  ): CheckpointRedoChatReplayFailure {
    const errorMessage = error instanceof Error && typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : '恢复聊天历史失败';

    return {
      ok: false,
      errorMessage,
      rollbackErrors: [...rollbackErrors],
      rolledBackOnError,
    };
  }
}
