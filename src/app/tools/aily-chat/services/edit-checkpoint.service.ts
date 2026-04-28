/**
 * EditCheckpointService — Copilot-style 文件变更快照与回滚服务
 *
 * 核心设计：
 * - initialFileContents: 每个文件首次被 AI 编辑前的原始内容（保留后刷新为当前态）
 * - currentTurnBaselines: 本轮 AI 编辑前的磁盘快照（每轮 recordEdit 时重新捕获）
 * - timeline: 线性快照时间线，每个 turn 一个 TurnSnapshot，内含 SnapshotStop
 * - timelineIndex: 当前游标位置，支持 undo/redo 双向导航
 * - pendingSnapshot: Undo 前自动保存的"最新磁盘状态"快照，确保 redo 可恢复
 *
 * 基线规则：
 * - 用户手动编辑不纳入 diff：recordEdit 在 AI 操作开始时捕获磁盘态作为本轮基线
 * - 保留后刷新 initialFileContents：其他 session 修改同文件不影响已保留会话
 * - 回到 session 时以最新磁盘内容为基准：新轮次 recordEdit 重新捕获
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { AilyHost } from '../core/host';

// ============================
// 类型定义
// ============================

export type FileEntryState = 'pending' | 'accepted' | 'rejected';

/** 单个文件在某快照点的状态 */
export interface SnapshotEntry {
  resource: string;
  current: string | null;
  state: FileEntryState;
}

/** 一个快照点 = 该时刻所有被追踪文件的状态集合 */
export interface SnapshotStop {
  stopId: string;
  entries: Record<string, SnapshotEntry>;
}

/** 一个 turn/request 对应的快照 */
export interface TurnSnapshot {
  requestId: string;
  turnIndex: number;
  /** @deprecated 使用 turnId 进行 Turn-native 截断 */
  conversationStartIndex: number;
  listStartIndex: number;
  /** 对应 TurnManager 中 Turn 的 ID，用于 Turn-native 回滚 */
  turnId?: string;
  stops: SnapshotStop[];
  createdAt: number;
}

/** 回滚/恢复操作的结果 */
export interface RollbackResult {
  rolledBackFiles: number;
  errors: string[];
}

// ============================
// Service
// ============================

@Injectable()
export class EditCheckpointService {

  /** 每个文件首次被 AI 编辑前的原始内容 (null = 文件不存在) */
  private initialFileContents = new Map<string, string | null>();

  /** 快照时间线（线性历史），无上限 */
  private timeline: TurnSnapshot[] = [];

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
   * 在首次 undo 时自动拍摄当前磁盘状态，确保 redo 到最末端时能恢复。
   * 新 turn 开始时清除（新操作取代 redo 历史）。
   */
  private pendingSnapshot: SnapshotStop | null = null;

  /** 当前 turn 中被修改的文件路径集合 */
  private currentTurnTrackedPaths = new Set<string>();

  /** 当前 turn 中各文件的操作类型（用于摘要显示） */
  private currentTurnOperations = new Map<string, 'create' | 'modify' | 'delete'>();

  /**
   * 本轮 AI 编辑前的磁盘基线（per-turn baseline）。
   * 每次 recordEdit 时捕获该文件此刻的磁盘内容。
   * 用于 getEditsSummary 计算 diff — 确保用户手动编辑不纳入统计。
   */
  private currentTurnBaselines = new Map<string, string | null>();

  /** 是否在活跃 turn 中 */
  private isInTurn = false;

  /** 自动保存模式 — 启用后 turn 内不推送摘要面板 */
  autoSaveEdits = false;

  // ---- UI 信号 ----

  private summarySubject = new BehaviorSubject<EditsSummary | null>(null);
  summaryChanged$ = this.summarySubject.asObservable();

  publishSummary(summary: EditsSummary | null): void {
    this.summarySubject.next(summary);
  }

  publishCurrentSummary(): void {
    // 自动保存模式下，turn 进行中不弹出面板
    if (this.autoSaveEdits && this.isInTurn) return;
    const summary = this.getEditsSummary();
    // 始终发射（含 null），确保无变更时面板能正确关闭
    this.summarySubject.next(summary);
  }

  dismissSummary(): void {
    this.summarySubject.next(null);
  }

  // ==================== 保留（Accept All as Baseline） ====================

