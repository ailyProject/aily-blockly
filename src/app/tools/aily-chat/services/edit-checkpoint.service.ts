/**
 * EditCheckpointService — Copilot-style 文件变更快照与回滚服务
 *
 * v2: 后端委托 aily-lex FileHistory 实现磁盘级备份/回滚，
 * 本服务仅负责 UI 协调（时间线游标、undo/redo、accept/reject、editsSummary），
 * 以及 workspace checkpoint provider 的 wiring 与 timeline fallback-provider 组合。
 *
 * 核心设计：
 * - fileHistory: aily-lex FileHistory 实例，负责文件备份与磁盘回滚
 * - initialFileContents: 每个文件首次被 AI 编辑前的原始内容（保留后刷新为当前态）
 * - currentTurnBaselines: 本轮 AI 编辑前的磁盘快照（每轮 recordEdit 时重新捕获）
 * - timeline: 线性快照时间线，每个 turn 一条元数据
 * - timelineIndex: 当前游标位置，支持 undo/redo 双向导航
 * - pendingSnapshot: Undo 前自动保存的"最新磁盘状态"Map，确保 redo 可恢复
 *
 * 持久化规则：
 * - 文件备份/快照由 lex FileHistory 自动持久化到 .aily/file-history/{sessionId}/
 * - 本服务不再独立持久化到 .aily_checkpoints/（已废弃）
 * - 会话恢复时直接从 canonical turnResponses 重建 checkpoint timeline；FileHistory 只负责磁盘回滚
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { AilyHost } from '../core/host';
import type { FileHistory, TurnRequest } from 'aily-lex/browser';
import type { TurnResponseTurn } from 'aily-lex/browser';
import { buildDialogTurnContext, type DialogTurnContext } from '../core/user-turn-action-target';
import { EditingContentStore } from './editing-content-store.service';
import { EditingDiffService } from './editing-diff.service';
import { EditingFileApplyService } from './editing-file-apply.service';
import { EditingSessionTimelineService } from './editing-session-timeline.service';
import { EditingTextDiffService } from './editing-text-diff.service';
import { EditingTimelineRepository } from './editing-timeline-repository.service';
import type { RequestEditSummary, RestorePlan } from './editing-timeline.types';

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

export interface RequestCheckpointMetadata extends WorkspaceCheckpointRefMetadata {
  source: 'request-metadata';
}

export interface WorkspaceCheckpointForkRequest {
  sourceSessionResource: string;
  targetSessionResource: string;
  checkpointIds: readonly string[];
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
  forkCheckpoints?(request: WorkspaceCheckpointForkRequest): Promise<WorkspaceCheckpointRefMetadata[] | null> | WorkspaceCheckpointRefMetadata[] | null;
  getCheckpointMetadata?(checkpointId: string): Promise<WorkspaceCheckpointRefMetadata | null> | WorkspaceCheckpointRefMetadata | null;
  buildRestorePlan(checkpointId: string): Promise<RestorePlan | null> | RestorePlan | null;
  buildRedoPlan(checkpointId: string): Promise<RestorePlan | null> | RestorePlan | null;
  applyRestorePlan?(plan: RestorePlan): Promise<RollbackResult | null> | RollbackResult | null;
}

// ============================
// 类型定义
// ============================

/** 一个 turn/request 对应的快照元数据（文件内容由 FileHistory 管理） */
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
  checkpointRef?: string;
  additionalCheckpointRefs?: Record<string, string>;
  checkpointNamespace?: string;
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
  initialFileContents: Map<string, string | null>;
  timeline: TurnSnapshot[];
  truncatedRequestBoundaries: TurnSnapshot[];
  requestCheckpointMetadata: RequestCheckpointMetadata[];
  timelineIndex: number;
  keptTimelineIndex: number;
  pendingSnapshot: Map<string, string | null> | null;
  currentTurnTrackedPaths: Set<string>;
  currentTurnOperations: Map<string, 'create' | 'modify' | 'delete'>;
  currentTurnBaselines: Map<string, string | null>;
  currentTurnAdditionalRepositoryRoots: Set<string>;
  isInTurn: boolean;
}

// ============================
// Service
// ============================

@Injectable()
export class EditCheckpointService {
  private readonly editingTimelineRepository = new EditingTimelineRepository({
    joinPath: (...parts) => AilyHost.get().path.join(...parts),
  });
  private readonly editingContentStore = new EditingContentStore({
    joinPath: (...parts) => AilyHost.get().path.join(...parts),
  });
  private readonly editingTextDiffService = new EditingTextDiffService();

  private timelineSessionId: string | null = null;
  private timelineWorkspaceRoot: string | null = null;
  private workspaceCheckpointProvider: IWorkspaceCheckpointProvider | null = null;

  // ---- FileHistory (aily-lex) ----
  private fileHistory: FileHistory | null = null;

  /** 注入 FileHistory 实例（由 LexOwnerFacade 在 agent 创建后调用） */
  setFileHistory(fh: FileHistory | null): void {
    this.fileHistory = fh;
    this.captureTimelineContextFromFileHistory(fh);
  }

  setTimelineContext(sessionId: string | null | undefined, workspaceRoot: string | null | undefined): void {
    this.timelineSessionId = sessionId || null;
    this.timelineWorkspaceRoot = workspaceRoot || null;
    this.workspaceCheckpointProvider?.setContext?.(this.timelineSessionId, this.timelineWorkspaceRoot);
  }

  setWorkspaceCheckpointProvider(provider: IWorkspaceCheckpointProvider | null): void {
    this.workspaceCheckpointProvider = provider;
    provider?.setFallbackProvider?.(this.createTimelineFallbackProvider());
    provider?.setContext?.(this.timelineSessionId, this.timelineWorkspaceRoot);
  }

  /** 获取 FileHistory 引用 */
  getFileHistory(): FileHistory | null {
    return this.fileHistory;
  }

  // ---- 内存状态 ----

  /** 每个文件首次被 AI 编辑前的原始内容 (null = 文件不存在) */
  private initialFileContents = new Map<string, string | null>();

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
  private checkpointMetadataWriteQueue: Promise<void> = Promise.resolve();

  /** 当前在时间线中的位置 (-1 = 初始状态/所有 turn 均已 undo) */
  private timelineIndex: number = -1;

  /**
   * 用户"保留"操作后的时间线索引位置。
   * undo 不会回退到此索引之前；getEditsSummary 以此为 diff 基线下限。
   * -1 表示未保留过。
   */
  private keptTimelineIndex: number = -1;

  /**
   * Copilot-style pendingSnapshot：
   * 在首次 undo 时自动拍摄当前磁盘状态（Map<filePath, content|null>），
   * 确保 redo 到最末端时能恢复。新 turn 开始时清除。
   */
  private pendingSnapshot: Map<string, string | null> | null = null;

  /** 当前 turn 中被修改的文件路径集合 */
  private currentTurnTrackedPaths = new Set<string>();

  /** 当前 turn 中各文件的操作类型 */
  private currentTurnOperations = new Map<string, 'create' | 'modify' | 'delete'>();

  /** 当前 turn 命中的附加 git repository roots。 */
  private currentTurnAdditionalRepositoryRoots = new Set<string>();

  /**
   * 本轮 AI 编辑前的磁盘基线（per-turn baseline）。
   * 每次 recordEdit 时捕获该文件此刻的磁盘内容，用于 getEditsSummary diff。
   */
  private currentTurnBaselines = new Map<string, string | null>();

  /** 是否在活跃 turn 中 */
  private isInTurn = false;

