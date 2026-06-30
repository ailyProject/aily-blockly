import { EditingContentStore } from './editing-content-store.service';
import { EditingTextDiffService } from './editing-text-diff.service';
import { EditingTimelineRepository } from './editing-timeline-repository.service';
import type {
  ContentRef,
  EditingSessionTimelineState,
  RequestEditSummary,
  TimelineDiffSummary,
  TimelineDiffChange,
  TimelineDiffCharChange,
  TimelineDiffStat,
  TimelineFileBaseline,
  TimelineFileOperation,
} from './editing-timeline.types';

const DEFAULT_DIFF_OPTIONS = {
  ignoreTrimWhitespace: false,
  maxComputationTimeMs: 5_000,
  computeMoves: false,
  extendToSubwords: true,
} as const;

export class EditingDiffService {
  constructor(
    private readonly repository: EditingTimelineRepository,
    private readonly contentStore: EditingContentStore,
    private readonly workspaceRoot: string,
    private readonly sessionId: string,
    private readonly textDiffService = new EditingTextDiffService(),
  ) {}

  async getRequestSummary(requestId: string): Promise<RequestEditSummary | null> {
    const state = this.loadState();
    if (!state) {
      return null;
    }

    const requestOps = state.operations
      .filter(operation => operation.requestId === requestId)
      .sort((left, right) => left.epoch - right.epoch);
    if (requestOps.length === 0) {
      return null;
    }

    const stats = await this.buildDiffStats(
      requestOps.map(operation => operation.uri),
      uri => this.getLatestBaselineForRequest(state, requestId, uri),
      uri => this.getLatestOperationForRequest(state, requestId, uri),
      requestOps,
    );

    return this.toRequestSummary(state, requestId, stats, requestOps);
  }

  getRequestSummarySync(requestId: string): RequestEditSummary | null {
    const state = this.loadState();
    if (!state) {
      return null;
    }

    const requestOps = state.operations
      .filter(operation => operation.requestId === requestId)
      .sort((left, right) => left.epoch - right.epoch);
    if (requestOps.length === 0) {
      return null;
    }

    const stats = this.buildDiffStatsSync(
      requestOps.map(operation => operation.uri),
      uri => this.getLatestBaselineForRequest(state, requestId, uri),
      uri => this.getLatestOperationForRequest(state, requestId, uri),
      requestOps,
    );

    return this.toRequestSummary(state, requestId, stats, requestOps);
  }

  async getCheckpointSummary(checkpointId: string): Promise<RequestEditSummary | null> {
    const state = this.loadState();
    if (!state) {
      return null;
    }

    const checkpoint = state.checkpoints.find(value => value.checkpointId === checkpointId);
    if (!checkpoint) {
      return null;
    }

    const summary = await this.getRequestSummary(checkpoint.requestId);
    return summary
      ? { ...summary, checkpointId }
      : null;
  }

  async getSessionDiff(): Promise<TimelineDiffStat[]> {
    const state = this.loadState();
    if (!state) {
      return [];
    }

    const uris = [...new Set(state.operations.map(operation => operation.uri))];
    return this.buildDiffStats(
      uris,
      uri => this.getEarliestBaselineForUri(state, uri),
      uri => this.getLatestOperationAtEpoch(state, uri, state.currentPointer.epoch),
      state.operations.filter(operation => operation.epoch <= state.currentPointer.epoch),
    );
  }

  async getDiffBetweenEpochs(fromEpoch: number, toEpoch: number): Promise<TimelineDiffStat[]> {
    const state = this.loadState();
    if (!state || toEpoch < fromEpoch) {
      return [];
    }

    const rangeOperations = state.operations
      .filter(operation => operation.epoch > fromEpoch && operation.epoch <= toEpoch)
      .sort((left, right) => left.epoch - right.epoch);
    const uris = [...new Set(rangeOperations.map(operation => operation.uri))];
    return this.buildDiffStats(
      uris,
      uri => this.resolveContentStateAtEpoch(state, uri, fromEpoch),
      uri => this.resolveContentStateAtEpoch(state, uri, toEpoch),
      rangeOperations,
    );
  }