  /**
   * 用户"保留"当前所有变更 — 将当前状态设为新基线。
   * - undo/redo 不再回退到此时间点之前
   * - 刷新 initialFileContents 为当前磁盘态，避免跨 session 产生幻影 diff
   * - restoreToCheckpoint（还原检查点）不受此限制，可跨保留边界回滚
   */
  acceptAllAsBaseline(): void {
    this.keptTimelineIndex = this.timelineIndex;
    this.pendingSnapshot = null;

    // 刷新 initialFileContents 为当前磁盘态
    // 确保保留后其他 session 对同文件的修改不产生幻影 diff
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

  /**
   * 开始新的 turn。
   * 如果处于 undo 状态（timelineIndex < timeline.length - 1），
   * 截断 redo 历史并清除 pendingSnapshot（新操作取代 redo）。
   */
  startTurn(turnIndex: number, conversationStartIndex: number, listStartIndex: number, turnId?: string): void {
    if (this.isInTurn) {
      this.commitCurrentTurn();
    }

    // 截断 redo 历史（新操作丢弃将来的快照）
    if (this.timelineIndex < this.timeline.length - 1) {
      this.timeline.splice(this.timelineIndex + 1);
    }
    this.pendingSnapshot = null;

    const snapshot: TurnSnapshot = {
      requestId: `cp_${Date.now()}_${turnIndex}`,
      turnIndex,
      conversationStartIndex,
      listStartIndex,
      turnId,
      stops: [],
      createdAt: Date.now(),
    };

    this.timeline.push(snapshot);
    this.timelineIndex = this.timeline.length - 1;

    this.currentTurnTrackedPaths.clear();
    this.currentTurnOperations.clear();
    this.currentTurnBaselines.clear();
    this.isInTurn = true;
  }

  /**
   * 记录一次文件编辑（在工具实际写盘前调用）。
   * - initialFileContents: 仅首次写入（用于 undo 回退到最初状态）
   * - currentTurnBaselines: 每轮重新捕获（用于 diff 计算，排除用户手动编辑）
   */
  recordEdit(filePath: string, type: 'create' | 'modify' | 'delete'): void {
    const fs = AilyHost.get().fs;

    // initialFileContents 仅首次写入 — 用于 undo 回退到最初状态
    if (!this.initialFileContents.has(filePath)) {
      let content: string | null = null;
      try {
        if (fs.existsSync(filePath)) {
          content = fs.readFileSync(filePath, 'utf-8');
        }
      } catch { /* ignore */ }
      this.initialFileContents.set(filePath, content);
    }

    // currentTurnBaselines 每轮首次编辑同一文件时捕获当前磁盘态
    // 这确保 diff 只反映本轮 AI 的实际变更，不包含用户手动编辑或其他 session 的变更
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
  }

  /**
   * 提交当前 turn — 创建快照点，捕获所有追踪文件的当前磁盘状态。
   * 对标 Copilot _createSnapshot() + _timeline.pushSnapshot()。
   */
  commitCurrentTurn(): void {
    if (!this.isInTurn) return;
    this.isInTurn = false;

    if (this.currentTurnTrackedPaths.size === 0) return;

    const stop = this.captureCurrentDiskState();
    const currentTurn = this.timeline[this.timelineIndex];
    if (currentTurn) {
      currentTurn.stops.push(stop);
    }
  }

  // ==================== Undo / Redo (对标 Copilot undoInteraction / redoInteraction) ====================

  get canUndo(): boolean {
    return this.timelineIndex > this.keptTimelineIndex;
  }

  get canRedo(): boolean {
    return this.timelineIndex < this.timeline.length - 1 || this.pendingSnapshot !== null;
  }

  /**
   * 撤销到上一个快照状态。
   * 对标 Copilot undoInteraction()：
   * 1. ensurePendingSnapshot() — 首次 undo 时保存当前磁盘状态
   * 2. 移动 timelineIndex
   * 3. 恢复文件到目标状态
   */
  undo(): RollbackResult {
    if (!this.canUndo) {
      return { rolledBackFiles: 0, errors: ['没有可撤销的操作'] };
    }

    this.ensurePendingSnapshot();

    this.timelineIndex--;

    const targetStop = this.timelineIndex >= 0
      ? this.getLastStopAt(this.timelineIndex)
      : null;

    return this.restoreFilesToState(targetStop);
  }

  /**
   * 重做到下一个快照状态。
   * 对标 Copilot redoInteraction()：
   * 1. 如果 timeline 中有下一个快照，使用它
   * 2. 否则使用 pendingSnapshot（恢复到 undo 前的最新状态）
   */
  redo(): RollbackResult {
    if (this.timelineIndex < this.timeline.length - 1) {
      this.timelineIndex++;
      const targetStop = this.getLastStopAt(this.timelineIndex);
      return this.restoreFilesToState(targetStop);
    }

    if (this.pendingSnapshot) {
      const result = this.restoreFilesToState(this.pendingSnapshot);
      this.pendingSnapshot = null;
      return result;
    }

    return { rolledBackFiles: 0, errors: ['没有可重做的操作'] };
  }

  // ==================== Per-file Accept / Reject ====================

  acceptFile(filePath: string): void {
    this.initialFileContents.delete(filePath);
    this.currentTurnTrackedPaths.delete(filePath);
    this.currentTurnBaselines.delete(filePath);
    this.currentTurnOperations.delete(filePath);

    for (const turn of this.timeline) {
      for (const stop of turn.stops) {
        if (stop.entries[filePath]) {
          stop.entries[filePath].state = 'accepted';
        }
      }
    }
  }

  rejectFile(filePath: string): RollbackResult {
    const initialContent = this.initialFileContents.get(filePath);
    if (initialContent === undefined) {
      return { rolledBackFiles: 0, errors: ['该文件未被追踪'] };
    }

    const result = this.restoreOneFile(filePath, initialContent);

    for (const turn of this.timeline) {
      for (const stop of turn.stops) {
        if (stop.entries[filePath]) {
          stop.entries[filePath].state = 'rejected';
        }
      }
    }

    this.initialFileContents.delete(filePath);
    this.currentTurnTrackedPaths.delete(filePath);
    this.currentTurnBaselines.delete(filePath);
    this.currentTurnOperations.delete(filePath);

    return result;
  }

  // ==================== 快照访问 ====================

  getSnapshotByRequestId(requestId: string): TurnSnapshot | undefined {
    return this.timeline.find(s => s.requestId === requestId);
  }

  getSnapshotByListIndex(listIndex: number): TurnSnapshot | undefined {
    return this.timeline.find(s =>
      s.listStartIndex === listIndex || s.listStartIndex === listIndex + 1
    );
  }

  getTurnStartListIndexByAnyListIndex(listIndex: number): number | null {
    let matched: TurnSnapshot | undefined;

    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const snapshot = this.timeline[i];
      // listStartIndex points to the aily placeholder; user message is at listStartIndex - 1
      const userMsgIndex = snapshot.listStartIndex - 1;
      if (userMsgIndex <= listIndex) {
        matched = snapshot;
        break;
      }
    }

    return matched ? matched.listStartIndex - 1 : null;
  }

