/**
 * EditCheckpointService — Copilot-style 文件变更快照与回滚服务
 *
 * 本服务仅保留 renderer compatibility projection。
 * canonical workspace editing state、checkpoint navigation 与内容恢复均由
 * execution-host worker 的 editing session owner 管理。
 *
 * 核心设计：
 * - timeline: renderer 只保留 turn/checkpoint 关联元数据
 * - canonical file entries, baselines, diffs, states and navigation are read
 *   from the execution-host editing session
 *
 * 持久化规则：
 * - 本服务不持久化 workspace editing state
 * - 会话恢复时仅从 canonical turnResponses 重建展示相关元数据
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import type { TurnRequest } from 'aily-lex/browser';
import type { TurnResponseTurn } from 'aily-lex/browser';
import { buildDialogTurnContext, type DialogTurnContext } from '../core/user-turn-action-target';
import { ChatEditingSessionProjectionService } from './chat-editing-session-projection.service';
import type { RestorePlan } from './editing-timeline.types';

export interface WorkspaceCheckpointDescriptor {
  checkpointId: string;
  requestId: string;
  turnId?: string;
  label: string;
  additionalRepositoryRoots?: string[];
}

export type WorkspaceCheckpointPresentationMode = 'git' | 'timeline' | 'unknown';

export interface WorkspaceCheckpointAvailabilityDetail {
  readonly mode: WorkspaceCheckpointPresentationMode;
  readonly reason?:
    | 'no-workspace'
    | 'git-not-found'
    | 'not-git-repository'
    | 'git-safe-directory'
    | 'git-probe-failed'
    | 'timeline-unavailable';
  readonly message?: string;
}

export interface WorkspaceCheckpointRefMetadata {
  checkpointId: string;
  sessionResource: string;
  requestId: string;
  turnId?: string;
  checkpointNamespace: string;
  turnIndex: number;
  startCheckpointRef?: string;
  checkpointRef?: string;
  additionalStartCheckpointRefs?: Record<string, string>;
  additionalCheckpointRefs?: Record<string, string>;
  createdAt?: number;
  completedAt?: number;
}

export interface RequestCheckpointMetadata {
  source: 'request-metadata';
  checkpointId: string;
  sessionResource: string;
  requestId: string;
  turnId?: string;
  turnIndex: number;
  createdAt?: number;
  completedAt?: number;
}

export interface IWorkspaceCheckpointProvider {
  setContext?(sessionId: string | null, workspaceRoot: string | null): void;
  setFallbackProvider?(provider: IWorkspaceCheckpointProvider): void;
  getPresentationMode?(): WorkspaceCheckpointPresentationMode;
  ensurePresentationMode?(): Promise<WorkspaceCheckpointPresentationMode> | WorkspaceCheckpointPresentationMode;
  getAvailabilityDetail?(): WorkspaceCheckpointAvailabilityDetail;
  initializeRepository?(): Promise<WorkspaceCheckpointPresentationMode> | WorkspaceCheckpointPresentationMode;
  completeCheckpoint?(descriptor: WorkspaceCheckpointDescriptor): Promise<WorkspaceCheckpointRefMetadata | null | void> | WorkspaceCheckpointRefMetadata | null | void;
  clear?(): void;
  createCheckpoint(descriptor: WorkspaceCheckpointDescriptor): Promise<WorkspaceCheckpointRefMetadata | null | void> | WorkspaceCheckpointRefMetadata | null | void;
  replaceCheckpoints(descriptors: readonly WorkspaceCheckpointDescriptor[]): Promise<void> | void;
  getCheckpointMetadata?(checkpointId: string): Promise<WorkspaceCheckpointRefMetadata | null> | WorkspaceCheckpointRefMetadata | null;
  buildRestorePlan(checkpointId: string): Promise<RestorePlan | null> | RestorePlan | null;
  buildRedoPlan(checkpointId: string): Promise<RestorePlan | null> | RestorePlan | null;
  applyRestorePlan?(plan: RestorePlan): Promise<RollbackResult | null> | RollbackResult | null;
}

// ============================
// 类型定义
// ============================

/** 一个 turn/request 对应的 renderer 快照元数据。 */
export interface TurnSnapshot {
  checkpointId: string;
  turnIndex: number;
  /** user turn 在 host list 中的起始锚点 */
  turnStartListIndex: number | null;
  /** assistant response 在 host list 中的起始锚点 */
  responseStartListIndex: number | null;
  /** 对应 TurnManager 中 Turn 的 ID，用于 Turn-native 回滚 */
  turnId?: string;
  /** 该 turn 的原始 request payload（可含隐藏资源上下文） */
  requestContent?: string;
  /** 该 turn 对用户可见的请求文本 */
  displayContent?: string;
  /** 该 turn 最后一个 round 的锚点 ID */
  lastRoundId?: string;
  /** 该 turn 的轮次上下文，用于 turn-native checkpoint / history 消费 */
  rounds?: TurnResponseTurn['rounds'];
  /** 本 turn 是否有文件变更 */
  hasFileEdits: boolean;
  additionalRepositoryRoots?: string[];
  createdAt: number;
}

