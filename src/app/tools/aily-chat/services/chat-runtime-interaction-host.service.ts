import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import type { AskUserAnswer, AskUserFullResponse, AskUserQuestion, AskUserPresentationContext } from '../core/ask-user';
import { AilyHost } from '../core/host';
import type { IFileWatchHandle } from '../core/host-api';
import { readToolApprovalCommand } from '../core/tool-approval-input';
import { isTerminalCommandToolName, normalizeReadSideToolName } from '../core/tool-name-normalizer';
import type { ToolApprovalAction, ToolApprovalRequest, ToolApprovalScope } from '../helpers/tool-approval-ui';
import { resolveBlocklyArtifactReferenceTarget } from '../helpers/chat-artifact-reference';
import { notifyAwaitingUserFeedbackIfBackground } from '../helpers/user-feedback-notify.helper';
import {
  listBlocklyCommandSessionSnapshots,
  setBlocklyCommandSessionBackground,
  stopBlocklyCommandSession,
  subscribeBlocklyCommandSessionUpdates,
  type BlocklyCommandSessionSnapshot,
} from '../helpers/lex-agent-bootstrap';
import type {
  ChatRuntimeHostInteractionRequest,
  ChatRuntimeHostInteractionSnapshot,
  ChatRuntimeHostSessionProcessSummary,
} from '../core/chat-runtime-host-contract';
import type { ChatRuntimeOwnerInteractionHostPort } from './chat-runtime-owner-ports';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';
import { ChatRuntimeOwnerToolApprovalPolicyService } from './chat-runtime-owner-tool-approval-policy.service';

function shouldTraceRuntimeInteraction(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceRuntimeInteraction', [
    '__AILY_CHAT_TRACE_RUNTIME_INTERACTION__',
    'AILY_CHAT_TRACE_RUNTIME_INTERACTION',
  ]);
}

