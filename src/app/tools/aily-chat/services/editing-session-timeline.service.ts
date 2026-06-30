import { EditingContentStore } from './editing-content-store.service';
import { EditingTimelineRepository } from './editing-timeline-repository.service';
import type {
  CreateTimelineCheckpointInput,
  ContentRef,
  EditingSessionTimelineState,
  ReconstructedFileState,
  RestorePlan,
  TimelineCheckpoint,
  TimelineFileBaseline,
  TimelineFileOperation,
  TimelinePointer,
  TimelineRequestScope,
} from './editing-timeline.types';

export class EditingSessionTimelineService {
  constructor(
    private readonly repository: EditingTimelineRepository,
    private readonly contentStore: EditingContentStore,
    private readonly workspaceRoot: string,
    private readonly sessionId: string,
  ) {}

  getState(): EditingSessionTimelineState {
    return this.loadState() ?? this.repository.createEmptyState(this.sessionId, this.workspaceRoot);
  }

  getCurrentEpoch(): number {
    return this.getState().currentPointer.epoch;
  }

  getCheckpoint(checkpointId: string): TimelineCheckpoint | null {
    const state = this.loadState();
    if (!state) {
      return null;
    }

    return state.checkpoints.find(value => value.checkpointId === checkpointId) ?? null;
  }

  createCheckpoint(input: CreateTimelineCheckpointInput): TimelineCheckpoint {
    const state = this.getState();
    const scope = this.ensureRequestScope(state, input.requestId, input.turnId);
    const existing = state.checkpoints.find(value => value.checkpointId === input.checkpointId);
    const checkpoint: TimelineCheckpoint = existing ?? {
      checkpointId: input.checkpointId,
      requestId: input.requestId,
      epoch: state.currentPointer.epoch,
      label: input.label ?? '',
      createdAt: Date.now(),
    };

    checkpoint.requestId = input.requestId;
    checkpoint.epoch = state.currentPointer.epoch;
    checkpoint.label = input.label ?? checkpoint.label ?? '';
    checkpoint.createdAt = existing?.createdAt ?? checkpoint.createdAt;

    if (input.turnId) {
      checkpoint.turnId = input.turnId;
      scope.turnId = input.turnId;
    }
    if (input.stopId) {
      checkpoint.stopId = input.stopId;
    }
    if (input.description !== undefined) {
      checkpoint.description = input.description;
    }

    if (!existing) {
      state.checkpoints.push(checkpoint);
    }
    if (!scope.checkpointIds.includes(input.checkpointId)) {
      scope.checkpointIds.push(input.checkpointId);
    }

    state.currentPointer = {
      epoch: state.currentPointer.epoch,
      checkpointId: input.checkpointId,
      requestId: input.requestId,
      ...(input.stopId ? { stopId: input.stopId } : {}),
    };
    state.updatedAt = Date.now();
    this.repository.save(state);
    return checkpoint;
  }

  replaceCheckpoints(inputs: readonly CreateTimelineCheckpointInput[]): boolean {
    const state = this.getState();
    const checkpointIdsByRequestId = new Map<string, string[]>();
    const nextCheckpoints = inputs.map(input => {
      const existing = state.checkpoints.find(value => value.checkpointId === input.checkpointId);
      const scope = this.ensureRequestScope(state, input.requestId, input.turnId);
      const checkpointIds = checkpointIdsByRequestId.get(input.requestId) ?? [];
      checkpointIds.push(input.checkpointId);
      checkpointIdsByRequestId.set(input.requestId, checkpointIds);
      if (input.turnId) {
        scope.turnId = input.turnId;
      }

      return {
        checkpointId: input.checkpointId,
        requestId: input.requestId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.stopId ? { stopId: input.stopId } : {}),
        label: input.label ?? existing?.label ?? '',
        ...(input.description !== undefined ? { description: input.description } : existing?.description ? { description: existing.description } : {}),
        epoch: existing?.epoch ?? 0,
        createdAt: existing?.createdAt ?? Date.now(),
      } satisfies TimelineCheckpoint;
    });