  async getSummaryBetweenEpochs(fromEpoch: number, toEpoch: number): Promise<TimelineDiffSummary | null> {
    const state = this.loadState();
    if (!state || toEpoch < fromEpoch) {
      return null;
    }

    const rangeOperations = state.operations
      .filter(operation => operation.epoch > fromEpoch && operation.epoch <= toEpoch)
      .sort((left, right) => left.epoch - right.epoch);
    if (rangeOperations.length === 0) {
      return null;
    }

    const uris = [...new Set(rangeOperations.map(operation => operation.uri))];
    const stats = await this.buildDiffStats(
      uris,
      uri => this.resolveContentStateAtEpoch(state, uri, fromEpoch),
      uri => this.resolveContentStateAtEpoch(state, uri, toEpoch),
      rangeOperations,
    );

    return this.toTimelineDiffSummary(stats, rangeOperations);
  }

  async getDiffForUrisAtEpoch(uris: string[], epoch: number): Promise<TimelineDiffStat[]> {
    const state = this.loadState();
    if (!state) {
      return [];
    }

    return this.buildDiffStats(
      uris,
      uri => this.getEarliestBaselineForUri(state, uri),
      uri => this.resolveContentStateAtEpoch(state, uri, epoch),
      state.operations.filter(operation => operation.epoch <= epoch),
    );
  }

  private toRequestSummary(
    state: EditingSessionTimelineState,
    requestId: string,
    stats: TimelineDiffStat[],
    operations: readonly TimelineFileOperation[],
  ): RequestEditSummary | null {
    if (stats.length === 0) {
      return null;
    }

    const checkpointId = state.checkpoints.find(value => value.requestId === requestId)?.checkpointId;
    return {
      requestId,
      ...(checkpointId ? { checkpointId } : {}),
      fileCount: stats.length,
      stats,
      hasBinaryEdits: operations.some(operation => operation.contentKind === 'binary'),
      hasNotebookEdits: operations.some(operation => operation.contentKind === 'notebook'),
      hasRename: operations.some(operation => operation.type === 'rename'),
    };
  }

  private toTimelineDiffSummary(
    stats: TimelineDiffStat[],
    operations: readonly TimelineFileOperation[],
  ): TimelineDiffSummary | null {
    if (stats.length === 0) {
      return null;
    }

    return {
      fileCount: stats.length,
      stats,
      hasBinaryEdits: operations.some(operation => operation.contentKind === 'binary'),
      hasNotebookEdits: operations.some(operation => operation.contentKind === 'notebook'),
      hasRename: operations.some(operation => operation.type === 'rename'),
    };
  }

  private async buildDiffStats(
    uris: readonly string[],
    beforeResolver: (uri: string) => ContentState,
    afterResolver: (uri: string) => ContentState,
    operations: readonly TimelineFileOperation[],
  ): Promise<TimelineDiffStat[]> {
    const stats = await Promise.all(
      [...new Set(uris)].map(async uri => {
        const before = beforeResolver(uri);
        const after = afterResolver(uri);
        if (before.kind !== 'text' || after.kind !== 'text') {
          return this.createOpaqueDiffStat(uri, before, after, operations);
        }

        const diff = await this.textDiffService.computeDiff(before.content, after.content, DEFAULT_DIFF_OPTIONS);
        const changes = diff.changes.map(change => this.toTimelineDiffChange(change));
        const counts = summarizeTimelineChanges(changes);
        if (counts.addedLines === 0 && counts.removedLines === 0 && counts.changedLines === 0) {
          return null;
        }

        return {
          uri,
          contentKind: 'text',
          ...counts,
          operationTypes: this.collectOperationTypes(operations, uri),
          changes,
        } satisfies TimelineDiffStat;
      })
    );

    return stats.filter((value): value is NonNullable<typeof value> => value !== null);
  }