/** 回滚/恢复操作的结果 */
export interface RollbackResult {
  rolledBackFiles: number;
  errors: string[];
  rolledBackOnError?: boolean;
  rollbackErrors?: string[];
  emergencyRollback?: () => Promise<RollbackResult | null> | RollbackResult | null;
}

export interface EditCheckpointRebuildStateSnapshot {
  timeline: TurnSnapshot[];
  truncatedRequestBoundaries: TurnSnapshot[];
  requestCheckpointMetadata: RequestCheckpointMetadata[];
  timelineIndex: number;
}

// ============================
// Service
// ============================

@Injectable()
export class EditCheckpointService {
  private timelineSessionId: string | null = null;

  setTimelineContext(sessionId: string | null | undefined, workspaceRoot: string | null | undefined): void {
    this.timelineSessionId = sessionId || null;
    void workspaceRoot;
  }

  constructor(
    private readonly editingSessionProjection: ChatEditingSessionProjectionService,
  ) {}

  // ---- 内存状态 ----

  /** 快照时间线（线性历史），无上限 */
  private timeline: TurnSnapshot[] = [];

  /**
   * Restore 截断后临时保留的 request boundary。
   * 这层只用于在同一会话里维持“已被 restore 掉的请求边界仍可识别”的语义，
   * 与 VS Code agent-host session 在 restore 后保留 disabled sentinel 的行为对齐。
   * 一旦开始新 turn 或从 canonical turnResponses 重新 hydrate，就会被清空。
   */
  private truncatedRequestBoundaries: TurnSnapshot[] = [];

  private requestCheckpointMetadataByCheckpointId = new Map<string, RequestCheckpointMetadata>();
  private requestCheckpointMetadataByRequestId = new Map<string, RequestCheckpointMetadata>();
  private requestMetadataTargetsByCheckpointId = new Map<string, TurnRequest['metadata']>();

  /** 当前在时间线中的位置 (-1 = 初始状态/所有 turn 均已 undo) */
  private timelineIndex: number = -1;

  // ---- UI 信号 ----

  private summarySubject = new BehaviorSubject<EditsSummary | null>(null);
  summaryChanged$ = this.summarySubject.asObservable();
  private diffPreviewRequestSubject = new Subject<EditsSummary>();
  diffPreviewRequested$ = this.diffPreviewRequestSubject.asObservable();

  publishSummary(summary: EditsSummary | null): void {
    this.summarySubject.next(summary);
  }

  requestDiffPreview(summary: EditsSummary | null): void {
    if (!summary?.files?.length) {
      return;
    }
    this.diffPreviewRequestSubject.next(summary);
  }

  capturePublishedSummary(): EditsSummary | null {
    return this.summarySubject.getValue();
  }