  getLatestSnapshot(): TurnSnapshot | undefined {
    return this.timeline.length > 0 ? this.timeline[this.timeline.length - 1] : undefined;
  }

  // ==================== 截断（用于 restoreToCheckpoint / regenerate） ====================

  /**
   * 回滚到目标快照之前的状态，并截断目标及之后的时间线。
   * 同时清除 pendingSnapshot（截断操作不可 redo）。
   * 截断后将 keptTimelineIndex 设为 timeline.length - 1（还原点成为新起点）。
   */
  truncateFromSnapshot(requestId: string): RollbackResult {
    const idx = this.timeline.findIndex(s => s.requestId === requestId);
    if (idx === -1) {
      return { rolledBackFiles: 0, errors: [`未找到快照: ${requestId}`] };
    }

    const targetStop = idx > 0 ? this.getLastStopAt(idx - 1) : null;
    const result = this.restoreFilesToState(targetStop);

    this.timeline.splice(idx);
    this.timelineIndex = this.timeline.length - 1;
    this.pendingSnapshot = null;
    // 还原检查点后，剩余的时间线成为新基线
    this.keptTimelineIndex = this.timeline.length - 1;

    return result;
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

  /**
   * 是否有未保留的文件变更（用户尚未点击"保留"）。
   * 用于在切换会话 / 新建会话时提示用户。
   */
  hasUnsavedEdits(): boolean {
    if (this.initialFileContents.size === 0) return false;
    // keptTimelineIndex < timelineIndex 说明有新的变更未被保留
    return this.keptTimelineIndex < this.timelineIndex;
  }

  getTrackedFiles(): string[] {
    return [...this.initialFileContents.keys()];
  }

  getInitialContent(filePath: string): string | null | undefined {
    return this.initialFileContents.get(filePath);
  }

  // ==================== 编辑摘要 ====================

  /**
   * 获取当前 turn 的编辑摘要。
   * diff 基线 = max(keptTimelineIndex, timelineIndex - 1)，
   * 确保已保留的变更不会出现在摘要中。
   * 只包含 currentTurnTrackedPaths 中的文件（本轮实际编辑过的文件）。
   */
  getEditsSummary(requestId?: string): EditsSummary | null {
    if (this.initialFileContents.size === 0 && this.currentTurnTrackedPaths.size === 0) {
      return null;
    }

    // 所有变更已保留且当前 turn 无新编辑 — 无需展示摘要
    if (this.keptTimelineIndex >= this.timelineIndex && this.currentTurnTrackedPaths.size === 0) {
      return null;
    }

    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const projectPath = AilyHost.get().project.currentProjectPath || '';

    let totalAdded = 0;
    let totalRemoved = 0;
    const files: EditFileSummary[] = [];

    // 只遍历本轮实际编辑过的文件
    const filesToCheck = this.currentTurnTrackedPaths.size > 0
      ? this.currentTurnTrackedPaths
      : this.initialFileContents.keys();

    for (const filePath of filesToCheck) {
      // 基线优先级：
      // 1. currentTurnBaselines — 本轮 AI 开始编辑前的磁盘态（最精确，排除用户手动编辑）
      // 2. initialFileContents — 兜底（保留后已刷新为当前态，不会产生幻影 diff）
      const baselineContent = this.currentTurnBaselines.get(filePath)
        ?? this.initialFileContents.get(filePath)
        ?? null;

      let currentContent: string | null = null;
      try {
        if (fs.existsSync(filePath)) {
          currentContent = fs.readFileSync(filePath, 'utf-8');
        }
      } catch { /* ignore */ }

      if (currentContent === baselineContent) continue;

      const relativePath = projectPath
        ? pathUtil.relative(projectPath, filePath)
        : pathUtil.basename(filePath);

      let added = 0, removed = 0;
      let type: 'create' | 'modify' | 'delete';

      if (baselineContent === null && currentContent !== null) {
        type = 'create';
        added = currentContent.split('\n').length;
      } else if (baselineContent !== null && currentContent === null) {
        type = 'delete';
        removed = baselineContent.split('\n').length;
      } else {
        type = this.currentTurnOperations.get(filePath) || 'modify';
        const oldLines = (baselineContent || '').split('\n');
        const newLines = (currentContent || '').split('\n');
        const oldBag = new Map<string, number>();
        for (const line of oldLines) {
          oldBag.set(line, (oldBag.get(line) || 0) + 1);
        }
        let matched = 0;
        const tempBag = new Map(oldBag);
        for (const line of newLines) {
          const count = tempBag.get(line) || 0;
          if (count > 0) {
            tempBag.set(line, count - 1);
            matched++;
          }
        }
        removed = oldLines.length - matched;
        added = newLines.length - matched;
      }

      totalAdded += added;
      totalRemoved += removed;
      files.push({ path: relativePath, fullPath: filePath, type, added, removed });
    }

    if (files.length === 0) return null;

    const latestSnapshot = this.getLatestSnapshot();
    return {
      checkpointId: requestId || latestSnapshot?.requestId || 'current',
      fileCount: files.length,
      totalAdded,
      totalRemoved,
      files,
    };
  }

  // ==================== 持久化 — 文件系统存储 ====================
  // 将快照数据存储到 {projectPath}/.aily_checkpoints/ 目录，
  // state.json 只存储元数据（时间线结构、索引），
  // 文件内容独立存储在 contents/ 子目录，避免超大 JSON blob。

  private static readonly CHECKPOINT_DIR = '.aily_checkpoints';
  private static readonly STATE_FILE = 'state.json';
  private static readonly CONTENTS_DIR = 'contents';

  /** 将 filePath 转换为安全的文件名（用于存储内容文件） */
  private pathToKey(filePath: string): string {
    // 将路径中的非法字符替换为 _，保留一定可读性
    return filePath.replace(/[\\/:*?"<>|]/g, '_').replace(/_+/g, '_');
  }

  /** 内容文件路径 */
  private contentFilePath(checkpointDir: string, key: string): string {
    const pathUtil = AilyHost.get().path;
    return pathUtil.join(checkpointDir, EditCheckpointService.CONTENTS_DIR, key);
  }

  /** 将一段内容写入 contents/ 目录，返回 key */
  private writeContent(checkpointDir: string, filePath: string, content: string | null, suffix: string): string {
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const contentsDir = pathUtil.join(checkpointDir, EditCheckpointService.CONTENTS_DIR);
    if (!fs.existsSync(contentsDir)) {
      fs.mkdirSync(contentsDir, { recursive: true });
    }
    const key = this.pathToKey(filePath) + suffix;
    const fullPath = pathUtil.join(contentsDir, key);
    if (content === null) {
      // null 内容用特殊标记文件
      fs.writeFileSync(fullPath, '__NULL_CONTENT__', 'utf-8');
    } else {
      fs.writeFileSync(fullPath, content, 'utf-8');
    }
    return key;
  }

  /** 从 contents/ 中读取内容 */
  private readContent(checkpointDir: string, key: string): string | null {
    const fs = AilyHost.get().fs;
    const fullPath = this.contentFilePath(checkpointDir, key);
    try {
      if (!fs.existsSync(fullPath)) return null;
      const raw = fs.readFileSync(fullPath, 'utf-8');
      return raw === '__NULL_CONTENT__' ? null : raw;
    } catch {
      return null;
    }
  }

  /**
   * 持久化到项目目录下 .aily_checkpoints/{sessionId}/。
   * state.json 只存储元数据引用（content key），文件内容独立存储。
   * 按 chatSessionId 隔离存储。
   */
  saveToDisk(projectPath: string, sessionId: string): void {
    if (!sessionId) return;
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const checkpointDir = pathUtil.join(projectPath, EditCheckpointService.CHECKPOINT_DIR, sessionId);

    if (!fs.existsSync(checkpointDir)) {
      fs.mkdirSync(checkpointDir, { recursive: true });
    }

    // 1. 写入 initial file contents
    const initialRefs: Record<string, string> = {};
    for (const [filePath, content] of this.initialFileContents) {
      const key = this.writeContent(checkpointDir, filePath, content, '.initial');
      initialRefs[filePath] = key;
    }

    // 2. 写入 snapshot entries
    const serializeStop = (stop: SnapshotStop): { stopId: string; entryRefs: Record<string, { key: string; state: FileEntryState }> } => {
      const entryRefs: Record<string, { key: string; state: FileEntryState }> = {};
      for (const [fp, entry] of Object.entries(stop.entries)) {
        const key = this.writeContent(checkpointDir, fp, entry.current, `.${stop.stopId}`);
        entryRefs[fp] = { key, state: entry.state };
      }
      return { stopId: stop.stopId, entryRefs };
    };

    const timelineMeta = this.timeline.map(turn => ({
      requestId: turn.requestId,
      turnIndex: turn.turnIndex,
      conversationStartIndex: turn.conversationStartIndex,
      listStartIndex: turn.listStartIndex,
      createdAt: turn.createdAt,
      stops: turn.stops.map(serializeStop),
    }));

    let pendingMeta: { stopId: string; entryRefs: Record<string, { key: string; state: FileEntryState }> } | undefined;
    if (this.pendingSnapshot) {
      pendingMeta = serializeStop(this.pendingSnapshot);
    }

    // 3. 写 state.json（纯元数据，无文件内容）
    const state = {
      version: 5,
      sessionId,
      initialRefs,
      timeline: timelineMeta,
      timelineIndex: this.timelineIndex,
      keptTimelineIndex: this.keptTimelineIndex,
      pendingSnapshot: pendingMeta,
    };

    const statePath = pathUtil.join(checkpointDir, EditCheckpointService.STATE_FILE);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * 从项目目录下 .aily_checkpoints/{sessionId}/ 恢复。
   */
  loadFromDisk(projectPath: string, sessionId: string): boolean {
    if (!sessionId) return false;
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    // v5：按 sessionId 分目录，不再回退 v4 扁平结构（已废弃）
    const checkpointDir = pathUtil.join(projectPath, EditCheckpointService.CHECKPOINT_DIR, sessionId);
    const statePath = pathUtil.join(checkpointDir, EditCheckpointService.STATE_FILE);
    if (!fs.existsSync(statePath)) return false;

    try {
      const raw = fs.readFileSync(statePath, 'utf-8');
      const state = JSON.parse(raw);
      if (!state || state.version !== 5) return false;

      // 防御性校验：确保 checkpoint 数据确实属于请求的会话
      if (state.sessionId && state.sessionId !== sessionId) {
        console.warn(`[EditCheckpoint] checkpoint sessionId 不匹配 (expected=${sessionId}, found=${state.sessionId})，跳过加载`);
        return false;
      }

      // 恢复 initialFileContents
      this.initialFileContents.clear();
      for (const [filePath, key] of Object.entries(state.initialRefs || {})) {
        this.initialFileContents.set(filePath, this.readContent(checkpointDir, key as string));
      }

      // 恢复快照条目的辅助函数
      const deserializeStop = (meta: any): SnapshotStop => {
        const entries: Record<string, SnapshotEntry> = {};
        for (const [fp, ref] of Object.entries(meta.entryRefs || {})) {
          const { key, state: entryState } = ref as { key: string; state: FileEntryState };
          entries[fp] = {
            resource: fp,
            current: this.readContent(checkpointDir, key),
            state: entryState,
          };
        }
        return { stopId: meta.stopId, entries };
      };

      // 恢复 timeline
      this.timeline = (state.timeline || []).map((turn: any) => ({
        requestId: turn.requestId,
        turnIndex: turn.turnIndex,
        conversationStartIndex: turn.conversationStartIndex,
        listStartIndex: turn.listStartIndex,
        createdAt: turn.createdAt,
        stops: (turn.stops || []).map(deserializeStop),
      }));

      this.timelineIndex = state.timelineIndex ?? this.timeline.length - 1;
      this.keptTimelineIndex = state.keptTimelineIndex ?? -1;
      this.pendingSnapshot = state.pendingSnapshot ? deserializeStop(state.pendingSnapshot) : null;
      this.currentTurnTrackedPaths.clear();
      this.currentTurnOperations.clear();
      this.currentTurnBaselines.clear();
      this.isInTurn = false;

      return true;
    } catch (err) {
      console.warn('[EditCheckpoint] loadFromDisk failed:', err);
      return false;
    }
  }

  /**
   * 清除指定会话在项目目录下的 checkpoint 文件。
   * 如果 sessionId 为空，清除整个 .aily_checkpoints/ 目录（兼容旧数据）。
   */
  cleanDisk(projectPath: string, sessionId?: string): void {
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const dir = sessionId
      ? pathUtil.join(projectPath, EditCheckpointService.CHECKPOINT_DIR, sessionId)
      : pathUtil.join(projectPath, EditCheckpointService.CHECKPOINT_DIR);

    try {
      if (fs.existsSync(dir)) {
        this.removeDir(dir);
      }
    } catch (err) {
      console.warn('[EditCheckpoint] cleanDisk failed:', err);
    }
  }

  /**
   * 静态方法：删除指定会话的 checkpoint 目录。
   * 供 ChatHistoryService 在删除会话时调用，无需依赖服务实例。
   */
  static cleanSessionCheckpoints(projectPath: string, sessionId: string): void {
    if (!projectPath || !sessionId) return;
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const dir = pathUtil.join(projectPath, EditCheckpointService.CHECKPOINT_DIR, sessionId);
    try {
      if (fs.existsSync(dir)) {
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
        removeDir(dir);
      }
    } catch (err) {
      console.warn('[EditCheckpoint] cleanSessionCheckpoints failed:', err);
    }
  }

  /** 递归删除目录 */
  private removeDir(dirPath: string): void {
    const fs = AilyHost.get().fs;
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry}`;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        this.removeDir(fullPath);
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    fs.rmdirSync(dirPath);
  }

  /** @deprecated 兼容旧 JSON 格式 — 仅用于迁移旧数据 */
  restoreFromJSON(data: SerializedCheckpoints): void {
    if (!data) return;

    this.initialFileContents = new Map(
      Object.entries(data.initialFileContents || {})
    );

    this.timeline = (data.timeline || []).map((turn: any) => ({
      requestId: turn.requestId,
      turnIndex: turn.turnIndex,
      conversationStartIndex: turn.conversationStartIndex,
      listStartIndex: turn.listStartIndex,
      stops: (turn.stops || []).map((stop: any) => ({
        stopId: stop.stopId,
        entries: stop.entries || {},
      })),
      createdAt: turn.createdAt,
    }));

    this.timelineIndex = data.timelineIndex ?? this.timeline.length - 1;
    this.keptTimelineIndex = -1;
    this.pendingSnapshot = data.pendingSnapshot || null;
    this.currentTurnTrackedPaths.clear();
    this.currentTurnOperations.clear();
    this.currentTurnBaselines.clear();
    this.isInTurn = false;
  }

  clear(): void {
    this.initialFileContents.clear();
    this.timeline = [];
    this.timelineIndex = -1;
    this.keptTimelineIndex = -1;
    this.pendingSnapshot = null;
    this.currentTurnTrackedPaths.clear();
    this.currentTurnOperations.clear();
    this.currentTurnBaselines.clear();
    this.isInTurn = false;
  }

  // ==================== 内部辅助方法 ====================

  /**
   * 对标 Copilot _ensurePendingSnapshot()：
   * 在首次 undo 时拍摄当前磁盘状态，确保 redo 到末端时能恢复。
   */
  private ensurePendingSnapshot(): void {
    if (this.pendingSnapshot) return;
    this.pendingSnapshot = this.captureCurrentDiskState();
  }

  /** 捕获所有追踪文件的当前磁盘状态为一个 SnapshotStop */
  private captureCurrentDiskState(): SnapshotStop {
    const fs = AilyHost.get().fs;
    const entries: Record<string, SnapshotEntry> = {};
    for (const [filePath] of this.initialFileContents) {
      let current: string | null = null;
      try {
        if (fs.existsSync(filePath)) {
          current = fs.readFileSync(filePath, 'utf-8');
        }
      } catch { /* ignore */ }
      entries[filePath] = { resource: filePath, current, state: 'pending' };
    }
    return { stopId: `pending_${Date.now()}`, entries };
  }

  /** 获取指定时间线索引位置或之前最近的快照点 */
  private getLastStopAt(index: number): SnapshotStop | null {
    for (let i = index; i >= 0; i--) {
      const turn = this.timeline[i];
      if (turn && turn.stops.length > 0) {
        return turn.stops[turn.stops.length - 1];
      }
    }
    return null;
  }

  /** 恢复所有追踪文件到指定快照状态（null = 恢复到初始状态） */
  private restoreFilesToState(targetStop: SnapshotStop | null): RollbackResult {
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    let rolledBackFiles = 0;
    const errors: string[] = [];

    for (const [filePath, initialContent] of this.initialFileContents) {
      const targetContent = targetStop?.entries[filePath]?.current ?? initialContent;

      try {
        const currentExists = fs.existsSync(filePath);
        const currentContent = currentExists ? fs.readFileSync(filePath, 'utf-8') : null;

        if (currentContent === targetContent) continue;

        if (targetContent === null) {
          if (currentExists) {
            fs.unlinkSync(filePath);
            rolledBackFiles++;
          }
        } else {
          const dirPath = pathUtil.dirname(filePath);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
          fs.writeFileSync(filePath, targetContent, 'utf-8');
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
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } else {
        const dirPath = pathUtil.dirname(filePath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        fs.writeFileSync(filePath, targetContent, 'utf-8');
      }
      return { rolledBackFiles: 1, errors: [] };
    } catch (err: any) {
      return { rolledBackFiles: 0, errors: [`恢复 ${filePath} 失败: ${err.message}`] };
    }
  }
}

// ============================
// 导出类型
// ============================

export interface EditFileSummary {
  path: string;
  fullPath: string;
  type: 'create' | 'modify' | 'delete';
  added: number;
  removed: number;
  state?: FileEntryState;
}

export interface EditsSummary {
  checkpointId: string;
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
  files: EditFileSummary[];
}

export interface SerializedCheckpoints {
  initialFileContents?: Record<string, string | null>;
  timeline?: any[];
  timelineIndex?: number;
  pendingSnapshot?: SnapshotStop;
}