  private buildDiffStatsSync(
    uris: readonly string[],
    beforeResolver: (uri: string) => ContentState,
    afterResolver: (uri: string) => ContentState,
    operations: readonly TimelineFileOperation[],
  ): TimelineDiffStat[] {
    const stats = [...new Set(uris)].map(uri => {
      const before = beforeResolver(uri);
      const after = afterResolver(uri);
      if (before.kind !== 'text' || after.kind !== 'text') {
        return this.createOpaqueDiffStat(uri, before, after, operations);
      }

      const diff = this.textDiffService.computeDiffSync(before.content, after.content, DEFAULT_DIFF_OPTIONS);
      const changes = diff.changes.map(change => this.toTimelineDiffChange(change));
      const counts = summarizeTimelineChanges(changes);
      if (counts.addedLines === 0 && counts.removedLines === 0 && counts.changedLines === 0) {
        return null;
      }

      return {
        uri,
        contentKind: 'text',
        ...counts,
        operationTypes: this.collectOperationTypes(operations, uri),
        changes,
      } satisfies TimelineDiffStat;
    });

    return stats.filter((value): value is NonNullable<typeof value> => value !== null);
  }

  private createOpaqueDiffStat(
    uri: string,
    before: ContentState,
    after: ContentState,
    operations: readonly TimelineFileOperation[],
  ): TimelineDiffStat {
    return {
      uri,
      contentKind: after.kind !== 'text' ? after.kind : before.kind,
      addedLines: 0,
      removedLines: 0,
      changedLines: 0,
      operationTypes: this.collectOperationTypes(operations, uri),
    };
  }

  private toTimelineDiffChange(change: {
    originalStartLineNumber: number;
    originalEndLineNumberExclusive: number;
    modifiedStartLineNumber: number;
    modifiedEndLineNumberExclusive: number;
    charChanges?: Array<{
      originalStartLineNumber: number;
      originalStartColumn: number;
      originalEndLineNumber: number;
      originalEndColumn: number;
      modifiedStartLineNumber: number;
      modifiedStartColumn: number;
      modifiedEndLineNumber: number;
      modifiedEndColumn: number;
    }>;
  }): TimelineDiffChange {
    const originalLineCount = Math.max(0, change.originalEndLineNumberExclusive - change.originalStartLineNumber);
    const modifiedLineCount = Math.max(0, change.modifiedEndLineNumberExclusive - change.modifiedStartLineNumber);
    return {
      type: originalLineCount === 0 && modifiedLineCount > 0
        ? 'insert'
        : modifiedLineCount === 0 && originalLineCount > 0
          ? 'delete'
          : 'replace',
      originalStartLine: change.originalStartLineNumber,
      originalEndLineExclusive: change.originalEndLineNumberExclusive,
      modifiedStartLine: change.modifiedStartLineNumber,
      modifiedEndLineExclusive: change.modifiedEndLineNumberExclusive,
      ...(change.charChanges ? { charChanges: change.charChanges.map(charChange => this.toTimelineDiffCharChange(charChange)) } : {}),
    };
  }

  private toTimelineDiffCharChange(change: {
    originalStartLineNumber: number;
    originalStartColumn: number;
    originalEndLineNumber: number;
    originalEndColumn: number;
    modifiedStartLineNumber: number;
    modifiedStartColumn: number;
    modifiedEndLineNumber: number;
    modifiedEndColumn: number;
  }): TimelineDiffCharChange {
    return {
      originalStartLine: change.originalStartLineNumber,
      originalStartColumn: change.originalStartColumn,
      originalEndLine: change.originalEndLineNumber,
      originalEndColumn: change.originalEndColumn,
      modifiedStartLine: change.modifiedStartLineNumber,
      modifiedStartColumn: change.modifiedStartColumn,
      modifiedEndLine: change.modifiedEndLineNumber,
      modifiedEndColumn: change.modifiedEndColumn,
    };
  }

  private collectOperationTypes(operations: readonly TimelineFileOperation[], uri: string): string[] {
    return [...new Set(operations.filter(operation => operation.uri === uri).map(operation => operation.type))];
  }

  private getLatestBaselineForRequest(
    state: EditingSessionTimelineState,
    requestId: string,
    uri: string,
  ): ContentState {
    const baseline = state.baselines
      .filter(value => value.requestId === requestId && value.uri === uri)
      .sort((left, right) => right.epoch - left.epoch)[0];
    return this.contentStateFromBaseline(baseline);
  }