  restorePublishedSummary(summary: EditsSummary | null): void {
    this.summarySubject.next(summary);
  }

  async publishCurrentSummary(): Promise<void> {
    const summary = await this.getEditsSummary();
    this.summarySubject.next(summary);
  }

  dismissSummary(): void {
    this.summarySubject.next(null);
  }

  waitForCheckpointMetadataSettled(): Promise<void> {
    return Promise.resolve();
  }

  captureRebuildState(): EditCheckpointRebuildStateSnapshot {
    return {
      timeline: this.cloneTurnSnapshots(this.timeline),
      truncatedRequestBoundaries: this.cloneTurnSnapshots(this.truncatedRequestBoundaries),
      requestCheckpointMetadata: this.cloneRequestCheckpointMetadataList([...this.requestCheckpointMetadataByCheckpointId.values()]),
      timelineIndex: this.timelineIndex,
    };
  }

  async buildRebuildStateFromTurnResponses(
    turnResponses: readonly Pick<TurnResponseTurn, 'turnId' | 'request' | 'rounds' | 'createdAt' | 'updatedAt' | 'response'>[],
  ): Promise<EditCheckpointRebuildStateSnapshot> {
    const requestCheckpointMetadata: RequestCheckpointMetadata[] = [];
    const timeline = turnResponses.flatMap((turn, index) => {
      const checkpointId = turn.request.metadata?.checkpointId;
      if (!checkpointId) {
        return [];
      }

      const createdAt = turn.updatedAt
        || turn.response?.updatedAt
        || turn.createdAt
        || turn.response?.createdAt
        || Date.now();
      const snapshot = {
        checkpointId,
        turnIndex: index,
        turnStartListIndex: null,
        responseStartListIndex: null,
        turnId: turn.turnId,
        requestContent: turn.request.content,
        displayContent: turn.request.displayContent ?? turn.request.content,
        lastRoundId: turn.rounds.at(-1)?.id,
        rounds: turn.rounds,
        // File edits are projected from the host-owned editing session. The
        // transcript rebuild only restores request/checkpoint correlation.
        hasFileEdits: false,
        createdAt,
      } satisfies TurnSnapshot;
      const metadata = this.readRequestCheckpointMetadataFromTurn(turn, index, snapshot);
      if (metadata) {
        requestCheckpointMetadata.push(metadata);
      }
      return [snapshot];
    });

    return {
      timeline,
      truncatedRequestBoundaries: [],
      requestCheckpointMetadata,
      timelineIndex: timeline.length - 1,
    };
  }

  async buildPublishedSummaryForRebuildState(
    snapshot: EditCheckpointRebuildStateSnapshot,
  ): Promise<EditsSummary | null> {
    const previousState = this.captureRebuildState();
    const previousSummary = this.capturePublishedSummary();

    this.applyRebuildStateInternal(snapshot);
    try {
      return await this.getEditsSummary();
    } finally {
      this.applyRebuildStateInternal(previousState);
      this.restorePublishedSummary(previousSummary);
    }
  }

  applyRebuildState(snapshot: EditCheckpointRebuildStateSnapshot): void {
    this.applyRebuildStateInternal(snapshot);
  }

  applyRebuildStateWithSummary(
    snapshot: EditCheckpointRebuildStateSnapshot,
    summary: EditsSummary | null,
  ): void {
    this.applyRebuildStateInternal(snapshot);
    this.publishSummary(summary);
  }

  private applyRebuildStateInternal(snapshot: EditCheckpointRebuildStateSnapshot): void {
    this.timeline = this.cloneTurnSnapshots(snapshot.timeline);
    this.truncatedRequestBoundaries = this.cloneTurnSnapshots(snapshot.truncatedRequestBoundaries);
    this.restoreRequestCheckpointMetadata(snapshot.requestCheckpointMetadata);
    this.timelineIndex = snapshot.timelineIndex;
  }