  /** 自动保存模式 */
  autoSaveEdits = false;

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
    if (this.autoSaveEdits && this.isInTurn) return;
    const summary = await this.getEditsSummary();
    this.summarySubject.next(summary);
  }

  dismissSummary(): void {
    this.summarySubject.next(null);
  }

  // ==================== 保留（Accept All as Baseline） ====================

  acceptAllAsBaseline(): void {
    this.keptTimelineIndex = this.timelineIndex;
    this.pendingSnapshot = null;

    const fs = AilyHost.get().fs;
    for (const filePath of [...this.initialFileContents.keys()]) {
      try {
        if (fs.existsSync(filePath)) {
          this.initialFileContents.set(filePath, fs.readFileSync(filePath, 'utf-8'));
        } else {
          this.initialFileContents.set(filePath, null);
        }
      } catch { /* ignore */ }
    }
  }

  // ==================== Turn 管理 ====================

  startTurn(
    turnIndex: number,
    turnStartListIndex: number | null,
    responseStartListIndex: number | null,
    turnId?: string,
    requestContent?: string,
    displayContent?: string,
    checkpointId?: string,
    requestMetadata?: TurnRequest['metadata'],
  ): void {
    if (this.isInTurn) {
      void this.commitCurrentTurn();
    }

    // 截断 redo 历史
    if (this.timelineIndex < this.timeline.length - 1) {
      this.timeline.splice(this.timelineIndex + 1);
    }
    this.truncatedRequestBoundaries = [];
    this.pendingSnapshot = null;

    if (!checkpointId) {
      throw new Error('EditCheckpointService.startTurn requires request.metadata.checkpointId');
    }

    const snapshot: TurnSnapshot = {
      checkpointId,
      turnIndex,
      turnStartListIndex,
      responseStartListIndex,
      turnId,
      requestContent,
      displayContent,
      hasFileEdits: false,
      createdAt: Date.now(),
    };

    this.timeline.push(snapshot);
    this.timelineIndex = this.timeline.length - 1;
    this.registerRequestCheckpointMetadata(snapshot, requestMetadata);
    void this.persistTimelineCheckpoint(snapshot);

    this.currentTurnTrackedPaths.clear();
    this.currentTurnOperations.clear();
    this.currentTurnBaselines.clear();
    this.currentTurnAdditionalRepositoryRoots.clear();

    // 预捕获所有已跟踪文件的当前磁盘态作为本轮基线
    const fs = AilyHost.get().fs;
    for (const filePath of this.initialFileContents.keys()) {
      try {
        if (fs.existsSync(filePath)) {
          this.currentTurnBaselines.set(filePath, fs.readFileSync(filePath, 'utf-8'));
        } else {
          this.currentTurnBaselines.set(filePath, null);
        }
      } catch { /* ignore */ }
    }

    this.isInTurn = true;
  }

  /**
   * 记录一次文件编辑（在工具实际写盘前调用）。
   * 仅捕获内存级基线，磁盘备份由 lex FileHistory.trackEdit 负责。
   */
  recordEdit(filePath: string, type: 'create' | 'modify' | 'delete'): void {
    const fs = AilyHost.get().fs;

    if (!this.initialFileContents.has(filePath)) {
      let content: string | null = null;
      try {
        if (fs.existsSync(filePath)) {
          content = fs.readFileSync(filePath, 'utf-8');
        }
      } catch { /* ignore */ }
      this.initialFileContents.set(filePath, content);
    }

    if (!this.currentTurnBaselines.has(filePath)) {
      let content: string | null = null;
      try {
        if (fs.existsSync(filePath)) {
          content = fs.readFileSync(filePath, 'utf-8');
        }
      } catch { /* ignore */ }
      this.currentTurnBaselines.set(filePath, content);
    }

    this.currentTurnTrackedPaths.add(filePath);
    this.currentTurnOperations.set(filePath, type);
    this.captureCurrentTurnRepositoryRoot(filePath);
  }

  recordAdditionalRepositoryRoots(repositoryRoots: readonly string[] | undefined | null): void {
    if (!repositoryRoots || repositoryRoots.length === 0) {
      return;
    }

    const currentTurn = this.timeline[this.timelineIndex];
    if (!currentTurn) {
      return;
    }

    let changed = false;
    for (const repositoryRoot of repositoryRoots) {
      const normalizedRoot = normalizeCheckpointPath(repositoryRoot);
      if (!normalizedRoot || this.currentTurnAdditionalRepositoryRoots.has(normalizedRoot)) {
        continue;
      }

      this.currentTurnAdditionalRepositoryRoots.add(normalizedRoot);
      changed = true;
    }

    if (!changed) {
      return;
    }

    currentTurn.additionalRepositoryRoots = this.getCurrentTurnAdditionalRepositoryRoots();
    void this.persistTimelineCheckpoint(currentTurn);
  }

  recordAdditionalRepositoryRootCandidates(paths: readonly string[] | undefined | null): void {
    if (!paths || paths.length === 0) {
      return;
    }

    const repositoryRoots = paths
      .map(path => this.resolveGitRepositoryRoot(path))
      .filter((path): path is string => !!path);
    this.recordAdditionalRepositoryRoots(repositoryRoots);
  }

  /**
   * 提交当前 turn — 标记完成。
   * 磁盘快照由 lex agent 的 FileHistory.makeSnapshot() 处理。
   */
  commitCurrentTurn(): Promise<void> {
    if (!this.isInTurn) {
      return this.waitForCheckpointMetadataSettled();
    }
    this.isInTurn = false;

    const currentTurn = this.timeline[this.timelineIndex];
    if (this.currentTurnTrackedPaths.size > 0 && currentTurn) {
      currentTurn.hasFileEdits = true;
    }

    if (currentTurn?.checkpointId && currentTurn.turnId) {
      currentTurn.additionalRepositoryRoots = this.getCurrentTurnAdditionalRepositoryRoots();
      const provider = this.getWorkspaceCheckpointProvider();
      const descriptor = this.toWorkspaceCheckpointDescriptor(currentTurn);
      return this.enqueueCheckpointMetadataWrite(async () => {
        const metadata = await Promise.resolve(provider.completeCheckpoint?.(descriptor));
        const resolvedMetadata = metadata
          ?? await provider.getCheckpointMetadata?.(currentTurn.checkpointId)
          ?? null;
        if (resolvedMetadata) {
          this.applyWorkspaceCheckpointRefMetadata(currentTurn, resolvedMetadata);
        }
      }, 'complete checkpoint');
    }

    return this.waitForCheckpointMetadataSettled();
  }

  waitForCheckpointMetadataSettled(): Promise<void> {
    return this.checkpointMetadataWriteQueue;
  }

  // ==================== Undo / Redo ====================

  get canUndo(): boolean {
    return this.timelineIndex > this.keptTimelineIndex;
  }

  get canRedo(): boolean {
    return this.timelineIndex < this.timeline.length - 1
      || this.pendingSnapshot !== null;
  }

  captureRebuildState(): EditCheckpointRebuildStateSnapshot {
    return {
      initialFileContents: new Map(this.initialFileContents),
      timeline: this.cloneTurnSnapshots(this.timeline),
      truncatedRequestBoundaries: this.cloneTurnSnapshots(this.truncatedRequestBoundaries),
      requestCheckpointMetadata: this.cloneRequestCheckpointMetadataList([...this.requestCheckpointMetadataByCheckpointId.values()]),
      timelineIndex: this.timelineIndex,
      keptTimelineIndex: this.keptTimelineIndex,
      pendingSnapshot: this.pendingSnapshot ? new Map(this.pendingSnapshot) : null,
      currentTurnTrackedPaths: new Set(this.currentTurnTrackedPaths),
      currentTurnOperations: new Map(this.currentTurnOperations),
      currentTurnBaselines: new Map(this.currentTurnBaselines),
      currentTurnAdditionalRepositoryRoots: new Set(this.currentTurnAdditionalRepositoryRoots),
      isInTurn: this.isInTurn,
    };
  }

  async buildRebuildStateFromTurnResponses(
    turnResponses: readonly Pick<TurnResponseTurn, 'turnId' | 'request' | 'rounds' | 'createdAt' | 'updatedAt' | 'response'>[],
  ): Promise<EditCheckpointRebuildStateSnapshot> {
    const currentState = this.captureRebuildState();
    const fileHistorySnapshotsByTurnId = new Map<string, { trackedFileBackups: Record<string, unknown> }>();
    if (this.fileHistory) {
      try {
        await this.fileHistory.load();
        for (const snapshot of this.fileHistory.snapshots) {
          if (snapshot.turnId && snapshot.turnId !== '__init__') {
            fileHistorySnapshotsByTurnId.set(snapshot.turnId, snapshot);
          }
        }
      } catch (err) {
        console.warn('[EditCheckpoint] rebuildFromTurnResponses fileHistory load failed:', err);
      }
    }

    const initialFileContents = new Map<string, string | null>();
    const initId = this.fileHistory?.initialTurnId;
    if (this.fileHistory && initId) {
      for (const filePath of this.fileHistory.trackedFiles) {
        const content = await this.fileHistory.readBackup(filePath, initId);
        if (content !== undefined) {
          initialFileContents.set(filePath, content);
        }
      }
    }

    const requestCheckpointMetadata: RequestCheckpointMetadata[] = [];
    const timeline = turnResponses.flatMap((turn, index) => {
      const checkpointId = turn.request.metadata?.checkpointId;
      if (!checkpointId) {
        return [];
      }

      const fileHistorySnapshot = fileHistorySnapshotsByTurnId.get(turn.turnId);
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
        hasFileEdits: !!fileHistorySnapshot && Object.keys(fileHistorySnapshot.trackedFileBackups ?? {}).length > 0,
        ...this.readCheckpointRefsFromRequestMetadata(turn.request.metadata),
        createdAt,
      } satisfies TurnSnapshot;
      const metadata = this.readRequestCheckpointMetadataFromTurn(turn, index, snapshot);
      if (metadata) {
        requestCheckpointMetadata.push(metadata);
      }
      return [snapshot];
    });

    return {
      ...currentState,
      initialFileContents,
      timeline,
      truncatedRequestBoundaries: [],
      requestCheckpointMetadata,
      timelineIndex: timeline.length - 1,
      keptTimelineIndex: -1,
      pendingSnapshot: null,
      currentTurnTrackedPaths: new Set<string>(),
      currentTurnOperations: new Map<string, 'create' | 'modify' | 'delete'>(),
      currentTurnBaselines: new Map<string, string | null>(),
      currentTurnAdditionalRepositoryRoots: new Set<string>(),
      isInTurn: false,
    };
  }

  async buildPublishedSummaryForRebuildState(
    snapshot: EditCheckpointRebuildStateSnapshot,
  ): Promise<EditsSummary | null> {
    const previousState = this.captureRebuildState();
    const previousSummary = this.capturePublishedSummary();

    this.applyRebuildStateInternal(snapshot, { syncProjection: false });
    try {
      return await this.getEditsSummary();
    } finally {
      this.applyRebuildStateInternal(previousState, { syncProjection: false });
      this.restorePublishedSummary(previousSummary);
    }
  }

  applyRebuildState(snapshot: EditCheckpointRebuildStateSnapshot): void {
    this.applyRebuildStateInternal(snapshot, { syncProjection: true });
  }

  applyRebuildStateWithSummary(
    snapshot: EditCheckpointRebuildStateSnapshot,
    summary: EditsSummary | null,
  ): void {
    this.applyRebuildStateInternal(snapshot, { syncProjection: true });
    this.publishSummary(summary);
  }

  private applyRebuildStateInternal(
    snapshot: EditCheckpointRebuildStateSnapshot,
    options: { syncProjection: boolean },
  ): void {
    this.initialFileContents = new Map(snapshot.initialFileContents);
    this.timeline = this.cloneTurnSnapshots(snapshot.timeline);
    this.truncatedRequestBoundaries = this.cloneTurnSnapshots(snapshot.truncatedRequestBoundaries);
    this.restoreRequestCheckpointMetadata(snapshot.requestCheckpointMetadata);
    this.timelineIndex = snapshot.timelineIndex;
    this.keptTimelineIndex = snapshot.keptTimelineIndex;
    this.pendingSnapshot = snapshot.pendingSnapshot ? new Map(snapshot.pendingSnapshot) : null;
    this.currentTurnTrackedPaths = new Set(snapshot.currentTurnTrackedPaths);
    this.currentTurnOperations = new Map(snapshot.currentTurnOperations);
    this.currentTurnBaselines = new Map(snapshot.currentTurnBaselines);
    this.currentTurnAdditionalRepositoryRoots = new Set(snapshot.currentTurnAdditionalRepositoryRoots);
    this.isInTurn = snapshot.isInTurn;
    if (options.syncProjection) {
      this.replaceTimelineCheckpointsFromSnapshots(this.timeline);
      this.syncTimelinePointerFromSnapshots(this.timeline);
    }
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
    const current = this.getRequestCheckpointMetadataByCheckpointId(normalizedCheckpointId);
    if (this.hasCompleteRequestCheckpointMetadata(current)) {
      return current;
    }

    await this.refreshRequestCheckpointMetadataFromProvider(normalizedCheckpointId);
    return this.getRequestCheckpointMetadataByCheckpointId(normalizedCheckpointId);
  }

  async getSettledRequestCheckpointMetadataByRequestId(requestId: string | null | undefined): Promise<RequestCheckpointMetadata | null> {
    const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
    if (!normalizedRequestId) {
      return null;
    }

    await this.waitForCheckpointMetadataSettled();
    const current = this.getRequestCheckpointMetadataByRequestId(normalizedRequestId);
    if (this.hasCompleteRequestCheckpointMetadata(current)) {
      return current;
    }

    if (current?.checkpointId) {
      await this.refreshRequestCheckpointMetadataFromProvider(current.checkpointId);
      return this.getRequestCheckpointMetadataByRequestId(normalizedRequestId);
    }

    return current;
  }

  async forkRequestCheckpointMetadata(input: {
    sourceSessionResource: string;
    targetSessionResource: string;
    retainedTurnResponses: readonly TurnResponseTurn[];
  }): Promise<TurnResponseTurn[] | null> {
    const sourceSessionResource = input.sourceSessionResource.trim();
    const targetSessionResource = input.targetSessionResource.trim();
    if (!sourceSessionResource || !targetSessionResource) {
      return null;
    }

    const checkpointIds = input.retainedTurnResponses
      .map(turn => this.readCheckpointIdFromRequestMetadata(turn.request?.metadata))
      .filter((checkpointId): checkpointId is string => !!checkpointId);
    if (checkpointIds.length === 0) {
      return input.retainedTurnResponses.map(turn => this.cloneTurnResponseTurn(turn));
    }

    const provider = this.getWorkspaceCheckpointProvider();
    if (typeof provider.forkCheckpoints !== 'function') {
      return null;
    }

    const forkedMetadata = await Promise.resolve(provider.forkCheckpoints({
      sourceSessionResource,
      targetSessionResource,
      checkpointIds,
    }));
    if (!forkedMetadata || forkedMetadata.length !== checkpointIds.length) {
      return null;
    }

    const metadataByCheckpointId = new Map<string, RequestCheckpointMetadata>();
    for (const metadata of forkedMetadata) {
      const requestMetadata = this.cloneRequestCheckpointMetadata({
        source: 'request-metadata',
        ...metadata,
        sessionResource: targetSessionResource,
      });
      if (requestMetadata) {
        metadataByCheckpointId.set(requestMetadata.checkpointId, requestMetadata);
      }
    }

    if (checkpointIds.some(checkpointId => !metadataByCheckpointId.has(checkpointId))) {
      return null;
    }

    return input.retainedTurnResponses.map(turn => this.cloneTurnResponseTurnWithForkedCheckpointMetadata(
      turn,
      metadataByCheckpointId,
    ));
  }

  /**
   * 撤销到上一个快照状态。
   * 委托 FileHistory.rewind(turnId) 恢复磁盘文件。
   */
  async undo(): Promise<RollbackResult> {
    if (!this.canUndo) {
      return { rolledBackFiles: 0, errors: ['没有可撤销的操作'] };
    }

    this.ensurePendingSnapshot();
    this.timelineIndex--;

    // 确定目标 turnId
    const targetTurnId = this.timelineIndex >= 0
      ? this.timeline[this.timelineIndex].turnId
      : null;

    if (this.fileHistory) {
      try {
        if (targetTurnId) {
          const changed = await this.fileHistory.rewind(targetTurnId);
          return { rolledBackFiles: changed.length, errors: [] };
        }
        // 回到初始状态
        const initId = this.fileHistory.initialTurnId;
        if (initId) {
          const changed = await this.fileHistory.rewind(initId);
          return { rolledBackFiles: changed.length, errors: [] };
        }
      } catch (err: any) {
        return { rolledBackFiles: 0, errors: [err.message] };
      }
    }

    // Fallback: restore from initialFileContents
    return this.restoreToInitialState();
  }

  /**
   * 重做到下一个快照状态。
   * 时间线内使用 FileHistory.rewind; 超出部分使用 pendingSnapshot。
   */
  async redo(): Promise<RollbackResult> {
    if (this.timelineIndex < this.timeline.length - 1) {
      this.timelineIndex++;

      const turnId = this.timeline[this.timelineIndex].turnId;
      if (turnId && this.fileHistory) {
        try {
          const changed = await this.fileHistory.rewind(turnId);
          return { rolledBackFiles: changed.length, errors: [] };
        } catch (err: any) {
          return { rolledBackFiles: 0, errors: [err.message] };
        }
      }
      return { rolledBackFiles: 0, errors: [] };
    }

    if (this.pendingSnapshot) {
      return this.restoreFromPending();
    }

    return { rolledBackFiles: 0, errors: ['没有可重做的操作'] };
  }

  // ==================== Per-file Accept / Reject ====================

  acceptFile(filePath: string): void {
    this.initialFileContents.delete(filePath);
    this.currentTurnTrackedPaths.delete(filePath);
    this.currentTurnBaselines.delete(filePath);
    this.currentTurnOperations.delete(filePath);
  }

  /**
   * 拒绝单个文件的 AI 编辑 — 恢复到初始内容。
   * 优先通过 FileHistory.restoreFile 恢复；fallback 使用内存基线。
   */
  async rejectFile(filePath: string): Promise<RollbackResult> {
    if (!this.initialFileContents.has(filePath)) {
      return { rolledBackFiles: 0, errors: ['该文件未被追踪'] };
    }

    let result: RollbackResult;

    if (this.fileHistory?.initialTurnId) {
      try {
        const restored = await this.fileHistory.restoreFile(filePath, this.fileHistory.initialTurnId);
        result = { rolledBackFiles: restored ? 1 : 0, errors: [] };
      } catch (err: any) {
        result = { rolledBackFiles: 0, errors: [err.message] };
      }
    } else {
      result = this.restoreOneFile(filePath, this.initialFileContents.get(filePath)!);
    }

    this.initialFileContents.delete(filePath);
    this.currentTurnTrackedPaths.delete(filePath);
    this.currentTurnBaselines.delete(filePath);
    this.currentTurnOperations.delete(filePath);

    return result;
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
    await this.reconcileIncompleteCheckpointMetadataFromProvider();
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
    this.updateTimelinePointerForCheckpoint(checkpointId, idx > 0 ? this.timeline[idx - 1] : null);

    this.timeline.splice(idx);
    this.timelineIndex = this.timeline.length - 1;
    this.pendingSnapshot = null;
    this.keptTimelineIndex = this.timeline.length - 1;

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
    this.pendingSnapshot = null;
    this.keptTimelineIndex = Math.min(this.keptTimelineIndex, this.timelineIndex);
    this.updateTimelinePointerForCheckpoint(checkpointId, idx > 0 ? this.timeline[idx - 1] : null);
    return true;
  }

  commitRedoPointerByCheckpointId(checkpointId: string): boolean {
    const idx = this.timeline.findIndex(snapshot => snapshot.checkpointId === checkpointId);
    if (idx < 0) {
      return false;
    }
    this.timelineIndex = idx;
    this.pendingSnapshot = null;
    this.truncatedRequestBoundaries = this.timeline.slice(idx + 1).map(snapshot => ({
      ...snapshot,
      ...(snapshot.rounds ? { rounds: [...snapshot.rounds] } : {}),
    }));
    this.updateTimelinePointerForCheckpoint(checkpointId, this.timeline[idx]);
    return true;
  }

  // ==================== 查询 ====================

  hasEditsInCurrentTurn(): boolean {
    return this.currentTurnTrackedPaths.size > 0;
  }

  getTotalEditCount(): number {
    return this.initialFileContents.size;
  }

  get trackedFileCount(): number {
    return this.initialFileContents.size;
  }

  hasUnsavedEdits(): boolean {
    if (this.initialFileContents.size === 0) return false;
    return this.keptTimelineIndex < this.timelineIndex;
  }

  getTrackedFiles(): string[] {
    return [...this.initialFileContents.keys()];
  }

  getInitialContent(filePath: string): string | null | undefined {
    return this.initialFileContents.get(filePath);
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
    const latestSnapshot = this.getLatestSnapshot();
    const summarySnapshot = checkpointId
      ? (this.getSnapshotByCheckpointId(checkpointId) ?? latestSnapshot)
      : latestSnapshot;
    if (!checkpointId && this.keptTimelineIndex >= this.timelineIndex && this.currentTurnTrackedPaths.size === 0) {
      return null;
    }

    if (!checkpointId) {
      const sessionSummary = await this.getSessionDirtyEditsSummary(summarySnapshot);
      if (sessionSummary) {
        return sessionSummary;
      }
    }

    const summaryTurnId = summarySnapshot?.turnId;

    if (summaryTurnId) {
      const requestSummary = await this.getTimelineRequestSummary(summaryTurnId);
      if (requestSummary) {
        return this.toEditsSummaryFromRequestSummary(requestSummary, summarySnapshot, checkpointId);
      }
    }

    const fallbackSummary = await this.buildFallbackEditsSummary(summarySnapshot, checkpointId);
    if (fallbackSummary) {
      return fallbackSummary;
    }

    if (!summarySnapshot) {
      return null;
    }

    const turnContext = this.getTurnContextForSnapshot(summarySnapshot);
    return {
      checkpointId: checkpointId || latestSnapshot?.checkpointId || 'current',
      turnContext,
      fileCount: 0,
      totalAdded: 0,
      totalRemoved: 0,
      files: [],
    };
  }

  getRequestEditsSummarySync(turnId: string): EditsSummary | null {
    const normalizedTurnId = typeof turnId === 'string'
      ? turnId.trim()
      : '';
    if (!normalizedTurnId) {
      return null;
    }

    const diffService = this.getEditingDiffService();
    if (!diffService) {
      return null;
    }

    const summary = diffService.getRequestSummarySync(normalizedTurnId);
    if (!summary) {
      return null;
    }

    const snapshot = this.getSnapshotByTurnId(normalizedTurnId);
    return this.toEditsSummaryFromRequestSummary(summary, snapshot, snapshot?.checkpointId);
  }

  // ==================== 清理 ====================

  /**
   * 静态方法：删除指定会话的 FileHistory 文件。
   * 供 ChatHistoryService 在删除会话时调用。
   */
  static cleanSessionCheckpoints(projectPath: string, sessionId: string): void {
    if (!projectPath || !sessionId) return;
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;

    // 清理新格式：.aily/file-history/{sessionId}/
    const fhDir = pathUtil.join(projectPath, '.aily', 'file-history', sessionId);
    try {
      if (fs.existsSync(fhDir)) {
        const removeDir = (dirPath: string) => {
          if (!fs.existsSync(dirPath)) return;
          const entries = fs.readdirSync(dirPath);
          for (const entry of entries) {
            const fullPath = `${dirPath}/${entry}`;
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) { removeDir(fullPath); } else { fs.unlinkSync(fullPath); }
          }
          fs.rmdirSync(dirPath);
        };
        removeDir(fhDir);
      }
    } catch (err) {
      console.warn('[EditCheckpoint] cleanSessionCheckpoints (fh) failed:', err);
    }

  }

  clear(): void {
    this.initialFileContents.clear();
    this.timeline = [];
    this.truncatedRequestBoundaries = [];
    this.requestCheckpointMetadataByCheckpointId.clear();
    this.requestCheckpointMetadataByRequestId.clear();
    this.requestMetadataTargetsByCheckpointId.clear();
    this.timelineIndex = -1;
    this.keptTimelineIndex = -1;
    this.pendingSnapshot = null;
    this.currentTurnTrackedPaths.clear();
    this.currentTurnOperations.clear();
    this.currentTurnBaselines.clear();
    this.isInTurn = false;
    this.fileHistory = null;
    this.timelineSessionId = null;
    this.timelineWorkspaceRoot = null;
    this.workspaceCheckpointProvider?.clear?.();
    this.workspaceCheckpointProvider = null;
  }

  // ==================== 内部辅助方法 ====================

  /** 在首次 undo 时拍摄当前磁盘状态，确保 redo 可恢复 */
  private ensurePendingSnapshot(): void {
    if (this.pendingSnapshot) return;
    const fs = AilyHost.get().fs;
    const map = new Map<string, string | null>();
    for (const filePath of this.initialFileContents.keys()) {
      try {
        if (fs.existsSync(filePath)) {
          map.set(filePath, fs.readFileSync(filePath, 'utf-8'));
        } else {
          map.set(filePath, null);
        }
      } catch { /* ignore */ }
    }
    this.pendingSnapshot = map;
  }

  private captureTimelineContextFromFileHistory(fh: FileHistory | null): void {
    const options = (fh as any)?._options as { sessionId?: string; cwd?: string } | undefined;
    this.timelineSessionId = options?.sessionId ?? this.timelineSessionId;
    this.timelineWorkspaceRoot = options?.cwd ?? this.timelineWorkspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    this.workspaceCheckpointProvider?.setContext?.(this.timelineSessionId, this.timelineWorkspaceRoot);
  }

  private getEditingDiffService(): EditingDiffService | null {
    const sessionId = this.timelineSessionId;
    const workspaceRoot = this.timelineWorkspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    if (!sessionId || !workspaceRoot) {
      return null;
    }

    return new EditingDiffService(
      this.editingTimelineRepository,
      this.editingContentStore,
      workspaceRoot,
      sessionId,
      this.editingTextDiffService,
    );
  }

  private getEditingSessionTimelineService(): EditingSessionTimelineService | null {
    const sessionId = this.timelineSessionId;
    const workspaceRoot = this.timelineWorkspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    if (!sessionId || !workspaceRoot) {
      return null;
    }

    return new EditingSessionTimelineService(
      this.editingTimelineRepository,
      this.editingContentStore,
      workspaceRoot,
      sessionId,
    );
  }

  private getEditingFileApplyService(): EditingFileApplyService | null {
    const sessionId = this.timelineSessionId;
    const workspaceRoot = this.timelineWorkspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    if (!sessionId || !workspaceRoot) {
      return null;
    }

    return new EditingFileApplyService(
      this.editingContentStore,
      workspaceRoot,
      sessionId,
    );
  }

  private updateTimelinePointerForPlan(plan: RestorePlan, snapshot: TurnSnapshot | null): void {
    const timelineService = this.getEditingSessionTimelineService();
    if (!timelineService) {
      return;
    }

    timelineService.setCurrentPointer({
      epoch: plan.epoch,
      ...(snapshot?.checkpointId ? { checkpointId: snapshot.checkpointId } : {}),
      ...(snapshot?.turnId ? { requestId: snapshot.turnId } : {}),
    });
  }

  private updateTimelinePointerForCheckpoint(checkpointId: string, snapshot: TurnSnapshot | null): void {
    const timelineService = this.getEditingSessionTimelineService();
    if (!timelineService) {
      return;
    }

    const checkpoint = timelineService.getCheckpoint(checkpointId);
    if (!checkpoint) {
      return;
    }

    timelineService.setCurrentPointer({
      epoch: checkpoint.epoch,
      ...(snapshot?.checkpointId ? { checkpointId: snapshot.checkpointId } : {}),
      ...(snapshot?.turnId ? { requestId: snapshot.turnId } : {}),
    });
  }

  private syncTimelinePointerFromSnapshots(snapshots: readonly TurnSnapshot[]): void {
    const latestSnapshot = snapshots.at(-1) ?? null;
    if (!latestSnapshot?.checkpointId) {
      return;
    }

    this.updateTimelinePointerForCheckpoint(latestSnapshot.checkpointId, latestSnapshot);
  }

  private registerRequestCheckpointMetadata(
    snapshot: TurnSnapshot,
    requestMetadata?: TurnRequest['metadata'],
  ): void {
    if (!snapshot.checkpointId || !snapshot.turnId) {
      return;
    }

    const metadata = this.buildRequestCheckpointMetadata(snapshot, this.readCheckpointRefsFromRequestMetadata(requestMetadata));
    if (!metadata) {
      return;
    }

    this.storeRequestCheckpointMetadata(metadata, requestMetadata);
  }

  private applyWorkspaceCheckpointRefMetadata(
    snapshot: TurnSnapshot,
    workspaceMetadata: WorkspaceCheckpointRefMetadata,
  ): void {
    const metadata = this.buildRequestCheckpointMetadata(snapshot, workspaceMetadata);
    if (!metadata) {
      return;
    }

    snapshot.checkpointRef = metadata.checkpointRef;
    snapshot.additionalCheckpointRefs = this.cloneStringRecord(metadata.additionalCheckpointRefs);
    snapshot.checkpointNamespace = metadata.checkpointNamespace;
    this.storeRequestCheckpointMetadata(metadata, this.requestMetadataTargetsByCheckpointId.get(metadata.checkpointId));
  }

  private buildRequestCheckpointMetadata(
    snapshot: TurnSnapshot,
    refs: Partial<WorkspaceCheckpointRefMetadata> | null | undefined,
  ): RequestCheckpointMetadata | null {
    const sessionResource = this.timelineSessionId?.trim();
    const checkpointId = snapshot.checkpointId?.trim();
    const requestId = (refs?.requestId || snapshot.turnId || checkpointId)?.trim();
    if (!sessionResource || !checkpointId || !requestId) {
      return null;
    }

    const turnId = (refs?.turnId || snapshot.turnId || '').trim();
    return {
      source: 'request-metadata',
      checkpointId,
      sessionResource,
      requestId,
      ...(turnId ? { turnId } : {}),
      checkpointNamespace: refs?.checkpointNamespace || `refs/sessions/${sessionResource}`,
      turnIndex: typeof refs?.turnIndex === 'number' && Number.isFinite(refs.turnIndex)
        ? refs.turnIndex
        : snapshot.turnIndex + 1,
      ...(refs?.startCheckpointRef ? { startCheckpointRef: refs.startCheckpointRef } : {}),
      ...(refs?.checkpointRef ? { checkpointRef: refs.checkpointRef } : {}),
      ...(refs?.additionalStartCheckpointRefs ? { additionalStartCheckpointRefs: this.cloneStringRecord(refs.additionalStartCheckpointRefs) } : {}),
      ...(refs?.additionalCheckpointRefs ? { additionalCheckpointRefs: this.cloneStringRecord(refs.additionalCheckpointRefs) } : {}),
      ...(typeof refs?.createdAt === 'number' ? { createdAt: refs.createdAt } : { createdAt: snapshot.createdAt }),
      ...(typeof refs?.completedAt === 'number' ? { completedAt: refs.completedAt } : {}),
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
    mutableMetadata['checkpointNamespace'] = checkpointMetadata.checkpointNamespace;
    mutableMetadata['checkpointTurnIndex'] = checkpointMetadata.turnIndex;
    if (checkpointMetadata.startCheckpointRef) {
      mutableMetadata['startCheckpointRef'] = checkpointMetadata.startCheckpointRef;
    }
    if (checkpointMetadata.checkpointRef) {
      mutableMetadata['checkpointRef'] = checkpointMetadata.checkpointRef;
    }
    if (checkpointMetadata.additionalStartCheckpointRefs) {
      mutableMetadata['additionalStartCheckpointRefs'] = this.cloneStringRecord(checkpointMetadata.additionalStartCheckpointRefs);
    }
    if (checkpointMetadata.additionalCheckpointRefs) {
      mutableMetadata['additionalCheckpointRefs'] = this.cloneStringRecord(checkpointMetadata.additionalCheckpointRefs);
    }
  }

  private readRequestCheckpointMetadataFromTurn(
    turn: Pick<TurnResponseTurn, 'turnId' | 'request'>,
    index: number,
    snapshot: TurnSnapshot,
  ): RequestCheckpointMetadata | null {
    const refs = this.readCheckpointRefsFromRequestMetadata(turn.request.metadata);
    return this.buildRequestCheckpointMetadata({
      ...snapshot,
      turnId: turn.turnId,
      turnIndex: index,
    }, refs);
  }

  private readCheckpointRefsFromRequestMetadata(
    requestMetadata: TurnRequest['metadata'] | undefined,
  ): Partial<WorkspaceCheckpointRefMetadata> {
    const record = requestMetadata && typeof requestMetadata === 'object'
      ? requestMetadata as Record<string, unknown>
      : {};
    return {
      ...(typeof record['checkpointNamespace'] === 'string' && record['checkpointNamespace'].trim()
        ? { checkpointNamespace: record['checkpointNamespace'].trim() }
        : {}),
      ...(typeof record['checkpointTurnIndex'] === 'number' && Number.isFinite(record['checkpointTurnIndex'])
        ? { turnIndex: record['checkpointTurnIndex'] }
        : {}),
      ...(typeof record['startCheckpointRef'] === 'string' && record['startCheckpointRef'].trim()
        ? { startCheckpointRef: record['startCheckpointRef'].trim() }
        : {}),
      ...(typeof record['checkpointRef'] === 'string' && record['checkpointRef'].trim()
        ? { checkpointRef: record['checkpointRef'].trim() }
        : {}),
      ...(this.normalizeStringRecord(record['additionalStartCheckpointRefs'])
        ? { additionalStartCheckpointRefs: this.normalizeStringRecord(record['additionalStartCheckpointRefs'])! }
        : {}),
      ...(this.normalizeStringRecord(record['additionalCheckpointRefs'])
        ? { additionalCheckpointRefs: this.normalizeStringRecord(record['additionalCheckpointRefs'])! }
        : {}),
    };
  }

  private persistTimelineCheckpoint(snapshot: TurnSnapshot): Promise<void> {
    if (!snapshot.checkpointId || !snapshot.turnId) {
      return this.waitForCheckpointMetadataSettled();
    }

    const provider = this.getWorkspaceCheckpointProvider();
    return this.enqueueCheckpointMetadataWrite(async () => {
      const existingRequestMetadata = this.requestMetadataTargetsByCheckpointId.get(snapshot.checkpointId);
      const existingRefs = this.readCheckpointRefsFromRequestMetadata(existingRequestMetadata);
      if (existingRefs.checkpointRef) {
        return;
      }

      const metadata = await Promise.resolve(provider.createCheckpoint(
        this.toWorkspaceCheckpointDescriptor(snapshot),
      ));
      if (metadata) {
        this.applyWorkspaceCheckpointRefMetadata(snapshot, metadata);
      }
    }, 'create checkpoint');
  }

  private hasCompleteRequestCheckpointMetadata(
    metadata: RequestCheckpointMetadata | null | undefined,
  ): boolean {
    return !!metadata?.checkpointNamespace?.trim() && !!metadata?.checkpointRef?.trim();
  }

  private async refreshRequestCheckpointMetadataFromProvider(checkpointId: string): Promise<void> {
    const snapshot = this.findSnapshotByCheckpointId(checkpointId);
    if (!snapshot) {
      return;
    }

    const provider = this.getWorkspaceCheckpointProvider();
    if (typeof provider.getCheckpointMetadata !== 'function') {
      return;
    }

    const metadata = await Promise.resolve(provider.getCheckpointMetadata(checkpointId));
    if (metadata) {
      this.applyWorkspaceCheckpointRefMetadata(snapshot, metadata);
    }
  }

  private async reconcileIncompleteCheckpointMetadataFromProvider(): Promise<void> {
    const checkpointIds = [...this.timeline, ...this.truncatedRequestBoundaries]
      .map(snapshot => snapshot.checkpointId?.trim())
      .filter((checkpointId): checkpointId is string => !!checkpointId);

    for (const checkpointId of checkpointIds) {
      const metadata = this.getRequestCheckpointMetadataByCheckpointId(checkpointId);
      if (this.hasCompleteRequestCheckpointMetadata(metadata)) {
        continue;
      }

      await this.refreshRequestCheckpointMetadataFromProvider(checkpointId);
    }
  }

  private findSnapshotByCheckpointId(checkpointId: string): TurnSnapshot | null {
    return this.timeline.find(snapshot => snapshot.checkpointId === checkpointId)
      ?? this.truncatedRequestBoundaries.find(snapshot => snapshot.checkpointId === checkpointId)
      ?? null;
  }

  private enqueueCheckpointMetadataWrite(
    operation: () => Promise<void> | void,
    label: string,
  ): Promise<void> {
    const queuedOperation = this.checkpointMetadataWriteQueue
      .then(() => Promise.resolve(operation()))
      .catch(error => {
        console.warn(`[EditCheckpoint] ${label} failed:`, error);
      });
    this.checkpointMetadataWriteQueue = queuedOperation.catch(() => undefined);
    return queuedOperation;
  }

  private replaceTimelineCheckpointsFromSnapshots(snapshots: readonly TurnSnapshot[]): void {
    void Promise.resolve(this.getWorkspaceCheckpointProvider().replaceCheckpoints(
      snapshots
        .filter((snapshot): snapshot is TurnSnapshot & { turnId: string } => !!snapshot.checkpointId && !!snapshot.turnId)
        .map(snapshot => this.toWorkspaceCheckpointDescriptor(snapshot)),
    )).catch(error => {
      console.warn('[EditCheckpoint] replace checkpoints failed:', error);
    });
  }

  private getWorkspaceCheckpointProvider(): IWorkspaceCheckpointProvider {
    if (this.workspaceCheckpointProvider) {
      return this.workspaceCheckpointProvider;
    }

    return this.createTimelineFallbackProvider();
  }

  private createTimelineFallbackProvider(): IWorkspaceCheckpointProvider {
    const buildTimelineMetadata = (
      descriptor: WorkspaceCheckpointDescriptor,
      options: { completed: boolean },
    ): WorkspaceCheckpointRefMetadata | null => {
      const sessionResource = this.timelineSessionId?.trim();
      const workspaceRoot = this.timelineWorkspaceRoot?.trim();
      if (!sessionResource || !workspaceRoot || !descriptor.checkpointId || !descriptor.requestId) {
        return null;
      }

      const timelineService = this.getEditingSessionTimelineService();
      const state = timelineService?.getState();
      const checkpointIndex = state?.checkpoints.findIndex(checkpoint => checkpoint.checkpointId === descriptor.checkpointId) ?? -1;
      const turnIndex = checkpointIndex >= 0 ? checkpointIndex + 1 : Math.max(1, this.timeline.findIndex(snapshot => snapshot.checkpointId === descriptor.checkpointId) + 1);
      const checkpointNamespace = `aily-timeline:${sessionResource}`;
      const startCheckpointRef = `${checkpointNamespace}/checkpoints/turn/${Math.max(0, turnIndex - 1)}`;
      return {
        checkpointId: descriptor.checkpointId,
        sessionResource,
        requestId: descriptor.requestId,
        ...(descriptor.turnId ? { turnId: descriptor.turnId } : {}),
        checkpointNamespace,
        turnIndex,
        startCheckpointRef,
        ...(options.completed ? { checkpointRef: `${checkpointNamespace}/checkpoints/turn/${turnIndex}` } : {}),
        createdAt: Date.now(),
        ...(options.completed ? { completedAt: Date.now() } : {}),
      };
    };

    return {
      getPresentationMode: () => 'timeline',
      ensurePresentationMode: () => {
        const timelineService = this.getEditingSessionTimelineService();
        return timelineService ? 'timeline' : 'unknown';
      },
      getAvailabilityDetail: () => {
        const timelineService = this.getEditingSessionTimelineService();
        return timelineService
          ? { mode: 'timeline' }
          : {
            mode: 'unknown',
            reason: 'timeline-unavailable',
            message: '缺少本地 timeline checkpoint 上下文',
          };
      },
      createCheckpoint: (descriptor: WorkspaceCheckpointDescriptor) => {
        const timelineService = this.getEditingSessionTimelineService();
        if (!timelineService) {
          return null;
        }
        timelineService.createCheckpoint({
          checkpointId: descriptor.checkpointId,
          requestId: descriptor.requestId,
          turnId: descriptor.turnId,
          label: descriptor.label,
        });
        return buildTimelineMetadata(descriptor, { completed: false });
      },
      completeCheckpoint: (descriptor: WorkspaceCheckpointDescriptor) => {
        const timelineService = this.getEditingSessionTimelineService();
        if (!timelineService) {
          return null;
        }
        const checkpoint = timelineService.getCheckpoint(descriptor.checkpointId);
        if (!checkpoint) {
          timelineService.createCheckpoint({
            checkpointId: descriptor.checkpointId,
            requestId: descriptor.requestId,
            turnId: descriptor.turnId,
            label: descriptor.label,
          });
        }
        return buildTimelineMetadata(descriptor, { completed: true });
      },
      getCheckpointMetadata: (checkpointId: string) => {
        const timelineService = this.getEditingSessionTimelineService();
        if (!timelineService) {
          return null;
        }
        const checkpoint = timelineService.getCheckpoint(checkpointId);
        if (!checkpoint) {
          return null;
        }
        return buildTimelineMetadata({
          checkpointId: checkpoint.checkpointId,
          requestId: checkpoint.requestId,
          turnId: checkpoint.turnId,
          label: checkpoint.label,
        }, { completed: true });
      },
      replaceCheckpoints: (descriptors: readonly WorkspaceCheckpointDescriptor[]) => {
        const timelineService = this.getEditingSessionTimelineService();
        if (!timelineService) {
          return;
        }
        timelineService.replaceCheckpoints(
          descriptors.map(descriptor => ({
            checkpointId: descriptor.checkpointId,
            requestId: descriptor.requestId,
            turnId: descriptor.turnId,
            label: descriptor.label,
          })),
        );
      },
      forkCheckpoints: (request: WorkspaceCheckpointForkRequest) => {
        const sourceSessionResource = request.sourceSessionResource.trim();
        const targetSessionResource = request.targetSessionResource.trim();
        const workspaceRoot = this.timelineWorkspaceRoot?.trim();
        if (!sourceSessionResource || !targetSessionResource || !workspaceRoot) {
          return null;
        }

        const sourceState = this.editingTimelineRepository.load(sourceSessionResource, workspaceRoot);
        if (!sourceState) {
          return null;
        }

        const checkpointIds = request.checkpointIds
          .map(checkpointId => checkpointId.trim())
          .filter(Boolean);
        const checkpointIdSet = new Set(checkpointIds);
        const retainedCheckpoints = sourceState.checkpoints.filter(checkpoint => checkpointIdSet.has(checkpoint.checkpointId));
        if (retainedCheckpoints.length !== checkpointIds.length) {
          return null;
        }

        this.copyTimelineSessionDirectory(workspaceRoot, sourceSessionResource, targetSessionResource);
        this.editingTimelineRepository.save({
          ...sourceState,
          sessionId: targetSessionResource,
          checkpoints: retainedCheckpoints,
          requestScopes: sourceState.requestScopes.filter(scope => retainedCheckpoints.some(checkpoint => checkpoint.requestId === scope.requestId)),
          updatedAt: Date.now(),
        });

        return retainedCheckpoints.map((checkpoint, index) => ({
          checkpointId: checkpoint.checkpointId,
          sessionResource: targetSessionResource,
          requestId: checkpoint.requestId,
          ...(checkpoint.turnId ? { turnId: checkpoint.turnId } : {}),
          checkpointNamespace: `aily-timeline:${targetSessionResource}`,
          turnIndex: index + 1,
          startCheckpointRef: `aily-timeline:${targetSessionResource}/checkpoints/turn/${index}`,
          checkpointRef: `aily-timeline:${targetSessionResource}/checkpoints/turn/${index + 1}`,
          createdAt: checkpoint.createdAt,
          completedAt: Date.now(),
        }));
      },
      buildRestorePlan: async (checkpointId: string) => {
        const timelineService = this.getEditingSessionTimelineService();
        if (!timelineService) {
          return null;
        }

        const checkpoint = timelineService.getCheckpoint(checkpointId);
        if (!checkpoint) {
          return null;
        }

        return timelineService.buildPlanForEpoch(checkpointId, checkpoint.epoch);
      },
      buildRedoPlan: async (checkpointId: string) => {
        const timelineService = this.getEditingSessionTimelineService();
        if (!timelineService) {
          return null;
        }

        const checkpoint = timelineService.getCheckpoint(checkpointId);
        if (!checkpoint) {
          return null;
        }

        const range = timelineService.getRequestEpochRange(checkpoint.requestId);
        return timelineService.buildPlanForEpoch(checkpointId, range?.lastEpoch ?? checkpoint.epoch);
      },
      applyRestorePlan: async (plan: RestorePlan) => {
        if (plan.applyMetadata?.kind === 'git-checkpoint') {
          return {
            rolledBackFiles: 0,
            errors: ['git-backed checkpoint restore plan 无法由 workspace checkpoint provider 应用'],
            rolledBackOnError: true,
          };
        }

        const applyService = this.getEditingFileApplyService();
        if (!applyService) {
          return { rolledBackFiles: 0, errors: ['缺少 timeline apply 上下文'] };
        }

        const emergencyRollback = this.captureTimelineEmergencyRollback(plan);
        const result = await applyService.apply(plan);
        const rollbackResult: RollbackResult = {
          rolledBackFiles: result.appliedFiles,
          errors: result.errors,
          ...(typeof result.rolledBackOnError === 'boolean'
            ? { rolledBackOnError: result.rolledBackOnError }
            : {}),
          ...(result.rollbackErrors ? { rollbackErrors: result.rollbackErrors } : {}),
        };
        if (rollbackResult.errors.length === 0 && emergencyRollback) {
          Object.defineProperty(rollbackResult, 'emergencyRollback', {
            value: emergencyRollback,
            enumerable: false,
            configurable: true,
          });
        }
        return rollbackResult;
      },
    };
  }

  private captureTimelineEmergencyRollback(plan: RestorePlan): (() => RollbackResult) | null {
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const snapshots = plan.files.map(file => {
      const existed = fs.existsSync(file.uri);
      return {
        uri: file.uri,
        existed,
        content: existed ? fs.readFileSync(file.uri, file.contentKind === 'binary' ? undefined : 'utf-8') : null,
      };
    });
    if (snapshots.length === 0) {
      return null;
    }

    return () => {
      const errors: string[] = [];
      let restored = 0;
      for (const snapshot of snapshots) {
        try {
          if (!snapshot.existed) {
            if (fs.existsSync(snapshot.uri)) {
              fs.unlinkSync(snapshot.uri);
              restored++;
            }
            continue;
          }

          const dirPath = pathUtil.dirname(snapshot.uri);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
          fs.writeFileSync(snapshot.uri, snapshot.content ?? '', 'utf-8');
          restored++;
        } catch (error: any) {
          errors.push(`timeline emergency rollback ${snapshot.uri} 失败: ${error?.message || String(error)}`);
        }
      }

      return {
        rolledBackFiles: errors.length === 0 ? restored : 0,
        errors,
        rolledBackOnError: errors.length === 0,
        ...(errors.length > 0 ? { rollbackErrors: errors } : {}),
      };
    };
  }

  private copyTimelineSessionDirectory(workspaceRoot: string, sourceSessionId: string, targetSessionId: string): void {
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const sourceDir = this.editingTimelineRepository.getSessionDir(workspaceRoot, sourceSessionId);
    const targetDir = this.editingTimelineRepository.getSessionDir(workspaceRoot, targetSessionId);
    if (!fs.existsSync(sourceDir)) {
      return;
    }
    if (typeof fs.copySync === 'function') {
      fs.copySync(sourceDir, targetDir);
      return;
    }
    this.copyDirectoryRecursive(sourceDir, targetDir, pathUtil, fs);
  }

  private copyDirectoryRecursive(
    sourceDir: string,
    targetDir: string,
    pathUtil: { join: (...parts: string[]) => string },
    fs: {
      existsSync(path: string): boolean;
      mkdirSync(path: string, options?: { recursive?: boolean }): void;
      readdirSync(path: string): string[];
      statSync(path: string): { isDirectory(): boolean };
      readFileSync(path: string): string | Uint8Array;
      writeFileSync(path: string, content: string | Uint8Array): void;
    },
  ): void {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    for (const entry of fs.readdirSync(sourceDir)) {
      const sourcePath = pathUtil.join(sourceDir, entry);
      const targetPath = pathUtil.join(targetDir, entry);
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        this.copyDirectoryRecursive(sourcePath, targetPath, pathUtil, fs);
      } else {
        fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
      }
    }
  }

  private async getTimelineRequestSummary(turnId: string): Promise<RequestEditSummary | null> {
    const diffService = this.getEditingDiffService();
    if (!diffService) {
      return null;
    }
    return diffService.getRequestSummary(turnId);
  }

  private async getSessionDirtyEditsSummary(
    summarySnapshot: TurnSnapshot | undefined,
  ): Promise<EditsSummary | null> {
    const diffService = this.getEditingDiffService();
    const timelineService = this.getEditingSessionTimelineService();
    if (!diffService || !timelineService) {
      return null;
    }

    const currentEpoch = timelineService.getCurrentEpoch();
    const fromEpoch = this.getSessionSummaryStartEpoch(timelineService);
    const summary = await diffService.getSummaryBetweenEpochs(fromEpoch, currentEpoch);
    return this.toEditsSummaryFromStats(summary?.stats ?? [], summarySnapshot, summarySnapshot?.turnId);
  }

  private getSessionSummaryStartEpoch(
    timelineService: EditingSessionTimelineService,
  ): number {
    if (this.keptTimelineIndex < 0) {
      return 0;
    }

    const keptSnapshot = this.timeline[this.keptTimelineIndex];
    if (!keptSnapshot?.turnId) {
      return 0;
    }

    const range = timelineService.getRequestEpochRange(keptSnapshot.turnId);
    return range?.lastEpoch ?? 0;
  }

  private toEditsSummaryFromRequestSummary(
    summary: RequestEditSummary,
    snapshot: TurnSnapshot | undefined,
    checkpointId?: string,
  ): EditsSummary | null {
    return this.toEditsSummaryFromStats(summary.stats, snapshot, summary.requestId, checkpointId || summary.checkpointId);
  }

  private toEditsSummaryFromStats(
    stats: RequestEditSummary['stats'],
    snapshot: TurnSnapshot | undefined,
    fallbackTurnId?: string,
    checkpointId?: string,
  ): EditsSummary | null {
    if (!stats.length) {
      return null;
    }

    const files = stats.map(stat => ({
      path: this.getDisplayPath(stat.uri),
      fullPath: stat.uri,
      type: this.resolveSummaryFileType(stat.operationTypes),
      contentKind: stat.contentKind,
      added: stat.addedLines,
      removed: stat.removedLines,
    }));
    const totals = files.reduce(
      (accumulator, file) => {
        accumulator.totalAdded += file.added;
        accumulator.totalRemoved += file.removed;
        return accumulator;
      },
      { totalAdded: 0, totalRemoved: 0 },
    );

    return {
      checkpointId: checkpointId || snapshot?.checkpointId || 'current',
      turnContext: this.getTurnContextForSnapshot(snapshot, fallbackTurnId),
      fileCount: files.length,
      totalAdded: totals.totalAdded,
      totalRemoved: totals.totalRemoved,
      files,
    };
  }

  private async buildFallbackEditsSummary(
    summarySnapshot: TurnSnapshot | undefined,
    checkpointId?: string,
  ): Promise<EditsSummary | null> {
    if (this.initialFileContents.size === 0 && this.currentTurnTrackedPaths.size === 0) {
      return null;
    }

    const fs = AilyHost.get().fs;
    const files: EditFileSummary[] = [];
    const filesToCheck = this.currentTurnTrackedPaths.size > 0
      ? this.currentTurnTrackedPaths
      : this.initialFileContents.keys();

    for (const filePath of filesToCheck) {
      const baselineContent = this.currentTurnBaselines.get(filePath)
        ?? this.initialFileContents.get(filePath)
        ?? null;

      let currentContent: string | null = null;
      try {
        if (fs.existsSync(filePath)) {
          currentContent = fs.readFileSync(filePath, 'utf-8');
        }
      } catch { /* ignore */ }

      if (currentContent === baselineContent) {
        continue;
      }

      const counts = await this.computeLineCounts(baselineContent, currentContent);
      files.push({
        path: this.getDisplayPath(filePath),
        fullPath: filePath,
        type: this.resolveFallbackFileType(filePath, baselineContent, currentContent),
        contentKind: 'text',
        added: counts.added,
        removed: counts.removed,
      });
    }

    if (!files.length) {
      return null;
    }

    const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
    const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
    return {
      checkpointId: checkpointId || summarySnapshot?.checkpointId || 'current',
      turnContext: this.getTurnContextForSnapshot(summarySnapshot),
      fileCount: files.length,
      totalAdded,
      totalRemoved,
      files,
    };
  }

  private async computeLineCounts(before: string | null, after: string | null): Promise<{ added: number; removed: number }> {
    if (before === null && after !== null) {
      const added = await this.countAllLines(after);
      return { added, removed: 0 };
    }
    if (before !== null && after === null) {
      const removed = await this.countAllLines(before);
      return { added: 0, removed };
    }
    if (before === null || after === null) {
      return { added: 0, removed: 0 };
    }

    const diff = await this.editingTextDiffService.computeDiff(before, after, {
      ignoreTrimWhitespace: false,
      maxComputationTimeMs: 5_000,
      computeMoves: false,
      extendToSubwords: true,
    });
    let added = 0;
    let removed = 0;
    for (const change of diff.changes) {
      removed += Math.max(0, change.originalEndLineNumberExclusive - change.originalStartLineNumber);
      added += Math.max(0, change.modifiedEndLineNumberExclusive - change.modifiedStartLineNumber);
    }
    return { added, removed };
  }

  private async countAllLines(content: string): Promise<number> {
    if (content.length === 0) {
      return 0;
    }
    const diff = await this.editingTextDiffService.computeDiff('', content, {
      ignoreTrimWhitespace: false,
      maxComputationTimeMs: 5_000,
      computeMoves: false,
      extendToSubwords: true,
    });
    return diff.changes.reduce(
      (sum, change) => sum + Math.max(0, change.modifiedEndLineNumberExclusive - change.modifiedStartLineNumber),
      0,
    );
  }

  private getDisplayPath(filePath: string): string {
    const pathUtil = AilyHost.get().path;
    const projectPath = this.timelineWorkspaceRoot ?? (AilyHost.get().project.currentProjectPath || '');
    return projectPath ? pathUtil.relative(projectPath, filePath) : pathUtil.basename(filePath);
  }

  private resolveSummaryFileType(operationTypes: readonly string[]): 'create' | 'modify' | 'delete' {
    if (operationTypes.includes('create') && !operationTypes.includes('delete')) {
      return 'create';
    }
    if (operationTypes.includes('delete') && !operationTypes.includes('create')) {
      return 'delete';
    }
    return 'modify';
  }

  private resolveFallbackFileType(
    filePath: string,
    baselineContent: string | null,
    currentContent: string | null,
  ): 'create' | 'modify' | 'delete' {
    if (baselineContent === null && currentContent !== null) {
      return 'create';
    }
    if (baselineContent !== null && currentContent === null) {
      return 'delete';
    }
    return this.currentTurnOperations.get(filePath) || 'modify';
  }

  /** 从 pendingSnapshot 恢复所有文件 */
  private restoreFromPending(): RollbackResult {
    if (!this.pendingSnapshot) return { rolledBackFiles: 0, errors: ['没有待恢复的快照'] };
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    let rolledBackFiles = 0;
    const errors: string[] = [];

    for (const [filePath, content] of this.pendingSnapshot) {
      try {
        const currentExists = fs.existsSync(filePath);
        const currentContent = currentExists ? fs.readFileSync(filePath, 'utf-8') : null;
        if (currentContent === content) continue;

        if (content === null) {
          if (currentExists) { fs.unlinkSync(filePath); rolledBackFiles++; }
        } else {
          const dirPath = pathUtil.dirname(filePath);
          if (!fs.existsSync(dirPath)) { fs.mkdirSync(dirPath, { recursive: true }); }
          fs.writeFileSync(filePath, content, 'utf-8');
          rolledBackFiles++;
        }
      } catch (err: any) {
        errors.push(`恢复 ${filePath} 失败: ${err.message}`);
      }
    }

    this.pendingSnapshot = null;
    return { rolledBackFiles, errors };
  }

  /** Fallback: 从内存 initialFileContents 恢复所有文件到初始状态 */
  private restoreToInitialState(): RollbackResult {
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    let rolledBackFiles = 0;
    const errors: string[] = [];

    for (const [filePath, initialContent] of this.initialFileContents) {
      try {
        const currentExists = fs.existsSync(filePath);
        const currentContent = currentExists ? fs.readFileSync(filePath, 'utf-8') : null;
        if (currentContent === initialContent) continue;

        if (initialContent === null) {
          if (currentExists) { fs.unlinkSync(filePath); rolledBackFiles++; }
        } else {
          const dirPath = pathUtil.dirname(filePath);
          if (!fs.existsSync(dirPath)) { fs.mkdirSync(dirPath, { recursive: true }); }
          fs.writeFileSync(filePath, initialContent, 'utf-8');
          rolledBackFiles++;
        }
      } catch (err: any) {
        errors.push(`恢复 ${filePath} 失败: ${err.message}`);
      }
    }

    return { rolledBackFiles, errors };
  }

  /** 恢复单个文件到目标内容 */
  private restoreOneFile(filePath: string, targetContent: string | null): RollbackResult {
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    try {
      if (targetContent === null) {
        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
      } else {
        const dirPath = pathUtil.dirname(filePath);
        if (!fs.existsSync(dirPath)) { fs.mkdirSync(dirPath, { recursive: true }); }
        fs.writeFileSync(filePath, targetContent, 'utf-8');
      }
      return { rolledBackFiles: 1, errors: [] };
    } catch (err: any) {
      return { rolledBackFiles: 0, errors: [`恢复 ${filePath} 失败: ${err.message}`] };
    }
  }

  private captureCurrentTurnRepositoryRoot(filePath: string): void {
    const repositoryRoot = this.resolveGitRepositoryRoot(filePath);
    this.recordAdditionalRepositoryRoots(repositoryRoot ? [repositoryRoot] : undefined);
  }

  private getCurrentTurnAdditionalRepositoryRoots(): string[] {
    const workspaceRoot = this.timelineWorkspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    const normalizedWorkspaceRoot = workspaceRoot ? normalizeCheckpointPath(workspaceRoot) : null;
    return [...this.currentTurnAdditionalRepositoryRoots]
      .map(root => normalizeCheckpointPath(root))
      .filter(root => !!root && root !== normalizedWorkspaceRoot)
      .sort((left, right) => left.localeCompare(right));
  }

  private resolveGitRepositoryRoot(filePath: string): string | null {
    const workspaceRoot = this.timelineWorkspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    if (!workspaceRoot) {
      return null;
    }

    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    let current = normalizeCheckpointPath(isAbsoluteCheckpointPath(filePath) ? filePath : pathUtil.join(workspaceRoot, filePath));

    while (current) {
      const gitMarker = normalizeCheckpointPath(pathUtil.join(current, '.git'));
      if (fs.existsSync(gitMarker)) {
        return current;
      }

      const parent = normalizeCheckpointPath(dirnameCheckpointPath(current));
      if (!parent || parent === current) {
        break;
      }
      current = parent;
    }

    return null;
  }

  private toWorkspaceCheckpointDescriptor(snapshot: TurnSnapshot): WorkspaceCheckpointDescriptor {
    if (!snapshot.turnId) {
      throw new Error('Turn snapshot is missing turnId for workspace checkpoint descriptor');
    }

    const additionalRepositoryRoots = snapshot.additionalRepositoryRoots
      ?.map(root => normalizeCheckpointPath(root))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    return {
      checkpointId: snapshot.checkpointId,
      requestId: snapshot.turnId,
      turnId: snapshot.turnId,
      label: snapshot.displayContent ?? snapshot.requestContent ?? '',
      ...(additionalRepositoryRoots && additionalRepositoryRoots.length > 0 ? { additionalRepositoryRoots } : {}),
    };
  }

  private cloneTurnSnapshots(snapshots: readonly TurnSnapshot[]): TurnSnapshot[] {
    return snapshots.map(snapshot => ({
      ...snapshot,
      ...(snapshot.rounds ? { rounds: [...snapshot.rounds] } : {}),
      ...(snapshot.additionalRepositoryRoots ? { additionalRepositoryRoots: [...snapshot.additionalRepositoryRoots] } : {}),
      ...(snapshot.additionalCheckpointRefs ? { additionalCheckpointRefs: this.cloneStringRecord(snapshot.additionalCheckpointRefs) } : {}),
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
      checkpointNamespace: metadata.checkpointNamespace,
      turnIndex: metadata.turnIndex,
      ...(metadata.startCheckpointRef ? { startCheckpointRef: metadata.startCheckpointRef } : {}),
      ...(metadata.checkpointRef ? { checkpointRef: metadata.checkpointRef } : {}),
      ...(metadata.additionalStartCheckpointRefs ? { additionalStartCheckpointRefs: this.cloneStringRecord(metadata.additionalStartCheckpointRefs) } : {}),
      ...(metadata.additionalCheckpointRefs ? { additionalCheckpointRefs: this.cloneStringRecord(metadata.additionalCheckpointRefs) } : {}),
      ...(typeof metadata.createdAt === 'number' ? { createdAt: metadata.createdAt } : {}),
      ...(typeof metadata.completedAt === 'number' ? { completedAt: metadata.completedAt } : {}),
    };
  }

  private cloneTurnResponseTurn(turn: TurnResponseTurn): TurnResponseTurn {
    const requestMetadata = turn.request?.metadata && typeof turn.request.metadata === 'object'
      ? { ...(turn.request.metadata as Record<string, unknown>) } as TurnRequest['metadata']
      : turn.request?.metadata;
    return {
      ...turn,
      request: {
        ...turn.request,
        ...(requestMetadata ? { metadata: requestMetadata } : {}),
      },
      rounds: Array.isArray(turn.rounds)
        ? turn.rounds.map(round => ({ ...round }))
        : turn.rounds,
      response: turn.response
        ? {
            ...turn.response,
            parts: Array.isArray(turn.response.parts)
              ? turn.response.parts.map(part => ({ ...part }))
              : turn.response.parts,
          }
        : turn.response,
      ...(turn.responseModel ? { responseModel: { ...turn.responseModel } } : {}),
    };
  }

  private cloneTurnResponseTurnWithForkedCheckpointMetadata(
    turn: TurnResponseTurn,
    metadataByCheckpointId: ReadonlyMap<string, RequestCheckpointMetadata>,
  ): TurnResponseTurn {
    const cloned = this.cloneTurnResponseTurn(turn);
    const checkpointId = this.readCheckpointIdFromRequestMetadata(cloned.request?.metadata);
    if (!checkpointId) {
      return cloned;
    }

    const checkpointMetadata = metadataByCheckpointId.get(checkpointId);
    if (!checkpointMetadata) {
      return cloned;
    }

    const requestMetadata = cloned.request.metadata && typeof cloned.request.metadata === 'object'
      ? { ...(cloned.request.metadata as Record<string, unknown>) } as TurnRequest['metadata']
      : {} as TurnRequest['metadata'];
    this.clearCheckpointRefsFromRequestMetadata(requestMetadata);
    this.writeRequestCheckpointMetadata(requestMetadata, checkpointMetadata);
    return {
      ...cloned,
      request: {
        ...cloned.request,
        metadata: requestMetadata,
      },
    };
  }

  private readCheckpointIdFromRequestMetadata(metadata: TurnRequest['metadata'] | undefined): string | null {
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const checkpointId = (metadata as Record<string, unknown>)['checkpointId'];
    return typeof checkpointId === 'string' && checkpointId.trim()
      ? checkpointId.trim()
      : null;
  }

  private clearCheckpointRefsFromRequestMetadata(metadata: TurnRequest['metadata']): void {
    const mutableMetadata = metadata as Record<string, unknown>;
    delete mutableMetadata['checkpointNamespace'];
    delete mutableMetadata['checkpointTurnIndex'];
    delete mutableMetadata['startCheckpointRef'];
    delete mutableMetadata['checkpointRef'];
    delete mutableMetadata['checkpointRefs'];
    delete mutableMetadata['additionalStartCheckpointRefs'];
    delete mutableMetadata['additionalCheckpointRefs'];
  }

  private normalizeStringRecord(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key.trim(), typeof item === 'string' ? item.trim() : ''] as const)
      .filter(([key, item]) => key.length > 0 && item.length > 0);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  private cloneStringRecord(value: Record<string, string> | undefined): Record<string, string> | undefined {
    return value ? { ...value } : undefined;
  }

}

function normalizeCheckpointPath(target: string): string {
  return target.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function dirnameCheckpointPath(target: string): string {
  const normalized = normalizeCheckpointPath(target);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) {
    return normalized;
  }
  return normalized.slice(0, lastSlash);
}

function isAbsoluteCheckpointPath(target: string): boolean {
  return /^[A-Za-z]:\//.test(normalizeCheckpointPath(target)) || normalizeCheckpointPath(target).startsWith('/');
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