    state.checkpoints = nextCheckpoints;
    state.requestScopes = state.requestScopes.map(scope => ({
      ...scope,
      checkpointIds: checkpointIdsByRequestId.get(scope.requestId) ?? [],
    }));
    state.updatedAt = Date.now();
    return this.repository.save(state);
  }

  getRequestEpochRange(requestId: string): { firstEpoch: number; lastEpoch: number } | null {
    const state = this.loadState();
    if (!state) {
      return null;
    }

    const scope = state.requestScopes.find(value => value.requestId === requestId);
    const requestOperations = state.operations
      .filter(value => value.requestId === requestId)
      .sort((left, right) => left.epoch - right.epoch);

    const firstEpoch = scope?.firstEpoch ?? requestOperations[0]?.epoch;
    const lastEpoch = scope?.lastEpoch ?? requestOperations.at(-1)?.epoch;
    if (firstEpoch === undefined && lastEpoch === undefined) {
      return null;
    }

    const resolvedFirstEpoch = firstEpoch ?? lastEpoch ?? 0;
    const resolvedLastEpoch = lastEpoch ?? firstEpoch ?? resolvedFirstEpoch;
    return {
      firstEpoch: resolvedFirstEpoch,
      lastEpoch: resolvedLastEpoch,
    };
  }

  collectTouchedUrisBetweenEpochs(fromEpoch: number, toEpoch: number): string[] {
    const state = this.loadState();
    if (!state) {
      return [];
    }

    const startEpoch = Math.min(fromEpoch, toEpoch);
    const endEpoch = Math.max(fromEpoch, toEpoch);
    return [...new Set(
      state.operations
        .filter(operation => operation.epoch > startEpoch && operation.epoch <= endEpoch)
        .flatMap(operation => this.getTouchedUris(operation))
    )];
  }

  async buildPlanForEpoch(checkpointId: string, epoch: number): Promise<RestorePlan> {
    const state = this.getState();
    const normalizedEpoch = Math.max(0, Math.min(epoch, state.epochCounter));
    const uris = this.collectTouchedUrisBetweenEpochs(state.currentPointer.epoch, normalizedEpoch);
    const files = await this.reconstructFilesAtEpoch(uris, normalizedEpoch);
    return {
      checkpointId,
      epoch: normalizedEpoch,
      files,
    };
  }

  async reconstructFilesAtEpoch(uris: string[], epoch: number): Promise<ReconstructedFileState[]> {
    const state = this.getState();
    const normalizedEpoch = Math.max(0, Math.min(epoch, state.epochCounter));
    return [...new Set(uris)].map(uri => this.resolveFileStateAtEpoch(state, uri, normalizedEpoch));
  }

  setCurrentPointer(pointer: TimelinePointer): boolean {
    const state = this.getState();
    state.currentPointer = {
      epoch: Math.max(0, Math.min(pointer.epoch, state.epochCounter)),
      ...(pointer.checkpointId ? { checkpointId: pointer.checkpointId } : {}),
      ...(pointer.requestId ? { requestId: pointer.requestId } : {}),
      ...(pointer.stopId ? { stopId: pointer.stopId } : {}),
    };
    state.updatedAt = Date.now();
    return this.repository.save(state);
  }

  private ensureRequestScope(
    state: EditingSessionTimelineState,
    requestId: string,
    turnId?: string,
  ): TimelineRequestScope {
    let scope = state.requestScopes.find(value => value.requestId === requestId);
    if (!scope) {
      scope = {
        requestId,
        ...(turnId ? { turnId } : {}),
        startedAt: Date.now(),
        status: 'open',
        checkpointIds: [],
        touchedUris: [],
      };
      state.requestScopes.push(scope);
    } else if (turnId) {
      scope.turnId = turnId;
    }

    return scope;
  }

  private getTouchedUris(operation: TimelineFileOperation): string[] {
    if (operation.type === 'rename') {
      return [operation.fromUri, operation.toUri];
    }
    return [operation.uri];
  }

  private resolveFileStateAtEpoch(
    state: EditingSessionTimelineState,
    uri: string,
    epoch: number,
  ): ReconstructedFileState {
    const operation = state.operations
      .filter(value => this.getTouchedUris(value).includes(uri) && value.epoch <= epoch)
      .sort((left, right) => right.epoch - left.epoch)[0];
    if (operation) {
      return this.fileStateFromOperation(state, operation, uri);
    }

    const baseline = state.baselines
      .filter(value => value.uri === uri && value.epoch <= epoch)
      .sort((left, right) => right.epoch - left.epoch)[0]
      ?? state.baselines
        .filter(value => value.uri === uri)
        .sort((left, right) => left.epoch - right.epoch)[0];
    return this.fileStateFromBaseline(baseline, uri);
  }

  private fileStateFromBaseline(baseline: TimelineFileBaseline | undefined, uri: string): ReconstructedFileState {
    if (!baseline) {
      return {
        uri,
        exists: false,
        contentKind: 'text',
        contentRef: null,
        sourceEpoch: 0,
      };
    }

    return {
      uri,
      exists: baseline.existed,
      contentKind: baseline.contentKind,
      contentRef: baseline.contentRef,
      sourceEpoch: baseline.epoch,
    };
  }

  private fileStateFromOperation(
    state: EditingSessionTimelineState,
    operation: TimelineFileOperation,
    uri: string,
  ): ReconstructedFileState {
    if (operation.type === 'delete') {
      return {
        uri,
        exists: false,
        contentKind: operation.contentKind,
        contentRef: null,
        sourceEpoch: operation.epoch,
      };
    }

    if (operation.type === 'rename') {
      if (uri === operation.fromUri) {
        return {
          uri,
          exists: false,
          contentKind: operation.contentKind,
          contentRef: null,
          sourceEpoch: operation.epoch,
        };
      }

      const previousState = this.resolveFileStateAtEpoch(state, operation.fromUri, operation.epoch - 1);
      return {
        uri,
        exists: previousState.exists,
        contentKind: previousState.contentKind,
        contentRef: previousState.contentRef,
        sourceEpoch: operation.epoch,
      };
    }

    if (operation.type === 'text-edit') {
      return {
        uri,
        exists: true,
        contentKind: 'text',
        contentRef: this.reconstructTextEditContentRef(operation),
        sourceEpoch: operation.epoch,
      };
    }

    const contentRef = this.getAfterContentRef(operation);
    return {
      uri,
      exists: true,
      contentKind: operation.contentKind,
      contentRef,
      sourceEpoch: operation.epoch,
    };
  }

  private getAfterContentRef(operation: TimelineFileOperation): ContentRef | null {
    if (operation.type === 'create') {
      return operation.afterRef;
    }
    if (operation.type === 'replace' || operation.type === 'text-edit') {
      return operation.afterRef;
    }
    return null;
  }

  private reconstructTextEditContentRef(operation: Extract<TimelineFileOperation, { type: 'text-edit' }>): ContentRef {
    const beforeContent = this.contentStore.getText(this.workspaceRoot, this.sessionId, operation.beforeRef);
    const reconstructed = applyNormalizedTextEdits(beforeContent, operation.edits);
    return this.contentStore.putText(this.workspaceRoot, this.sessionId, reconstructed);
  }

  private loadState(): EditingSessionTimelineState | null {
    return this.repository.load(this.sessionId, this.workspaceRoot);
  }
}

function applyNormalizedTextEdits(content: string, edits: readonly { startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }[]): string {
  if (!edits.length) {
    return content;
  }

  const lineStarts = computeLineStarts(content);
  const ranges = edits
    .map(edit => ({
      startOffset: positionToOffset(lineStarts, content.length, edit.startLine, edit.startColumn),
      endOffset: positionToOffset(lineStarts, content.length, edit.endLine, edit.endColumn),
      newText: edit.newText,
    }))
    .sort((left, right) => right.startOffset - left.startOffset);

  let result = content;
  for (const range of ranges) {
    result = `${result.slice(0, range.startOffset)}${range.newText}${result.slice(range.endOffset)}`;
  }
  return result;
}

function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function positionToOffset(lineStarts: readonly number[], contentLength: number, line: number, column: number): number {
  const safeLine = Math.max(1, line);
  const lineIndex = Math.min(safeLine - 1, lineStarts.length - 1);
  const lineStart = lineStarts[lineIndex] ?? contentLength;
  return Math.min(contentLength, lineStart + Math.max(0, column - 1));
}