  restoreRebuildState(snapshot: EditCheckpointRebuildStateSnapshot): void {
    this.applyRebuildState(snapshot);
  }

  getRequestCheckpointMetadataByCheckpointId(checkpointId: string | null | undefined): RequestCheckpointMetadata | null {
    const normalizedCheckpointId = typeof checkpointId === 'string' ? checkpointId.trim() : '';
    if (!normalizedCheckpointId) {
      return null;
    }
    return this.cloneRequestCheckpointMetadata(this.requestCheckpointMetadataByCheckpointId.get(normalizedCheckpointId)) ?? null;
  }

  getRequestCheckpointMetadataByRequestId(requestId: string | null | undefined): RequestCheckpointMetadata | null {
    const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
    if (!normalizedRequestId) {
      return null;
    }
    return this.cloneRequestCheckpointMetadata(this.requestCheckpointMetadataByRequestId.get(normalizedRequestId)) ?? null;
  }

  async getSettledRequestCheckpointMetadataByCheckpointId(checkpointId: string | null | undefined): Promise<RequestCheckpointMetadata | null> {
    const normalizedCheckpointId = typeof checkpointId === 'string' ? checkpointId.trim() : '';
    if (!normalizedCheckpointId) {
      return null;
    }

    await this.waitForCheckpointMetadataSettled();
    return this.getRequestCheckpointMetadataByCheckpointId(normalizedCheckpointId);
  }

  async getSettledRequestCheckpointMetadataByRequestId(requestId: string | null | undefined): Promise<RequestCheckpointMetadata | null> {
    const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
    if (!normalizedRequestId) {
      return null;
    }

    await this.waitForCheckpointMetadataSettled();
    return this.getRequestCheckpointMetadataByRequestId(normalizedRequestId);
  }

  // ==================== 快照访问 ====================

  getSnapshotByCheckpointId(checkpointId: string): TurnSnapshot | undefined {
    return this.timeline.find(s => s.checkpointId === checkpointId)
      ?? this.truncatedRequestBoundaries.find(s => s.checkpointId === checkpointId);
  }

  getSnapshotByTurnId(turnId: string): TurnSnapshot | undefined {
    return this.timeline.find(s => s.turnId === turnId)
      ?? this.truncatedRequestBoundaries.find(s => s.turnId === turnId);
  }

  getSnapshotByRoundId(roundId: string): TurnSnapshot | undefined {
    return this.timeline.find(s => s.lastRoundId === roundId)
      ?? this.truncatedRequestBoundaries.find(s => s.lastRoundId === roundId);
  }

  getTurnStartListIndexForSnapshot(snapshot: TurnSnapshot | undefined): number | null {
    return snapshot?.turnStartListIndex ?? null;
  }

  getResponseStartListIndexForSnapshot(snapshot: TurnSnapshot | undefined): number | null {
    return snapshot?.responseStartListIndex ?? null;
  }

  getLatestSnapshot(): TurnSnapshot | undefined {
    return this.timelineIndex >= 0 ? this.timeline[this.timelineIndex] : undefined;
  }

  isSnapshotActive(snapshot: TurnSnapshot | undefined | null): boolean {
    if (!snapshot) {
      return false;
    }

    const snapshotIndex = this.timeline.findIndex(candidate => candidate.checkpointId === snapshot.checkpointId);
    return snapshotIndex >= 0 && snapshotIndex <= this.timelineIndex;
  }

  getDisabledRequestBoundaries(): TurnSnapshot[] {
    return this.truncatedRequestBoundaries.map(snapshot => ({
      ...snapshot,
      ...(snapshot.rounds ? { rounds: [...snapshot.rounds] } : {}),
    }));
  }

  isRequestDisabled(turnId: string | undefined): boolean {
    if (!turnId) {
      return false;
    }

    return this.truncatedRequestBoundaries.some(snapshot => snapshot.turnId === turnId);
  }