  private getEarliestBaselineForUri(state: EditingSessionTimelineState, uri: string): ContentState {
    const baseline = state.baselines
      .filter(value => value.uri === uri)
      .sort((left, right) => left.epoch - right.epoch)[0];
    return this.contentStateFromBaseline(baseline);
  }

  private getLatestOperationForRequest(
    state: EditingSessionTimelineState,
    requestId: string,
    uri: string,
  ): ContentState {
    const operation = state.operations
      .filter(value => value.requestId === requestId && value.uri === uri)
      .sort((left, right) => right.epoch - left.epoch)[0];
    return this.contentStateFromOperation(operation);
  }

  private getLatestOperationAtEpoch(
    state: EditingSessionTimelineState,
    uri: string,
    epoch: number,
  ): ContentState {
    const operation = state.operations
      .filter(value => value.uri === uri && value.epoch <= epoch)
      .sort((left, right) => right.epoch - left.epoch)[0];
    return operation ? this.contentStateFromOperation(operation) : this.getEarliestBaselineForUri(state, uri);
  }

  private resolveContentStateAtEpoch(
    state: EditingSessionTimelineState,
    uri: string,
    epoch: number,
  ): ContentState {
    const operation = state.operations
      .filter(value => value.uri === uri && value.epoch <= epoch)
      .sort((left, right) => right.epoch - left.epoch)[0];
    if (operation) {
      return this.contentStateFromOperation(operation);
    }

    const baseline = state.baselines
      .filter(value => value.uri === uri && value.epoch <= epoch)
      .sort((left, right) => right.epoch - left.epoch)[0];
    return this.contentStateFromBaseline(baseline);
  }

  private contentStateFromBaseline(baseline?: TimelineFileBaseline): ContentState {
    if (!baseline) {
      return { kind: 'text', exists: false, content: '' };
    }
    if (baseline.contentKind !== 'text') {
      return { kind: baseline.contentKind, exists: baseline.existed };
    }
    return {
      kind: 'text',
      exists: baseline.existed,
      content: baseline.contentRef ? this.contentStore.getText(this.workspaceRoot, this.sessionId, baseline.contentRef) : '',
    };
  }

  private contentStateFromOperation(operation?: TimelineFileOperation): ContentState {
    if (!operation) {
      return { kind: 'text', exists: false, content: '' };
    }
    if (operation.contentKind !== 'text') {
      return {
        kind: operation.contentKind,
        exists: operation.type !== 'delete',
      };
    }
    if (operation.type === 'delete') {
      return { kind: 'text', exists: false, content: '' };
    }
    if (operation.type === 'create') {
      return { kind: 'text', exists: true, content: this.readTextRef(operation.afterRef) };
    }
    if (operation.type === 'replace' || operation.type === 'text-edit') {
      return { kind: 'text', exists: true, content: this.readTextRef(operation.afterRef) };
    }
    return { kind: 'text', exists: true, content: '' };
  }

  private readTextRef(ref: ContentRef | null | undefined): string {
    if (!ref) {
      return '';
    }
    return this.contentStore.getText(this.workspaceRoot, this.sessionId, ref);
  }

  private loadState(): EditingSessionTimelineState | null {
    return this.repository.load(this.sessionId, this.workspaceRoot);
  }
}

type ContentState =
  | { kind: 'text'; exists: boolean; content: string }
  | { kind: 'binary' | 'notebook'; exists: boolean };

function summarizeTimelineChanges(
  changes: readonly TimelineDiffChange[],
): Pick<TimelineDiffStat, 'addedLines' | 'removedLines' | 'changedLines'> {
  let addedLines = 0;
  let removedLines = 0;
  let changedLines = 0;

  for (const change of changes) {
    const originalLineCount = Math.max(0, change.originalEndLineExclusive - change.originalStartLine);
    const modifiedLineCount = Math.max(0, change.modifiedEndLineExclusive - change.modifiedStartLine);
    removedLines += originalLineCount;
    addedLines += modifiedLineCount;
    changedLines += Math.min(originalLineCount, modifiedLineCount);
  }

  return { addedLines, removedLines, changedLines };
}
