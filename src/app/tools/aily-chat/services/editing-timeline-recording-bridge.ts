import { EditingContentStore } from './editing-content-store.service';
import { EditingTimelineRepository } from './editing-timeline-repository.service';
import type {
  EditingSessionTimelineState,
  NormalizedTextEdit,
  TimelineFileOperation,
  TimelineRequestScope,
} from './editing-timeline.types';

export interface EditingTimelineFileWriteEvent {
  turnId?: string;
  toolCallId?: string;
  filePath: string;
  existedBefore: boolean;
  contentKind?: 'text' | 'binary' | 'notebook';
  beforeContent?: string | null;
  afterContent?: string | null;
  beforeBytes?: Uint8Array | null;
  afterBytes?: Uint8Array;
  edits?: NormalizedTextEdit[];
}

export interface EditingTimelineWriter {
  recordFileWrite(event: EditingTimelineFileWriteEvent): Promise<void> | void;
}

export interface EditingTimelineWorktreeReconcileInput {
  turnId: string;
  filePaths: readonly string[];
  changes?: readonly EditingTimelineWorktreeChange[];
  readCurrentText: (filePath: string) => Promise<string | null>;
  readCurrentBytes?: (filePath: string) => Promise<Uint8Array | null>;
  computeEdits?: (beforeContent: string, afterContent: string) => Promise<NormalizedTextEdit[] | undefined>;
}

export type EditingTimelineWorktreeChange = {
  filePath: string;
  kind: 'create' | 'modify' | 'delete';
  contentKind: 'text' | 'binary' | 'notebook';
} | {
  filePath: string;
  previousFilePath: string;
  kind: 'rename';
  contentKind: 'text' | 'binary' | 'notebook';
};

interface TimelineKnownFileState {
  exists: boolean;
  contentKind: 'text' | 'binary' | 'notebook';
  textContent: string | null;
  binaryContent: Uint8Array | null;
}