  async rebuildFromTurnResponses(
    turnResponses: readonly Pick<TurnResponseTurn, 'turnId' | 'request' | 'rounds' | 'createdAt' | 'updatedAt' | 'response'>[],
  ): Promise<boolean> {
    return await this.applyCheckpointStateFromTurnResponses(turnResponses);
  }

  async settleRequestCheckpointMetadataForTurnResponses(input: {
    readonly sessionResource: string | null | undefined;
    readonly workspaceRoot: string | null | undefined;
    readonly turnResponses: readonly Pick<TurnResponseTurn, 'turnId' | 'request' | 'rounds' | 'createdAt' | 'updatedAt' | 'response'>[];
  }): Promise<boolean> {
    this.setTimelineContext(input.sessionResource, input.workspaceRoot);
    return await this.applyCheckpointStateFromTurnResponses(input.turnResponses);
  }

  private async applyCheckpointStateFromTurnResponses(
    turnResponses: readonly Pick<TurnResponseTurn, 'turnId' | 'request' | 'rounds' | 'createdAt' | 'updatedAt' | 'response'>[],
  ): Promise<boolean> {
    const snapshot = await this.buildRebuildStateFromTurnResponses(turnResponses);
    this.applyRebuildState(snapshot);
    this.rebindRequestCheckpointMetadataTargets(turnResponses);
    return snapshot.timeline.length > 0;
  }

  // ==================== 截断（用于 restoreToCheckpoint / regenerate） ====================

  truncateStateFromCheckpoint(checkpointId: string): boolean {
    const idx = this.timeline.findIndex(s => s.checkpointId === checkpointId);
    if (idx === -1) {
      return false;
    }

    this.truncatedRequestBoundaries = this.timeline.slice(idx).map(snapshot => ({
      ...snapshot,
      ...(snapshot.rounds ? { rounds: [...snapshot.rounds] } : {}),
    }));

    this.timeline.splice(idx);
    this.timelineIndex = this.timeline.length - 1;

    return true;
  }

  commitRestorePointerByCheckpointId(checkpointId: string): boolean {
    const idx = this.timeline.findIndex(snapshot => snapshot.checkpointId === checkpointId);
    if (idx < 0) {
      return false;
    }
    this.truncatedRequestBoundaries = this.timeline.slice(idx).map(snapshot => ({
      ...snapshot,
      ...(snapshot.rounds ? { rounds: [...snapshot.rounds] } : {}),
    }));
    this.timelineIndex = idx - 1;
    return true;
  }

  commitRedoPointerByCheckpointId(checkpointId: string): boolean {
    const idx = this.timeline.findIndex(snapshot => snapshot.checkpointId === checkpointId);
    if (idx < 0) {
      return false;
    }
    this.timelineIndex = idx;
    this.truncatedRequestBoundaries = this.timeline.slice(idx + 1).map(snapshot => ({
      ...snapshot,
      ...(snapshot.rounds ? { rounds: [...snapshot.rounds] } : {}),
    }));
    return true;
  }

  // ==================== 查询 ====================

  getInitialContent(filePath: string): string | null | undefined {
    const sessionId = this.timelineSessionId;
    return sessionId
      ? this.editingSessionProjection.getOriginalText(sessionId, filePath)
      : undefined;
  }

  getTurnContextForSnapshot(snapshot: TurnSnapshot | undefined, fallbackTurnId?: string): DialogTurnContext | null {
    const turnId = snapshot?.turnId ?? fallbackTurnId;
    if (!turnId) {
      return null;
    }

    const turnContext = buildDialogTurnContext({
      turnId,
      rounds: snapshot?.rounds,
      requestDisabled: !!snapshot && !this.isSnapshotActive(snapshot),
      requestContent: snapshot?.requestContent,
      displayContent: snapshot?.displayContent,
    });
    if (!turnContext) {
      return null;
    }

    return {
      ...turnContext,
      lastRoundId: snapshot?.lastRoundId ?? turnContext.lastRoundId,
    };
  }