function escapeRegExpCharacters(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTerminalCommand(command: unknown): string {
  return typeof command === 'string' ? command.trim() : '';
}

function buildExactTerminalRule(command: string): string {
  return `/^${escapeRegExpCharacters(command)}$/`;
}

export interface RuntimeQuestionWidgetState {
  readonly sessionId: string;
  readonly partId: string;
  readonly context?: AskUserPresentationContext;
  readonly data: {
    partId: string;
    isHistory: false;
    questions: AskUserQuestion[];
    answers?: Record<string, AskUserAnswer>;
  };
}

export interface RuntimeConfirmationDecision {
  readonly approved: boolean;
  readonly scope?: ToolApprovalScope;
  readonly reason?: string;
  readonly actionId?: string;
  readonly sideEffectOnly?: boolean;
}

export interface RuntimeConfirmationWidgetState {
  readonly approvalTraceId?: string;
  readonly sessionId: string;
  readonly id: string;
  readonly kind: 'approval' | 'confirmation';
  readonly partId: string;
  readonly askId?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly data: {
    kind: 'approval' | 'confirmation';
    approvalTraceId?: string;
    partId: string;
    askId?: string;
    toolCallId?: string;
    toolName?: string;
    title: string;
    subtitle?: string;
    message: string;
    args?: Record<string, unknown>;
    actions: readonly ToolApprovalAction[];
    primaryScope: ToolApprovalScope;
    primaryLabel?: string;
    primaryTooltip?: string;
    rejectLabel?: string;
    rejectTooltip?: string;
    resolved?: boolean;
    approved?: boolean;
    scope?: ToolApprovalScope;
  };
}

export interface RuntimePlanReviewAction {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly default?: boolean;
  readonly permissionLevel?: 'autopilot';
}

export interface RuntimePlanReviewDecision {
  readonly approved: boolean;
  readonly actionId?: string;
  readonly feedback?: string;
}

export interface RuntimePlanReviewWidgetState {
  readonly sessionId: string;
  readonly id: string;
  readonly data: {
    title: string;
    planUri?: string;
    content: string;
    actions: readonly RuntimePlanReviewAction[];
    canProvideFeedback: boolean;
    resolved?: boolean;
    approved?: boolean;
    actionId?: string;
    feedback?: string;
  };
}

export type RuntimeCommandSessionActionId = 'continue_background' | 'stop';

export interface RuntimeCommandSessionActionRequest {
  readonly actionId: RuntimeCommandSessionActionId;
  readonly processId: string;
  readonly outputSessionId?: string;
  readonly outputFilePath?: string;
}

export interface RuntimeCommandSessionActionResult {
  readonly ok: boolean;
  readonly actionId: RuntimeCommandSessionActionId;
  readonly processId: string;
  readonly snapshot?: BlocklyCommandSessionSnapshot;
  readonly error?: string;
}

type QuestionRuntimeEntry = RuntimeQuestionWidgetState & {
  readonly resolve: (result: AskUserFullResponse | undefined) => void;
  readonly remote?: boolean;
};

type ConfirmationRuntimeEntry = RuntimeConfirmationWidgetState & {
  readonly resolve: (result: RuntimeConfirmationDecision) => void;
  readonly onAction?: (actionId: string) => void;
  readonly promise: Promise<RuntimeConfirmationDecision>;
  readonly remote?: boolean;
};

type PlanReviewRuntimeEntry = RuntimePlanReviewWidgetState & {
  readonly resolve: (result: RuntimePlanReviewDecision) => void;
  readonly remote?: boolean;
};

interface RuntimeApprovalState {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly approvalTraceId?: string;
  readonly toolName?: string;
  readonly request: ToolApprovalRequest;
  readonly status: 'pending' | 'resolved';
  readonly result?: RuntimeConfirmationDecision;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resolvedAt?: number;
}

type RuntimeInteractionSnapshotListener = (snapshot: ChatRuntimeHostInteractionSnapshot) => void;
type RuntimeInteractionDecisionRequest = Omit<
  ChatRuntimeHostInteractionRequest,
  'viewId' | 'visibleAttachmentGeneration'
>;
type RuntimeInteractionRemoteResolver = (
  request: RuntimeInteractionDecisionRequest,
) => Promise<ChatRuntimeHostInteractionSnapshot | null>;

interface PlanReviewFileSyncState {
  readonly id: string;
  readonly absolutePath: string;
  readonly handle?: IFileWatchHandle | void;
}

@Injectable()
export class ChatRuntimeInteractionHostService implements ChatRuntimeOwnerInteractionHostPort {
  private readonly destroyRef = inject(DestroyRef);
  private readonly translate = inject(TranslateService);
  private readonly toolApprovalPolicy = inject(ChatRuntimeOwnerToolApprovalPolicyService);
  private readonly _questionEntries = signal<Record<string, QuestionRuntimeEntry | undefined>>({});
  private readonly _confirmationEntries = signal<Record<string, readonly ConfirmationRuntimeEntry[] | undefined>>({});
  private readonly _confirmationActiveIndices = signal<Record<string, number | undefined>>({});
  private readonly _planReviewEntries = signal<Record<string, PlanReviewRuntimeEntry | undefined>>({});
  private readonly _approvalStates = new Map<string, RuntimeApprovalState>();
  private readonly _planReviewFileSyncs = new Map<string, PlanReviewFileSyncState>();
  private readonly _backgroundCommandSessions = new Set<string>();
  private readonly _remoteProcessInventories = new Map<string, {
    readonly processInventoryRevision: number;
    readonly processes: readonly ChatRuntimeHostSessionProcessSummary[];
  }>();
  private readonly snapshotListeners = new Set<RuntimeInteractionSnapshotListener>();
  private readonly remoteResolvers = new Map<string, RuntimeInteractionRemoteResolver>();
  private interactionRevision = 0;

  constructor() {
    const subscription = subscribeBlocklyCommandSessionUpdates((sessionId) => {
      if (sessionId) {
        this.emitSnapshot(sessionId);
      }
    });
    this.destroyRef.onDestroy(() => {
      subscription.dispose();
    });
  }

  onSnapshot(listener: RuntimeInteractionSnapshotListener): { dispose(): void } {
    this.snapshotListeners.add(listener);
    return {
      dispose: () => {
        this.snapshotListeners.delete(listener);
      },
    };
  }

  readSnapshot(sessionId: string): ChatRuntimeHostInteractionSnapshot {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    return this.buildSnapshot(normalizedSessionId);
  }

  applyHostSnapshot(
    snapshot: ChatRuntimeHostInteractionSnapshot,
    remoteResolver: RuntimeInteractionRemoteResolver,
  ): void {
    const sessionId = this.normalizeSessionId(snapshot.sessionId);
    this.remoteResolvers.set(sessionId, remoteResolver);

    const question = snapshot.question as unknown as RuntimeQuestionWidgetState | null;
    const confirmations = (snapshot.confirmationQueue ?? []) as unknown as readonly RuntimeConfirmationWidgetState[];
    const planReview = snapshot.activePlanReview as unknown as RuntimePlanReviewWidgetState | null;

    const nextQuestions = { ...this._questionEntries() };
    if (question) {
      const existingQuestion = nextQuestions[sessionId];
      nextQuestions[sessionId] = existingQuestion && !existingQuestion.remote && existingQuestion.partId === question.partId
        ? {
            ...question,
            resolve: existingQuestion.resolve,
          }
        : {
            ...question,
            remote: true,
            resolve: (result) => {
              void remoteResolver({
                sessionId,
                kind: 'question.complete',
                id: question.partId,
                payload: { result },
              });
            },
          };
    } else {
      delete nextQuestions[sessionId];
    }
    this._questionEntries.set(nextQuestions);

    const nextConfirmations = { ...this._confirmationEntries() };
    if (confirmations.length > 0) {
      const existingConfirmations = nextConfirmations[sessionId] ?? [];
      nextConfirmations[sessionId] = confirmations.map((confirmation) => ({
        ...confirmation,
        ...this.resolveConfirmationEntryProjection(sessionId, confirmation, existingConfirmations, remoteResolver),
      }));
    } else {
      delete nextConfirmations[sessionId];
    }
    this._confirmationEntries.set(nextConfirmations);
    this._confirmationActiveIndices.set({
      ...this._confirmationActiveIndices(),
      [sessionId]: snapshot.activeConfirmationIndex ?? 0,
    });

    const nextPlanReviews = { ...this._planReviewEntries() };
    if (planReview) {
      const existingPlanReview = nextPlanReviews[sessionId];
      nextPlanReviews[sessionId] = existingPlanReview && !existingPlanReview.remote && existingPlanReview.id === planReview.id
        ? {
            ...planReview,
            resolve: existingPlanReview.resolve,
          }
        : {
            ...planReview,
            remote: true,
            resolve: (result) => {
              void remoteResolver({
                sessionId,
                kind: 'planReview.resolve',
                id: planReview.id,
                payload: { result },
              });
            },
          };
    } else {
      delete nextPlanReviews[sessionId];
    }
    this._planReviewEntries.set(nextPlanReviews);

    for (const key of [...this._backgroundCommandSessions]) {
      if (key.startsWith(`${sessionId}::`)) {
        this._backgroundCommandSessions.delete(key);
      }
    }
    for (const key of snapshot.backgroundCommandSessionKeys ?? []) {
      if (typeof key === 'string' && key.startsWith(`${sessionId}::`)) {
        this._backgroundCommandSessions.add(key);
      }
    }

    if (Array.isArray(snapshot.processes)) {
      this._remoteProcessInventories.set(sessionId, {
        processInventoryRevision: typeof snapshot.processInventoryRevision === 'number'
          ? snapshot.processInventoryRevision
          : snapshot.revision,
        processes: snapshot.processes.filter(this.isProcessSummary),
      });
    } else if (typeof snapshot.processInventoryRevision === 'number') {
      this._remoteProcessInventories.set(sessionId, {
        processInventoryRevision: snapshot.processInventoryRevision,
        processes: [],
      });
    }
  }

  async requestCommandSessionAction(
    sessionId: string,
    request: RuntimeCommandSessionActionRequest,
  ): Promise<RuntimeCommandSessionActionResult> {
    const remoteResolver = this.remoteResolvers.get(this.normalizeSessionId(sessionId));
    if (remoteResolver) {
      try {
        const snapshot = await remoteResolver({
          sessionId,
          kind: 'commandSession.action',
          payload: { request },
        });
        const result = (snapshot as unknown as { commandSessionActionResult?: RuntimeCommandSessionActionResult } | null)
          ?.commandSessionActionResult;
        if (result) {
          return result;
        }
      } catch (error) {
        if (!this.isStaleCommandSessionActionError(error)) {
          throw error;
        }
      }
    }

    const processId = request.processId?.trim();
    if (!processId) {
      return {
        ok: false,
        actionId: request.actionId,
        processId: '',
        error: this.translate.instant('AILY_CHAT.PROCESS_ERROR_MISSING_ID'),
      };
    }

    if (request.actionId === 'continue_background') {
      setBlocklyCommandSessionBackground(sessionId, processId, true);
      this.markCommandSessionBackground(sessionId, processId);
      return { ok: true, actionId: request.actionId, processId };
    }

    if (request.actionId === 'stop') {
      const snapshot = await stopBlocklyCommandSession(processId, { yieldTimeMs: 250 });
      setBlocklyCommandSessionBackground(sessionId, processId, false);
      this.clearCommandSessionBackground(sessionId, processId);
      return snapshot
        ? { ok: true, actionId: request.actionId, processId, snapshot }
        : {
            ok: false,
            actionId: request.actionId,
            processId,
            error: this.translate.instant('AILY_CHAT.PROCESS_ERROR_NOT_FOUND', { processId }),
          };
    }

    return {
      ok: false,
      actionId: request.actionId,
      processId,
      error: this.translate.instant('AILY_CHAT.PROCESS_ERROR_UNSUPPORTED_ACTION', { actionId: request.actionId }),
    };
  }

  markCommandSessionBackground(sessionId: string, processId: string): void {
    const key = this.getCommandSessionDisplayKey(sessionId, processId);
    if (key) {
      this._backgroundCommandSessions.add(key);
      this.emitSnapshot(sessionId);
    }
  }

  clearCommandSessionBackground(sessionId: string, processId: string): void {
    const key = this.getCommandSessionDisplayKey(sessionId, processId);
    if (key) {
      this._backgroundCommandSessions.delete(key);
      this.emitSnapshot(sessionId);
    }
  }

  isCommandSessionBackground(sessionId: string, processId: string | undefined): boolean {
    const key = this.getCommandSessionDisplayKey(sessionId, processId);
    return !!key && this._backgroundCommandSessions.has(key);
  }

  private getCommandSessionDisplayKey(sessionId: string, processId: string | undefined): string | null {
    const normalizedProcessId = processId?.trim();
    if (!normalizedProcessId) {
      return null;
    }
    return `${sessionId || 'default'}::${normalizedProcessId}`;
  }

  getQuestionWidget(sessionId: string): RuntimeQuestionWidgetState | null {
    return this._questionEntries()[sessionId] ?? null;
  }

  presentQuestion(
    sessionId: string,
    partId: string,
    questions: AskUserQuestion[],
    context?: AskUserPresentationContext,
  ): Promise<AskUserFullResponse | undefined> {
    this.clearQuestion(sessionId);

    return new Promise<AskUserFullResponse | undefined>((resolve) => {
      const current = this._questionEntries();
      this._questionEntries.set({
        ...current,
        [sessionId]: {
          sessionId,
          partId,
          context,
          resolve,
          data: {
            partId,
            isHistory: false,
            questions,
          },
        },
      });
      this.emitSnapshot(sessionId);
      notifyAwaitingUserFeedbackIfBackground('Aily', '有问题需要你回答');
    });
  }

  completeQuestion(sessionId: string, result: AskUserFullResponse | undefined): void {
    const entry = this._questionEntries()[sessionId];
    if (!entry) {
      return;
    }

    entry.resolve(result);
    this.deleteQuestionEntry(sessionId);
  }

  resolveQuestionCompat(sessionId: string, answer: string, wasFreeform: boolean): void {
    const entry = this._questionEntries()[sessionId];
    if (!entry) {
      throw new Error('resolveAskUserResponse requires an active question partId.');
    }

    const firstQuestion = entry.data.questions[0];
    const questionKey = firstQuestion?.question || 'unknown';
    const answerRecord: AskUserAnswer = wasFreeform
      ? { selected: [], freeText: answer, skipped: false }
      : { selected: [answer], freeText: null, skipped: false };

    this.completeQuestion(sessionId, {
      answers: {
        [questionKey]: answerRecord,
      },
    });
  }

  skipQuestion(sessionId: string): void {
    const entry = this._questionEntries()[sessionId];
    if (!entry) {
      throw new Error('skipAskUserResponse requires an active question partId.');
    }

    const remoteResolver = this.remoteResolvers.get(this.normalizeSessionId(sessionId));
    if (remoteResolver) {
      void remoteResolver({ sessionId, kind: 'question.skip', id: entry.partId });
      this.deleteQuestionEntry(sessionId);
      return;
    }

    const answers = Object.fromEntries(entry.data.questions.map((question) => [question.question, {
      selected: [],
      freeText: null,
      skipped: true,
    } satisfies AskUserAnswer]));

    this.completeQuestion(sessionId, { answers });
  }

  clearQuestion(sessionId: string): void {
    const entry = this._questionEntries()[sessionId];
    if (!entry) {
      return;
    }

    entry.resolve(undefined);
    this.deleteQuestionEntry(sessionId);
  }

  getConfirmationQueue(sessionId: string): readonly RuntimeConfirmationWidgetState[] {
    return this._confirmationEntries()[sessionId] ?? [];
  }

  getActiveConfirmationIndex(sessionId: string): number {
    const queue = this.getConfirmationQueue(sessionId);
    if (queue.length === 0) {
      return 0;
    }

    const rawIndex = this._confirmationActiveIndices()[sessionId] ?? 0;
    return Math.max(0, Math.min(rawIndex, queue.length - 1));
  }

  getActiveConfirmation(sessionId: string): RuntimeConfirmationWidgetState | null {
    const queue = this.getConfirmationQueue(sessionId);
    if (queue.length === 0) {
      return null;
    }

    return queue[this.getActiveConfirmationIndex(sessionId)] ?? null;
  }

  getActivePlanReview(sessionId: string): RuntimePlanReviewWidgetState | null {
    return this._planReviewEntries()[sessionId] ?? null;
  }

  navigateConfirmation(sessionId: string, delta: number): void {
    const active = this.getActiveConfirmation(sessionId);
    const remoteResolver = this.remoteResolvers.get(this.normalizeSessionId(sessionId));
    if (remoteResolver && (active as ConfirmationRuntimeEntry | null)?.remote) {
      void remoteResolver({ sessionId, kind: 'confirmation.navigate', id: active.id, delta });
    }

    const queue = this.getConfirmationQueue(sessionId);
    if (queue.length <= 1) {
      return;
    }

    const nextIndex = (this.getActiveConfirmationIndex(sessionId) + delta + queue.length) % queue.length;
    this._confirmationActiveIndices.set({
      ...this._confirmationActiveIndices(),
      [sessionId]: nextIndex,
    });
    this.emitSnapshot(sessionId);
  }

  presentToolApproval(sessionId: string, request: ToolApprovalRequest): Promise<RuntimeConfirmationDecision> {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const actions = Array.isArray(request.actions) ? request.actions : [];
    const primaryScope = request.primaryScope ?? 'once';
    const approvalTraceId = this.normalizeApprovalTraceId(request);
    const normalizedRequest = { ...request, approvalTraceId };
    const approvalState = this.upsertApprovalState(normalizedSessionId, normalizedRequest);
    if (shouldTraceRuntimeInteraction()) {
      console.info('[AilyChat][RuntimeApprovalQueue]', {
        phase: 'present-tool-approval',
        sessionId: normalizedSessionId,
        toolCallId: approvalState.toolCallId,
        toolName: approvalState.toolName,
        approvalTraceId: approvalState.approvalTraceId,
        actionCount: actions.length,
        primaryScope,
        queueLength: this.getConfirmationQueue(normalizedSessionId).length,
      });
    }

    return this.enqueueConfirmation(normalizedSessionId, {
      sessionId: normalizedSessionId,
      approvalTraceId: approvalState.approvalTraceId,
      id: approvalState.toolCallId,
      kind: 'approval',
      partId: approvalState.toolCallId,
      toolCallId: approvalState.toolCallId,
      toolName: approvalState.toolName,
      data: {
        kind: 'approval',
        approvalTraceId: approvalState.approvalTraceId,
        partId: approvalState.toolCallId,
        toolCallId: approvalState.toolCallId,
        toolName: approvalState.toolName,
        title: normalizedRequest.title || this.translate.instant('AILY_CHAT.PROCESS_APPROVAL_DEFAULT_TITLE'),
        subtitle: normalizedRequest.subtitle,
        message: normalizedRequest.message,
        args: normalizedRequest.args,
        actions,
        primaryScope,
      },
    });
  }

  presentConfirmation(
    sessionId: string,
    confirmation: {
      askId: string;
      partId: string;
      toolName?: string;
      title: string;
      subtitle?: string;
      message: string;
      args?: Record<string, unknown>;
      actions: readonly ToolApprovalAction[];
      primaryScope: ToolApprovalScope;
      primaryLabel?: string;
      primaryTooltip?: string;
      rejectLabel?: string;
      rejectTooltip?: string;
      onAction?: (actionId: string) => void;
    },
  ): Promise<RuntimeConfirmationDecision> {
    return this.enqueueConfirmation(sessionId, {
      sessionId,
      id: confirmation.partId,
      kind: 'confirmation',
      partId: confirmation.partId,
      askId: confirmation.askId,
      toolName: confirmation.toolName,
      data: {
        kind: 'confirmation',
        partId: confirmation.partId,
        askId: confirmation.askId,
        toolName: confirmation.toolName,
        title: confirmation.title,
        subtitle: confirmation.subtitle,
        message: confirmation.message,
        args: confirmation.args,
        actions: confirmation.actions,
        primaryScope: confirmation.primaryScope,
        primaryLabel: confirmation.primaryLabel,
        primaryTooltip: confirmation.primaryTooltip,
        rejectLabel: confirmation.rejectLabel,
        rejectTooltip: confirmation.rejectTooltip,
      },
      onAction: confirmation.onAction,
    });
  }

  presentPlanReview(
    sessionId: string,
    review: {
      id: string;
      title: string;
      planUri?: string;
      content: string;
      actions: readonly RuntimePlanReviewAction[];
      canProvideFeedback: boolean;
    },
  ): Promise<RuntimePlanReviewDecision> {
    this.clearPlanReview(sessionId);
    const content = this.resolvePlanReviewContentFromFile(sessionId, review.planUri, review.content);

    return new Promise<RuntimePlanReviewDecision>((resolve) => {
      const current = this._planReviewEntries();
      this._planReviewEntries.set({
        ...current,
        [sessionId]: {
          sessionId,
          id: review.id,
          data: {
            title: review.title,
            planUri: review.planUri,
            content,
            actions: review.actions,
            canProvideFeedback: review.canProvideFeedback,
          },
          resolve,
        },
      });

      this.installPlanReviewFileSync(sessionId, review.id, review.planUri);
      this.emitSnapshot(sessionId);
      notifyAwaitingUserFeedbackIfBackground('Aily', '计划已生成，等待你的审核');
    });
  }

  triggerConfirmationAction(sessionId: string, id: string, actionId: string): void {
    const queue = this._confirmationEntries()[sessionId];
    if (!queue || queue.length === 0) {
      return;
    }

    const target = queue.find(entry => entry.id === id);
    const remoteResolver = this.remoteResolvers.get(this.normalizeSessionId(sessionId));
    if (remoteResolver && target?.remote) {
      void remoteResolver({
        sessionId,
        kind: 'confirmation.action',
        id,
        payload: { actionId },
      });
      return;
    }
    target?.onAction?.(actionId);
  }

  approveActiveConfirmation(sessionId: string, scope: ToolApprovalScope, actionId?: string): void {
    const active = this.getActiveConfirmation(sessionId);
    if (!active) {
      return;
    }

    this.resolveConfirmation(sessionId, active.id, {
      approved: true,
      scope,
      actionId,
    });
  }

  rejectActiveConfirmation(
    sessionId: string,
    reason = this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_REJECT_REASON'),
  ): void {
    const active = this.getActiveConfirmation(sessionId);
    if (!active) {
      return;
    }

    this.resolveConfirmation(sessionId, active.id, {
      approved: false,
      reason,
    });
  }

  resolveToolApproval(sessionId: string, toolCallId: string, result: RuntimeConfirmationDecision): void {
    this.resolveConfirmation(sessionId, toolCallId, result);
  }

  resolveConfirmation(sessionId: string, id: string, result: RuntimeConfirmationDecision): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const queue = this._confirmationEntries()[normalizedSessionId];
    if (!queue || queue.length === 0) {
      return;
    }

    const targetIndex = queue.findIndex((entry) => entry.id === id);
    if (targetIndex < 0) {
      return;
    }

    const target = queue[targetIndex];
    if (target.kind === 'approval') {
      const approvalState = this.resolveApprovalState(normalizedSessionId, target.toolCallId ?? target.id, result);
      this.rememberResolvedApproval(
        normalizedSessionId,
        approvalState?.request ?? this.createApprovalRequestFromConfirmation(target),
        result,
      );
    }
    if (shouldTraceRuntimeInteraction()) {
      console.info('[AilyChat][RuntimeApprovalQueue]', {
        phase: 'resolve-confirmation',
        sessionId: normalizedSessionId,
        id,
        kind: target.kind,
        toolCallId: target.toolCallId,
        approved: result.approved,
        scope: result.scope,
        actionId: result.actionId,
        queueLengthBefore: queue.length,
      });
    }
    target.resolve(result);

    const nextQueue = queue.filter((entry) => entry.id !== id);
    const nextQueues = { ...this._confirmationEntries() };
    if (nextQueue.length === 0) {
      delete nextQueues[normalizedSessionId];
    } else {
      nextQueues[normalizedSessionId] = nextQueue;
    }
    this._confirmationEntries.set(nextQueues);

    const nextIndices = { ...this._confirmationActiveIndices() };
    if (nextQueue.length === 0) {
      delete nextIndices[normalizedSessionId];
    } else {
      const currentIndex = this.getActiveConfirmationIndex(normalizedSessionId);
      nextIndices[normalizedSessionId] = Math.max(0, Math.min(currentIndex, nextQueue.length - 1));
    }
    this._confirmationActiveIndices.set(nextIndices);
    this.emitSnapshot(normalizedSessionId);
  }

  clearConfirmations(sessionId: string): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const queue = this._confirmationEntries()[normalizedSessionId];
    if (!queue || queue.length === 0) {
      return;
    }

    const rejectedResult = {
      approved: false,
      reason: this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_REJECT_REASON'),
    };
    for (const entry of queue) {
      if (entry.kind === 'approval') {
        this.resolveApprovalState(normalizedSessionId, entry.toolCallId ?? entry.id, rejectedResult);
      }
      entry.resolve(rejectedResult);
    }

    const nextQueues = { ...this._confirmationEntries() };
    delete nextQueues[normalizedSessionId];
    this._confirmationEntries.set(nextQueues);

    const nextIndices = { ...this._confirmationActiveIndices() };
    delete nextIndices[normalizedSessionId];
    this._confirmationActiveIndices.set(nextIndices);
    this.emitSnapshot(normalizedSessionId);
  }

  resolvePlanReview(sessionId: string, id: string, result: RuntimePlanReviewDecision): void {
    const entry = this._planReviewEntries()[sessionId];
    if (!entry || entry.id !== id) {
      return;
    }

    entry.resolve(result);
    this.deletePlanReviewEntry(sessionId);
  }

  clearPlanReview(sessionId: string): void {
    const entry = this._planReviewEntries()[sessionId];
    if (!entry) {
      return;
    }

    entry.resolve({ approved: false });
    this.deletePlanReviewEntry(sessionId);
  }

  private normalizeApprovalTraceId(request: ToolApprovalRequest): string {
    const explicitTraceId = typeof request.approvalTraceId === 'string' ? request.approvalTraceId.trim() : '';
    if (explicitTraceId) {
      return explicitTraceId;
    }

    const toolCallId = typeof request.toolCallId === 'string' ? request.toolCallId.trim() : '';
    return toolCallId ? `approval-${toolCallId}` : `approval-${Date.now().toString(36)}`;
  }

  private getApprovalStateKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}\u0000${toolCallId}`;
  }

  private upsertApprovalState(sessionId: string, request: ToolApprovalRequest): RuntimeApprovalState {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const toolCallId = request.toolCallId.trim();
    const key = this.getApprovalStateKey(normalizedSessionId, toolCallId);
    const existing = this._approvalStates.get(key);
    const now = Date.now();
    const state: RuntimeApprovalState = {
      sessionId: normalizedSessionId,
      toolCallId,
      approvalTraceId: request.approvalTraceId,
      toolName: request.toolName,
      request,
      status: 'pending',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this._approvalStates.set(key, state);
    this.logApprovalState('pending', state);
    return state;
  }

  private resolveApprovalState(
    sessionId: string,
    toolCallId: string,
    result: RuntimeConfirmationDecision,
  ): RuntimeApprovalState | undefined {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const normalizedToolCallId = toolCallId.trim();
    const key = this.getApprovalStateKey(normalizedSessionId, normalizedToolCallId);
    const existing = this._approvalStates.get(key);
    if (!existing) {
      return undefined;
    }

    const resolved: RuntimeApprovalState = {
      ...existing,
      status: 'resolved',
      result,
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
    };
    this._approvalStates.set(key, resolved);
    this.logApprovalState('resolved', resolved);
    return resolved;
  }

  private createApprovalRequestFromConfirmation(entry: ConfirmationRuntimeEntry): ToolApprovalRequest | undefined {
    if (entry.kind !== 'approval') {
      return undefined;
    }

    const toolCallId = (entry.toolCallId || entry.id || '').trim();
    const toolName = (entry.toolName || entry.data.toolName || '').trim();
    if (!toolCallId || !toolName) {
      return undefined;
    }

    return {
      approvalTraceId: entry.approvalTraceId || entry.data.approvalTraceId,
      toolCallId,
      toolName,
      title: entry.data.title,
      subtitle: entry.data.subtitle,
      message: entry.data.message,
      actions: entry.data.actions,
      primaryScope: entry.data.primaryScope,
      args: entry.data.args,
    };
  }

  private rememberResolvedApproval(
    sessionId: string,
    request: ToolApprovalRequest | undefined,
    result: RuntimeConfirmationDecision,
  ): void {
    if (!request || result.approved !== true) {
      return;
    }

    const normalizedScope = result.scope === 'session-safe' ? 'session-all-terminal' : result.scope ?? 'once';
    if (normalizedScope === 'once') {
      return;
    }

    const toolName = normalizeReadSideToolName(request.toolName);
    const args = request.args && typeof request.args === 'object'
      ? request.args as Record<string, unknown>
      : {};
    const combinationKey = typeof request.approveCombination?.key === 'string'
      ? request.approveCombination.key.trim()
      : '';
    const isCombinationApproval = !!combinationKey && result.actionId?.startsWith('combination:');

    if (isCombinationApproval) {
      if (normalizedScope === 'session') {
        this.toolApprovalPolicy.addSessionToolApprovalCombinationKey(sessionId, combinationKey);
        return;
      }

      if (normalizedScope === 'workspace'
        && this.toolApprovalPolicy.addWorkspaceToolApprovalCombinationKey(this.resolveCurrentProjectPath(), combinationKey)) {
        this.toolApprovalPolicy.save();
      }
      return;
    }

    if (isTerminalCommandToolName(toolName)) {
      if (normalizedScope === 'session-all-terminal') {
        this.toolApprovalPolicy.setSessionTerminalAutoApproval(sessionId, true);
        return;
      }

      const command = normalizeTerminalCommand(readToolApprovalCommand(toolName, args, request.message));
      if (!command) {
        return;
      }

      const exactRule = buildExactTerminalRule(command);
      if (normalizedScope === 'session') {
        this.toolApprovalPolicy.addSessionTerminalApprovalRule(sessionId, exactRule);
        return;
      }

      if (normalizedScope === 'workspace') {
        const currentAllowList = this.toolApprovalPolicy.terminalAllowList ?? [];
        if (!currentAllowList.includes(exactRule)) {
          this.toolApprovalPolicy.terminalAllowList = [...currentAllowList, exactRule];
          this.toolApprovalPolicy.save();
        }
      }
      return;
    }

    if (!toolName) {
      return;
    }

    if (normalizedScope === 'session') {
      this.toolApprovalPolicy.addSessionToolApprovalRule(sessionId, toolName);
      return;
    }

    if (normalizedScope === 'workspace'
      && this.toolApprovalPolicy.addWorkspaceToolApprovalRule(this.resolveCurrentProjectPath(), toolName)) {
      this.toolApprovalPolicy.save();
    }
  }

  private resolveCurrentProjectPath(): string {
    const host = AilyHost.get();
    return host.project.currentProjectPath
      || host.project.projectRootPath
      || '';
  }

  private createRemoteConfirmationResolver(
    sessionId: string,
    id: string,
    remoteResolver: RuntimeInteractionRemoteResolver,
  ): Pick<ConfirmationRuntimeEntry, 'resolve' | 'promise' | 'remote'> {
    let resolveLocal!: (result: RuntimeConfirmationDecision) => void;
    const promise = new Promise<RuntimeConfirmationDecision>((resolve) => {
      resolveLocal = resolve;
    });
    return {
      remote: true,
      promise,
      resolve: (result) => {
        resolveLocal(result);
        void remoteResolver({
          sessionId,
          kind: 'confirmation.resolve',
          id,
          payload: { result },
        });
      },
    };
  }

  private resolveConfirmationEntryProjection(
    sessionId: string,
    confirmation: RuntimeConfirmationWidgetState,
    existingConfirmations: readonly ConfirmationRuntimeEntry[],
    remoteResolver: RuntimeInteractionRemoteResolver,
  ): Pick<ConfirmationRuntimeEntry, 'resolve' | 'promise' | 'onAction' | 'remote'> {
    const existing = existingConfirmations.find((entry) => entry.id === confirmation.id);
    if (existing && !existing.remote) {
      if (shouldTraceRuntimeInteraction()) {
        console.info('[AilyChat][RuntimeApprovalQueue]', {
          phase: 'apply-host-snapshot-preserve-local-confirmation',
          sessionId,
          id: confirmation.id,
          kind: confirmation.kind,
          toolCallId: confirmation.toolCallId,
        });
      }
      return {
        resolve: existing.resolve,
        promise: existing.promise,
        onAction: existing.onAction,
      };
    }

    return this.createRemoteConfirmationResolver(sessionId, confirmation.id, remoteResolver);
  }

  private logApprovalState(phase: 'pending' | 'resolved', state: RuntimeApprovalState): void {
    // Keep this log compact; it is the host-side equivalent of VS Code's single pending tool invocation state.
    if (shouldTraceRuntimeInteraction()) {
      console.info('[AilyChat][RuntimeApprovalState]', {
        phase,
        sessionId: state.sessionId,
        toolCallId: state.toolCallId,
        toolName: state.toolName,
        approvalTraceId: state.approvalTraceId,
        status: state.status,
        approved: state.result?.approved,
        scope: state.result?.scope,
        actionId: state.result?.actionId,
      });
    }
  }

  private enqueueConfirmation(
    sessionId: string,
    entry: RuntimeConfirmationWidgetState & { onAction?: (actionId: string) => void },
  ): Promise<RuntimeConfirmationDecision> {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const currentQueues = this._confirmationEntries();
    const currentQueue = currentQueues[normalizedSessionId] ?? [];
    const existingIndex = currentQueue.findIndex((item) => item.id === entry.id);
    if (existingIndex >= 0) {
      if (shouldTraceRuntimeInteraction()) {
        console.info('[AilyChat][RuntimeApprovalQueue]', {
          phase: 'enqueue-update-existing',
          sessionId: normalizedSessionId,
          id: entry.id,
          kind: entry.kind,
          toolCallId: entry.toolCallId,
          queueLength: currentQueue.length,
        });
      }
      const existing = currentQueue[existingIndex];
      const nextEntry: ConfirmationRuntimeEntry = {
        ...entry,
        sessionId: normalizedSessionId,
        resolve: existing.resolve,
        promise: existing.promise,
        onAction: entry.onAction ?? existing.onAction,
      };
      const nextQueue = currentQueue.map((item, index) => index === existingIndex ? nextEntry : item);

      this._confirmationEntries.set({
        ...currentQueues,
        [normalizedSessionId]: nextQueue,
      });

      this._confirmationActiveIndices.set({
        ...this._confirmationActiveIndices(),
        [normalizedSessionId]: existingIndex,
      });
      this.emitSnapshot(normalizedSessionId);
      return existing.promise;
    }

    let resolveDecision!: (result: RuntimeConfirmationDecision) => void;
    const promise = new Promise<RuntimeConfirmationDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const nextQueue = currentQueue.concat({
      ...entry,
      sessionId: normalizedSessionId,
      resolve: resolveDecision,
      promise,
    });
    if (shouldTraceRuntimeInteraction()) {
      console.info('[AilyChat][RuntimeApprovalQueue]', {
        phase: 'enqueue-new',
        sessionId: normalizedSessionId,
        id: entry.id,
        kind: entry.kind,
        toolCallId: entry.toolCallId,
        queueLengthBefore: currentQueue.length,
        queueLengthAfter: nextQueue.length,
      });
    }

    this._confirmationEntries.set({
      ...currentQueues,
      [normalizedSessionId]: nextQueue,
    });

    this._confirmationActiveIndices.set({
      ...this._confirmationActiveIndices(),
      [normalizedSessionId]: nextQueue.length - 1,
    });
    this.emitSnapshot(normalizedSessionId);
    notifyAwaitingUserFeedbackIfBackground(
      'Aily',
      entry.kind === 'approval' ? '有操作需要你确认' : '需要你完成一项确认',
    );
    return promise;
  }

  private deleteQuestionEntry(sessionId: string): void {
    const current = { ...this._questionEntries() };
    delete current[sessionId];
    this._questionEntries.set(current);
    this.emitSnapshot(sessionId);
  }

  private deletePlanReviewEntry(sessionId: string): void {
    this.disposePlanReviewFileSync(sessionId);
    const current = { ...this._planReviewEntries() };
    delete current[sessionId];
    this._planReviewEntries.set(current);
    this.emitSnapshot(sessionId);
  }

  private installPlanReviewFileSync(sessionId: string, id: string, planUri: string | undefined): void {
    this.disposePlanReviewFileSync(sessionId);

    const absolutePath = this.resolvePlanReviewAbsolutePath(sessionId, planUri);
    if (!absolutePath) {
      return;
    }

    const host = AilyHost.get();
    if (typeof host.fs?.watch !== 'function') {
      this._planReviewFileSyncs.set(sessionId, { id, absolutePath });
      return;
    }

    try {
      const handle = host.fs.watch(
        absolutePath,
        () => {
          this.refreshPlanReviewContentFromFile(sessionId, id, absolutePath);
        },
        { persistent: false },
      );
      this._planReviewFileSyncs.set(sessionId, { id, absolutePath, handle });
    } catch {
      this._planReviewFileSyncs.set(sessionId, { id, absolutePath });
    }
  }

  private disposePlanReviewFileSync(sessionId: string): void {
    const existing = this._planReviewFileSyncs.get(sessionId);
    if (!existing) {
      return;
    }

    const handle = existing.handle;
    if (handle) {
      handle.close?.();
      handle.dispose?.();
      handle.unsubscribe?.();
    }
    this._planReviewFileSyncs.delete(sessionId);
  }

  private refreshPlanReviewContentFromFile(sessionId: string, id: string, absolutePath: string): void {
    const syncState = this._planReviewFileSyncs.get(sessionId);
    if (!syncState || syncState.id !== id || syncState.absolutePath !== absolutePath) {
      return;
    }

    const nextContent = this.readPlanReviewFileContent(absolutePath);
    if (nextContent === undefined) {
      return;
    }

    const entry = this._planReviewEntries()[sessionId];
    if (!entry || entry.id !== id || entry.data.content === nextContent) {
      return;
    }

    const currentEntries = this._planReviewEntries();
    this._planReviewEntries.set({
      ...currentEntries,
      [sessionId]: {
        ...entry,
        data: {
          ...entry.data,
          content: nextContent,
        },
      },
    });
    this.emitSnapshot(sessionId);
  }

  private resolvePlanReviewContentFromFile(
    sessionId: string,
    planUri: string | undefined,
    fallbackContent: string,
  ): string {
    const absolutePath = this.resolvePlanReviewAbsolutePath(sessionId, planUri);
    if (!absolutePath) {
      return fallbackContent;
    }

    return this.readPlanReviewFileContent(absolutePath) ?? fallbackContent;
  }

  private resolvePlanReviewAbsolutePath(sessionId: string, planUri: string | undefined): string | undefined {
    if (!planUri) {
      return undefined;
    }

    const host = AilyHost.get();
    const cwd = host.project?.currentProjectPath || host.project?.projectRootPath;
    return resolveBlocklyArtifactReferenceTarget(host, planUri, { cwd, sessionId })?.absolutePath;
  }

  private readPlanReviewFileContent(absolutePath: string): string | undefined {
    const host = AilyHost.get();
    try {
      if (!host.fs?.existsSync?.(absolutePath)) {
        return undefined;
      }

      const stat = host.fs?.statSync?.(absolutePath);
      if (stat?.isFile && !stat.isFile()) {
        return undefined;
      }

      const content = host.fs.readFileSync(absolutePath, 'utf-8');
      return typeof content === 'string' ? content : String(content ?? '');
    } catch {
      return undefined;
    }
  }

  private buildSnapshot(sessionId: string): ChatRuntimeHostInteractionSnapshot {
    const confirmationQueue = this.getConfirmationQueue(sessionId);
    const question = (this.stripQuestionEntry(this._questionEntries()[sessionId]) as unknown) as Readonly<Record<string, unknown>> | null;
    const confirmationSnapshot = (confirmationQueue.map(entry => this.stripConfirmationEntry(entry)) as unknown) as ReadonlyArray<Readonly<Record<string, unknown>>>;
    const activePlanReview = (this.stripPlanReviewEntry(this._planReviewEntries()[sessionId]) as unknown) as Readonly<Record<string, unknown>> | null;
    const remoteProcessInventory = this._remoteProcessInventories.get(sessionId);
    const processes = this.mergeProcessSummaries(
      listBlocklyCommandSessionSnapshots(sessionId),
      remoteProcessInventory?.processes ?? [],
    );
    return {
      sessionId,
      revision: this.interactionRevision,
      question,
      confirmationQueue: confirmationSnapshot,
      activeConfirmationIndex: this.getActiveConfirmationIndex(sessionId),
      activePlanReview,
      backgroundCommandSessionKeys: [...this._backgroundCommandSessions]
        .filter(key => key.startsWith(`${sessionId}::`)),
      backgroundProcessIds: [...this._backgroundCommandSessions]
        .filter(key => key.startsWith(`${sessionId}::`))
        .map(key => key.slice(`${sessionId}::`.length)),
      processInventoryRevision: remoteProcessInventory?.processInventoryRevision ?? this.interactionRevision,
      processes,
    };
  }

  private mergeProcessSummaries(
    localProcesses: readonly ChatRuntimeHostSessionProcessSummary[],
    remoteProcesses: readonly ChatRuntimeHostSessionProcessSummary[],
  ): readonly ChatRuntimeHostSessionProcessSummary[] {
    const merged = new Map<string, ChatRuntimeHostSessionProcessSummary>();
    for (const process of localProcesses) {
      if (this.isProcessSummary(process)) {
        merged.set(process.processId, process);
      }
    }
    for (const process of remoteProcesses) {
      if (!this.isProcessSummary(process)) {
        continue;
      }
      const existing = merged.get(process.processId);
      merged.set(process.processId, existing
        ? {
            ...existing,
            ...process,
            outputFilePath: process.outputFilePath ?? existing.outputFilePath,
          }
        : process);
    }
    return [...merged.values()].sort((left, right) => right.startedAt - left.startedAt);
  }

  private isProcessSummary(value: unknown): value is ChatRuntimeHostSessionProcessSummary {
    const record = value as Partial<ChatRuntimeHostSessionProcessSummary> | null | undefined;
    return !!record
      && typeof record === 'object'
      && typeof record.processId === 'string'
      && record.processId.trim().length > 0
      && typeof record.sessionId === 'string'
      && record.sessionId.trim().length > 0;
  }

  private stripQuestionEntry(entry: QuestionRuntimeEntry | undefined): RuntimeQuestionWidgetState | null {
    if (!entry) {
      return null;
    }
    return {
      sessionId: entry.sessionId,
      partId: entry.partId,
      context: entry.context,
      data: entry.data,
    };
  }

  private stripConfirmationEntry(entry: RuntimeConfirmationWidgetState): RuntimeConfirmationWidgetState {
    return {
      approvalTraceId: entry.approvalTraceId,
      sessionId: entry.sessionId,
      id: entry.id,
      kind: entry.kind,
      partId: entry.partId,
      askId: entry.askId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      data: entry.data,
    };
  }

  private stripPlanReviewEntry(entry: PlanReviewRuntimeEntry | undefined): RuntimePlanReviewWidgetState | null {
    if (!entry) {
      return null;
    }
    return {
      sessionId: entry.sessionId,
      id: entry.id,
      data: entry.data,
    };
  }

  private emitSnapshot(sessionId: string): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    this.interactionRevision += 1;
    const snapshot = this.buildSnapshot(normalizedSessionId);
    const confirmationQueue = Array.isArray(snapshot.confirmationQueue)
      ? snapshot.confirmationQueue
      : [];
    if (snapshot.question || confirmationQueue.length > 0 || snapshot.activePlanReview) {
      const activeConfirmationIndex = Math.max(
        0,
        Math.min(Number(snapshot.activeConfirmationIndex) || 0, Math.max(confirmationQueue.length - 1, 0)),
      );
      const activeConfirmation = confirmationQueue[activeConfirmationIndex] as {
        readonly id?: unknown;
        readonly toolCallId?: unknown;
        readonly toolName?: unknown;
      } | undefined;
      if (shouldTraceRuntimeInteraction()) {
        console.info('[AilyChat][RuntimeInteractionSnapshot]', {
          sessionId: normalizedSessionId,
          revision: snapshot.revision,
          hasQuestion: !!snapshot.question,
          confirmationCount: confirmationQueue.length,
          activeConfirmationId: typeof activeConfirmation?.id === 'string' ? activeConfirmation.id : undefined,
          activeToolCallId: typeof activeConfirmation?.toolCallId === 'string' ? activeConfirmation.toolCallId : undefined,
          activeToolName: typeof activeConfirmation?.toolName === 'string' ? activeConfirmation.toolName : undefined,
          hasPlanReview: !!snapshot.activePlanReview,
        });
      }
    }
    for (const listener of [...this.snapshotListeners]) {
      listener(snapshot);
    }
  }

  private normalizeSessionId(sessionId: string): string {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      throw new Error('[AilyChat][InteractionHost] Missing session id.');
    }
    return normalizedSessionId;
  }

  private isStaleCommandSessionActionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('Stale commandSession.action request')
      || message.includes('no pending command session');
  }
}