export class EditingTimelineRecordingBridge {
  constructor(
    private readonly repository: EditingTimelineRepository,
    private readonly contentStore: EditingContentStore,
    private readonly workspaceRoot: string,
    private readonly sessionId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  recordFileWrite(event: EditingTimelineFileWriteEvent): void {
    if (!event.turnId) {
      return;
    }

    const requestId = event.turnId;
    const state = this.repository.load(this.sessionId, this.workspaceRoot)
      ?? this.repository.createEmptyState(this.sessionId, this.workspaceRoot);
    const contentKind = event.contentKind ?? 'text';

    const scope = this.ensureRequestScope(state, requestId, event.turnId);
    const baseline = this.ensureBaseline(state, requestId, event.filePath, event.existedBefore, contentKind, event.beforeContent, event.beforeBytes);
    const nextEpoch = state.epochCounter + 1;
    const operation = this.createWriteOperation(nextEpoch, requestId, event, baseline.contentKind, event.toolCallId);

    state.operations.push(operation);
    scope.lastEpoch = nextEpoch;
    scope.completedAt = this.now();
    scope.status = 'completed';
    if (!scope.touchedUris.includes(event.filePath)) {
      scope.touchedUris.push(event.filePath);
    }
    state.currentPointer = {
      epoch: nextEpoch,
      requestId,
    };
    state.epochCounter = nextEpoch;
    state.updatedAt = this.now();
    this.repository.save(state);
  }

  async reconcileWorktreeChanges(input: EditingTimelineWorktreeReconcileInput): Promise<void> {
    if (!input.turnId) {
      return;
    }

    const state = this.repository.load(this.sessionId, this.workspaceRoot)
      ?? this.repository.createEmptyState(this.sessionId, this.workspaceRoot);
    const scope = this.ensureRequestScope(state, input.turnId, input.turnId);
    const candidateChanges = this.buildWorktreeCandidates(scope.touchedUris, input);
    if (candidateChanges.length === 0) {
      return;
    }

    for (const change of candidateChanges) {
      if (change.kind === 'rename') {
        await this.reconcileRenameWorktreeChange(state, scope, input, change);
        continue;
      }

      const known = this.readCurrentFileState(state, change.filePath, state.currentPointer.epoch);
      const contentKind = change.contentKind ?? known.contentKind;

      if (contentKind === 'binary') {
        await this.reconcileBinaryWorktreeChange(input, change, known);
        continue;
      }

      const afterContent = change.kind === 'delete'
        ? null
        : await input.readCurrentText(change.filePath);
      const existsAfter = afterContent !== null;
      if (
        known.exists === existsAfter
        && known.contentKind === contentKind
        && known.textContent === afterContent
      ) {
        continue;
      }

      const edits = contentKind === 'text'
        && known.textContent !== null
        && afterContent !== null
        && input.computeEdits
        ? await input.computeEdits(known.textContent, afterContent)
        : undefined;

      this.recordFileWrite({
        turnId: input.turnId,
        filePath: change.filePath,
        existedBefore: known.exists,
        contentKind,
        beforeContent: known.textContent,
        afterContent,
        ...(edits && edits.length > 0 ? { edits } : {}),
      });
    }
  }

  private ensureRequestScope(
    state: EditingSessionTimelineState,
    requestId: string,
    turnId: string,
  ): TimelineRequestScope {
    let scope = state.requestScopes.find(value => value.requestId === requestId);
    if (scope) {
      return scope;
    }

    scope = {
      requestId,
      turnId,
      startedAt: this.now(),
      status: 'open',
      checkpointIds: [],
      touchedUris: [],
    };
    state.requestScopes.push(scope);
    return scope;
  }

  private ensureBaseline(
    state: EditingSessionTimelineState,
    requestId: string,
    filePath: string,
    existedBefore: boolean,
    contentKind: 'text' | 'binary' | 'notebook',
    beforeContent?: string | null,
    beforeBytes?: Uint8Array | null,
  ) {
    let baseline = state.baselines.find(value => value.requestId === requestId && value.uri === filePath);
    if (baseline) {
      return baseline;
    }

    baseline = {
      baselineId: `baseline:${requestId}:${state.baselines.length + 1}`,
      requestId,
      uri: filePath,
      epoch: state.currentPointer.epoch,
      contentRef: this.createContentRef(contentKind, beforeContent, beforeBytes),
      contentKind,
      existed: existedBefore,
      createdAt: this.now(),
    };
    state.baselines.push(baseline);
    return baseline;
  }

  private createWriteOperation(
    epoch: number,
    requestId: string,
    event: EditingTimelineFileWriteEvent,
    contentKind: 'text' | 'binary' | 'notebook',
    toolCallId?: string,
  ): TimelineFileOperation {
    const afterRef = this.createContentRef(contentKind, event.afterContent, event.afterBytes);
    const beforeRef = this.createContentRef(contentKind, event.beforeContent, event.beforeBytes);
    const operationId = toolCallId
      ? `op:${requestId}:${toolCallId}:${epoch}`
      : `op:${requestId}:${epoch}`;

    if (
      contentKind === 'text'
      && Array.isArray(event.edits)
      && event.edits.length > 0
      && beforeRef
      && afterRef
    ) {
      return {
        operationId,
        requestId,
        epoch,
        uri: event.filePath,
        contentKind,
        createdAt: this.now(),
        type: 'text-edit',
        beforeRef,
        afterRef,
        edits: event.edits,
      };
    }

    if (!event.existedBefore) {
      return {
        operationId,
        requestId,
        epoch,
        uri: event.filePath,
        contentKind,
        createdAt: this.now(),
        type: 'create',
        afterRef,
      };
    }

    const deletedAfter = contentKind === 'binary'
      ? event.afterBytes === null || event.afterBytes === undefined
      : event.afterContent === null || event.afterContent === undefined;
    if (deletedAfter) {
      return {
        operationId,
        requestId,
        epoch,
        uri: event.filePath,
        contentKind,
        createdAt: this.now(),
        type: 'delete',
        beforeRef,
      };
    }

    return {
      operationId,
      requestId,
      epoch,
      uri: event.filePath,
      contentKind,
      createdAt: this.now(),
      type: 'replace',
      beforeRef,
      afterRef,
    };
  }

  private createContentRef(
    contentKind: 'text' | 'binary' | 'notebook',
    textContent?: string | null,
    binaryContent?: Uint8Array | null,
  ) {
    if (contentKind === 'binary') {
      return binaryContent ? this.contentStore.putBinary(this.workspaceRoot, this.sessionId, binaryContent) : null;
    }

    if (textContent === null || textContent === undefined) {
      return null;
    }

    return this.contentStore.putText(this.workspaceRoot, this.sessionId, textContent);
  }

  private readCurrentFileState(
    state: EditingSessionTimelineState,
    uri: string,
    epoch: number,
  ): TimelineKnownFileState {
    const operation = state.operations
      .filter(value => this.getTouchedUris(value).includes(uri) && value.epoch <= epoch)
      .sort((left, right) => right.epoch - left.epoch)[0];
    if (operation) {
      if (operation.type === 'delete') {
        return {
          exists: false,
          contentKind: operation.contentKind,
          textContent: null,
          binaryContent: null,
        };
      }
      if (operation.type === 'rename') {
        if (uri === operation.fromUri) {
          return {
            exists: false,
            contentKind: operation.contentKind,
            textContent: null,
            binaryContent: null,
          };
        }
        return this.readCurrentFileState(state, operation.fromUri, operation.epoch - 1);
      }

      if (operation.contentKind === 'binary') {
        return {
          exists: true,
          contentKind: 'binary',
          textContent: null,
          binaryContent: operation.afterRef ? this.contentStore.getBinary(this.workspaceRoot, this.sessionId, operation.afterRef) : new Uint8Array(),
        };
      }

      const contentRef = operation.afterRef;
      return {
        exists: true,
        contentKind: operation.contentKind,
        textContent: contentRef ? this.contentStore.getText(this.workspaceRoot, this.sessionId, contentRef) : '',
        binaryContent: null,
      };
    }

    const baseline = state.baselines
      .filter(value => value.uri === uri && value.epoch <= epoch)
      .sort((left, right) => right.epoch - left.epoch)[0]
      ?? state.baselines
        .filter(value => value.uri === uri)
        .sort((left, right) => left.epoch - right.epoch)[0];
    if (!baseline) {
      return {
        exists: false,
        contentKind: 'text',
        textContent: null,
        binaryContent: null,
      };
    }

    if (baseline.contentKind === 'binary') {
      return {
        exists: baseline.existed,
        contentKind: 'binary',
        textContent: null,
        binaryContent: baseline.contentRef ? this.contentStore.getBinary(this.workspaceRoot, this.sessionId, baseline.contentRef) : null,
      };
    }

    return {
      exists: baseline.existed,
      contentKind: baseline.contentKind,
      textContent: baseline.contentRef ? this.contentStore.getText(this.workspaceRoot, this.sessionId, baseline.contentRef) : null,
      binaryContent: null,
    };
  }

  private buildWorktreeCandidates(
    touchedUris: readonly string[],
    input: EditingTimelineWorktreeReconcileInput,
  ): EditingTimelineWorktreeChange[] {
    const renamePaths = new Set<string>();
    for (const change of input.changes ?? []) {
      if (change.kind === 'rename') {
        renamePaths.add(change.filePath);
        renamePaths.add(change.previousFilePath);
      }
    }
    const candidates = new Map<string, EditingTimelineWorktreeChange>();
    for (const filePath of touchedUris) {
      if (renamePaths.has(filePath)) {
        continue;
      }
      candidates.set(filePath, {
        filePath,
        kind: 'modify',
        contentKind: 'text',
      });
    }
    for (const filePath of input.filePaths) {
      if (renamePaths.has(filePath)) {
        continue;
      }
      candidates.set(filePath, {
        filePath,
        kind: 'modify',
        contentKind: candidates.get(filePath)?.contentKind ?? 'text',
      });
    }
    for (const change of input.changes ?? []) {
      candidates.set(change.filePath, change);
    }
    return Array.from(candidates.values());
  }

  private async reconcileRenameWorktreeChange(
    state: EditingSessionTimelineState,
    scope: TimelineRequestScope,
    input: EditingTimelineWorktreeReconcileInput,
    change: Extract<EditingTimelineWorktreeChange, { kind: 'rename' }>,
  ): Promise<void> {
    const knownFrom = this.readCurrentFileState(state, change.previousFilePath, state.currentPointer.epoch);
    if (!knownFrom.exists) {
      return;
    }

    const nextEpoch = state.epochCounter + 1;
    state.operations.push({
      operationId: `op:${input.turnId}:rename:${nextEpoch}`,
      requestId: input.turnId,
      epoch: nextEpoch,
      uri: change.filePath,
      contentKind: change.contentKind,
      createdAt: this.now(),
      type: 'rename',
      fromUri: change.previousFilePath,
      toUri: change.filePath,
    });
    scope.lastEpoch = nextEpoch;
    scope.completedAt = this.now();
    scope.status = 'completed';
    if (!scope.touchedUris.includes(change.previousFilePath)) {
      scope.touchedUris.push(change.previousFilePath);
    }
    if (!scope.touchedUris.includes(change.filePath)) {
      scope.touchedUris.push(change.filePath);
    }
    state.currentPointer = {
      epoch: nextEpoch,
      requestId: input.turnId,
    };
    state.epochCounter = nextEpoch;
    state.updatedAt = this.now();
    this.repository.save(state);

    if (change.contentKind === 'binary') {
      const afterBytes = await input.readCurrentBytes?.(change.filePath) ?? null;
      if (!areBytesEqual(knownFrom.binaryContent, afterBytes)) {
        this.recordFileWrite({
          turnId: input.turnId,
          filePath: change.filePath,
          existedBefore: true,
          contentKind: 'binary',
          beforeBytes: knownFrom.binaryContent,
          afterBytes: afterBytes ?? undefined,
        });
      }
      return;
    }

    const afterContent = await input.readCurrentText(change.filePath);
    if (knownFrom.textContent === afterContent) {
      return;
    }

    const edits = change.contentKind === 'text'
      && knownFrom.textContent !== null
      && afterContent !== null
      && input.computeEdits
      ? await input.computeEdits(knownFrom.textContent, afterContent)
      : undefined;
    this.recordFileWrite({
      turnId: input.turnId,
      filePath: change.filePath,
      existedBefore: true,
      contentKind: change.contentKind,
      beforeContent: knownFrom.textContent,
      afterContent,
      ...(edits && edits.length > 0 ? { edits } : {}),
    });
  }

  private async reconcileBinaryWorktreeChange(
    input: EditingTimelineWorktreeReconcileInput,
    change: EditingTimelineWorktreeChange,
    known: TimelineKnownFileState,
  ): Promise<void> {
    const afterBytes = change.kind === 'delete'
      ? null
      : await input.readCurrentBytes?.(change.filePath) ?? null;
    const existsAfter = afterBytes !== null;
    if (
      known.exists === existsAfter
      && known.contentKind === 'binary'
      && areBytesEqual(known.binaryContent, afterBytes)
    ) {
      return;
    }

    this.recordFileWrite({
      turnId: input.turnId,
      filePath: change.filePath,
      existedBefore: known.exists,
      contentKind: 'binary',
      beforeBytes: known.binaryContent,
      afterBytes: afterBytes ?? undefined,
    });
  }

  private getTouchedUris(operation: TimelineFileOperation): string[] {
    if (operation.type === 'rename') {
      return [operation.fromUri, operation.toUri];
    }
    return [operation.uri];
  }
}

function areBytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