  // ==================== 编辑摘要 ====================

  async getEditsSummary(checkpointId?: string): Promise<EditsSummary | null> {
    const sessionId = this.timelineSessionId;
    if (!sessionId) {
      return null;
    }
    await this.editingSessionProjection.refresh(sessionId);

    const latestSnapshot = this.getLatestSnapshot();
    const summarySnapshot = checkpointId
      ? this.getSnapshotByCheckpointId(checkpointId)
      : latestSnapshot;
    const requestId = summarySnapshot?.turnId
      ?? this.getRequestCheckpointMetadataByCheckpointId(checkpointId)?.requestId;
    const summary = checkpointId
      ? (requestId
        ? this.editingSessionProjection.getRequestSummary(sessionId, requestId)
        : null)
      : this.editingSessionProjection.getSummary(sessionId);
    if (!summary) {
      return null;
    }

    return {
      ...summary,
      checkpointId: checkpointId || summary.checkpointId,
      turnContext: this.getTurnContextForSnapshot(summarySnapshot, requestId),
    };
  }

  getRequestEditsSummarySync(turnId: string): EditsSummary | null {
    const normalizedTurnId = typeof turnId === 'string'
      ? turnId.trim()
      : '';
    if (!normalizedTurnId) {
      return null;
    }

    const sessionId = this.timelineSessionId;
    if (!sessionId) {
      return null;
    }
    const summary = this.editingSessionProjection.getRequestSummary(sessionId, normalizedTurnId);
    if (!summary) {
      return null;
    }

    const snapshot = this.getSnapshotByTurnId(normalizedTurnId);
    return {
      ...summary,
      checkpointId: snapshot?.checkpointId || summary.checkpointId,
      turnContext: this.getTurnContextForSnapshot(snapshot, normalizedTurnId),
    };
  }

  // ==================== 清理 ====================

  clear(): void {
    this.timeline = [];
    this.truncatedRequestBoundaries = [];
    this.requestCheckpointMetadataByCheckpointId.clear();
    this.requestCheckpointMetadataByRequestId.clear();
    this.requestMetadataTargetsByCheckpointId.clear();
    this.timelineIndex = -1;
    this.timelineSessionId = null;
  }

  // ==================== 内部辅助方法 ====================

  private buildRequestCheckpointMetadata(
    snapshot: TurnSnapshot,
  ): RequestCheckpointMetadata | null {
    const sessionResource = this.timelineSessionId?.trim();
    const checkpointId = snapshot.checkpointId?.trim();
    const requestId = (snapshot.turnId || checkpointId)?.trim();
    if (!sessionResource || !checkpointId || !requestId) {
      return null;
    }

    const turnId = (snapshot.turnId || '').trim();
    return {
      source: 'request-metadata',
      checkpointId,
      sessionResource,
      requestId,
      ...(turnId ? { turnId } : {}),
      turnIndex: snapshot.turnIndex + 1,
      createdAt: snapshot.createdAt,
    };
  }

  private storeRequestCheckpointMetadata(
    metadata: RequestCheckpointMetadata,
    requestMetadata?: TurnRequest['metadata'],
  ): void {
    const cloned = this.cloneRequestCheckpointMetadata(metadata);
    if (!cloned) {
      return;
    }

    this.requestCheckpointMetadataByCheckpointId.set(cloned.checkpointId, cloned);
    this.requestCheckpointMetadataByRequestId.set(cloned.requestId, cloned);

    if (requestMetadata) {
      this.requestMetadataTargetsByCheckpointId.set(cloned.checkpointId, requestMetadata);
      this.writeRequestCheckpointMetadata(requestMetadata, cloned);
    }
  }

  private restoreRequestCheckpointMetadata(metadata: readonly RequestCheckpointMetadata[] | undefined): void {
    this.requestCheckpointMetadataByCheckpointId.clear();
    this.requestCheckpointMetadataByRequestId.clear();
    this.requestMetadataTargetsByCheckpointId.clear();
    for (const item of metadata ?? []) {
      this.storeRequestCheckpointMetadata(item);
    }
  }

  private rebindRequestCheckpointMetadataTargets(
    turnResponses: readonly Pick<TurnResponseTurn, 'request'>[],
  ): void {
    for (const turn of turnResponses) {
      const requestMetadata = turn.request?.metadata;
      if (!requestMetadata || typeof requestMetadata !== 'object') {
        continue;
      }
      const checkpointId = typeof (requestMetadata as Record<string, unknown>)['checkpointId'] === 'string'
        ? ((requestMetadata as Record<string, unknown>)['checkpointId'] as string).trim()
        : '';
      if (!checkpointId) {
        continue;
      }
      this.requestMetadataTargetsByCheckpointId.set(checkpointId, requestMetadata);
      const checkpointMetadata = this.requestCheckpointMetadataByCheckpointId.get(checkpointId);
      if (checkpointMetadata) {
        this.writeRequestCheckpointMetadata(requestMetadata, checkpointMetadata);
      }
    }
  }

  private writeRequestCheckpointMetadata(
    requestMetadata: TurnRequest['metadata'],
    checkpointMetadata: RequestCheckpointMetadata,
  ): void {
    if (!requestMetadata) {
      return;
    }

    const mutableMetadata = requestMetadata as Record<string, unknown>;
    mutableMetadata['checkpointId'] = checkpointMetadata.checkpointId;
    mutableMetadata['requestId'] = checkpointMetadata.requestId;
    mutableMetadata['checkpointTurnIndex'] = checkpointMetadata.turnIndex;
  }

  private readRequestCheckpointMetadataFromTurn(
    turn: Pick<TurnResponseTurn, 'turnId' | 'request'>,
    index: number,
    snapshot: TurnSnapshot,
  ): RequestCheckpointMetadata | null {
    return this.buildRequestCheckpointMetadata({
      ...snapshot,
      turnId: turn.turnId,
      turnIndex: index,
    });
  }

  private cloneTurnSnapshots(snapshots: readonly TurnSnapshot[]): TurnSnapshot[] {
    return snapshots.map(snapshot => ({
      ...snapshot,
      ...(snapshot.rounds ? { rounds: [...snapshot.rounds] } : {}),
      ...(snapshot.additionalRepositoryRoots ? { additionalRepositoryRoots: [...snapshot.additionalRepositoryRoots] } : {}),
    }));
  }

  private cloneRequestCheckpointMetadataList(metadata: readonly RequestCheckpointMetadata[]): RequestCheckpointMetadata[] {
    return metadata
      .map(item => this.cloneRequestCheckpointMetadata(item))
      .filter((item): item is RequestCheckpointMetadata => !!item);
  }

  private cloneRequestCheckpointMetadata(
    metadata: RequestCheckpointMetadata | null | undefined,
  ): RequestCheckpointMetadata | null {
    if (!metadata) {
      return null;
    }

    return {
      source: 'request-metadata',
      checkpointId: metadata.checkpointId,
      sessionResource: metadata.sessionResource,
      requestId: metadata.requestId,
      ...(metadata.turnId ? { turnId: metadata.turnId } : {}),
      turnIndex: metadata.turnIndex,
      ...(typeof metadata.createdAt === 'number' ? { createdAt: metadata.createdAt } : {}),
      ...(typeof metadata.completedAt === 'number' ? { completedAt: metadata.completedAt } : {}),
    };
  }

}

// ============================
// 导出类型
// ============================

export interface EditFileSummary {
  path: string;
  fullPath: string;
  type: 'create' | 'modify' | 'delete';
  contentKind: 'text' | 'binary' | 'notebook';
  added: number;
  removed: number;
}

export interface EditsSummary {
  checkpointId: string;
  turnContext?: DialogTurnContext | null;
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
  files: EditFileSummary[];
}
