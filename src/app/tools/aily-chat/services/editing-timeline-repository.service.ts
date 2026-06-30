import { AilyHost } from '../core/host';
import type {
  EditingSessionTimelineState,
  TimelineCheckpoint,
  TimelineFileBaseline,
  TimelineFileOperation,
  TimelinePointer,
  TimelineRequestScope,
} from './editing-timeline.types';

export interface EditingTimelineRepositoryOptions {
  joinPath: (...parts: string[]) => string;
  timelineRootDirName?: string;
  timelineFileName?: string;
  now?: () => number;
}

export class EditingTimelineRepository {
  private readonly timelineRootDirName: string;
  private readonly timelineFileName: string;

  constructor(private readonly options: EditingTimelineRepositoryOptions) {
    this.timelineRootDirName = options.timelineRootDirName ?? '.aily/chat-editing';
    this.timelineFileName = options.timelineFileName ?? 'timeline.json';
  }

  createEmptyState(sessionId: string, workspaceRoot: string): EditingSessionTimelineState {
    const now = this.now();
    return {
      version: 1,
      sessionId,
      workspaceRoot,
      checkpoints: [],
      baselines: [],
      operations: [],
      requestScopes: [],
      currentPointer: { epoch: 0 },
      epochCounter: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  getSessionDir(workspaceRoot: string, sessionId: string): string {
    return this.options.joinPath(workspaceRoot, this.timelineRootDirName, sessionId);
  }

  getTimelinePath(workspaceRoot: string, sessionId: string): string {
    return this.options.joinPath(this.getSessionDir(workspaceRoot, sessionId), this.timelineFileName);
  }

  load(sessionId: string, workspaceRoot: string): EditingSessionTimelineState | null {
    if (!this.hasFs()) {
      return null;
    }

    const path = this.getTimelinePath(workspaceRoot, sessionId);
    if (!this.fileExists(path)) {
      return null;
    }

    try {
      const raw = JSON.parse(this.readFileSync(path));
      return this.normalizeState(raw, sessionId, workspaceRoot);
    } catch (error) {
      console.warn(`[EditingTimeline] 加载 timeline 失败 (${sessionId}):`, error);
      return null;
    }
  }

  save(state: EditingSessionTimelineState): boolean {
    if (!this.hasFs()) {
      return false;
    }

    const normalized = this.normalizeState(state, state.sessionId, state.workspaceRoot);
    normalized.updatedAt = this.now();

    try {
      const dir = this.getSessionDir(normalized.workspaceRoot, normalized.sessionId);
      this.ensureDir(dir);
      const path = this.getTimelinePath(normalized.workspaceRoot, normalized.sessionId);
      this.writeFileSync(path, JSON.stringify(normalized, null, 2));
      return true;
    } catch (error) {
      console.warn(`[EditingTimeline] 写入 timeline 失败 (${state.sessionId}):`, error);
      return false;
    }
  }

  delete(sessionId: string, workspaceRoot: string): boolean {
    if (!this.hasFs()) {
      return false;
    }

    const path = this.getTimelinePath(workspaceRoot, sessionId);
    if (!this.fileExists(path)) {
      return false;
    }

    try {
      AilyHost.get().fs.unlinkSync(path);
      return true;
    } catch (error) {
      console.warn(`[EditingTimeline] 删除 timeline 失败 (${sessionId}):`, error);
      return false;
    }
  }

  private normalizeState(raw: unknown, sessionId: string, workspaceRoot: string): EditingSessionTimelineState {
    const state = this.asRecord(raw);
    const now = this.now();

    return {
      version: 1,
      sessionId: this.asNonEmptyString(state.sessionId) ?? sessionId,
      workspaceRoot: this.asNonEmptyString(state.workspaceRoot) ?? workspaceRoot,
      checkpoints: this.asCheckpoints(state.checkpoints),
      baselines: this.asBaselines(state.baselines),
      operations: this.asOperations(state.operations),
      requestScopes: this.asRequestScopes(state.requestScopes),
      currentPointer: this.asPointer(state.currentPointer),
      epochCounter: this.asNumber(state.epochCounter) ?? 0,
      createdAt: this.asNumber(state.createdAt) ?? now,
      updatedAt: this.asNumber(state.updatedAt) ?? now,
    };
  }

  private asPointer(raw: unknown): TimelinePointer {
    const pointer = this.asRecord(raw);
    return {
      epoch: this.asNumber(pointer.epoch) ?? 0,
      ...(this.asNonEmptyString(pointer.checkpointId) ? { checkpointId: this.asNonEmptyString(pointer.checkpointId)! } : {}),
      ...(this.asNonEmptyString(pointer.requestId) ? { requestId: this.asNonEmptyString(pointer.requestId)! } : {}),
      ...(this.asNonEmptyString(pointer.stopId) ? { stopId: this.asNonEmptyString(pointer.stopId)! } : {}),
    };
  }

  private asRequestScopes(raw: unknown): TimelineRequestScope[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map(value => this.asRecord(value))
      .filter(scope => !!this.asNonEmptyString(scope.requestId))
      .map(scope => ({
        requestId: this.asNonEmptyString(scope.requestId)!,
        ...(this.asNonEmptyString(scope.turnId) ? { turnId: this.asNonEmptyString(scope.turnId)! } : {}),
        ...(this.asNonEmptyString(scope.responseId) ? { responseId: this.asNonEmptyString(scope.responseId)! } : {}),
        startedAt: this.asNumber(scope.startedAt) ?? this.now(),
        ...(this.asNumber(scope.completedAt) !== undefined ? { completedAt: this.asNumber(scope.completedAt)! } : {}),
        status: this.asRequestStatus(scope.status),
        ...(this.asNumber(scope.firstEpoch) !== undefined ? { firstEpoch: this.asNumber(scope.firstEpoch)! } : {}),
        ...(this.asNumber(scope.lastEpoch) !== undefined ? { lastEpoch: this.asNumber(scope.lastEpoch)! } : {}),
        checkpointIds: this.asStringArray(scope.checkpointIds),
        touchedUris: this.asStringArray(scope.touchedUris),
      }));
  }

  private asCheckpoints(raw: unknown): TimelineCheckpoint[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map(value => this.asRecord(value))
      .filter(checkpoint => !!this.asNonEmptyString(checkpoint.checkpointId) && !!this.asNonEmptyString(checkpoint.requestId))
      .map(checkpoint => ({
        checkpointId: this.asNonEmptyString(checkpoint.checkpointId)!,
        requestId: this.asNonEmptyString(checkpoint.requestId)!,
        ...(this.asNonEmptyString(checkpoint.turnId) ? { turnId: this.asNonEmptyString(checkpoint.turnId)! } : {}),
        ...(this.asNonEmptyString(checkpoint.stopId) ? { stopId: this.asNonEmptyString(checkpoint.stopId)! } : {}),
        label: this.asNonEmptyString(checkpoint.label) ?? '',
        ...(this.asNonEmptyString(checkpoint.description) ? { description: this.asNonEmptyString(checkpoint.description)! } : {}),
        epoch: this.asNumber(checkpoint.epoch) ?? 0,
        createdAt: this.asNumber(checkpoint.createdAt) ?? this.now(),
      }));
  }

  private asBaselines(raw: unknown): TimelineFileBaseline[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map(value => this.asRecord(value))
      .filter(baseline => !!this.asNonEmptyString(baseline.baselineId) && !!this.asNonEmptyString(baseline.requestId) && !!this.asNonEmptyString(baseline.uri))
      .map(baseline => ({
        baselineId: this.asNonEmptyString(baseline.baselineId)!,
        requestId: this.asNonEmptyString(baseline.requestId)!,
        uri: this.asNonEmptyString(baseline.uri)!,
        epoch: this.asNumber(baseline.epoch) ?? 0,
        contentRef: this.asNullableContentRef(baseline.contentRef),
        contentKind: this.asContentKind(baseline.contentKind),
        ...(this.asNonEmptyString(baseline.languageId) ? { languageId: this.asNonEmptyString(baseline.languageId)! } : {}),
        existed: typeof baseline.existed === 'boolean' ? baseline.existed : false,
        createdAt: this.asNumber(baseline.createdAt) ?? this.now(),
      }));
  }

  private asOperations(raw: unknown): TimelineFileOperation[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map(value => this.asRecord(value))
      .filter(operation => !!this.asNonEmptyString(operation.operationId) && !!this.asNonEmptyString(operation.requestId) && !!this.asNonEmptyString(operation.uri))
      .map(operation => {
        const base = {
          operationId: this.asNonEmptyString(operation.operationId)!,
          requestId: this.asNonEmptyString(operation.requestId)!,
          ...(this.asNonEmptyString(operation.checkpointId) ? { checkpointId: this.asNonEmptyString(operation.checkpointId)! } : {}),
          epoch: this.asNumber(operation.epoch) ?? 0,
          uri: this.asNonEmptyString(operation.uri)!,
          contentKind: this.asContentKind(operation.contentKind),
          createdAt: this.asNumber(operation.createdAt) ?? this.now(),
        };
        const type = this.asOperationType(operation.type);
        if (type === 'create') {
          return { ...base, type, afterRef: this.asNullableContentRef(operation.afterRef) };
        }
        if (type === 'delete') {
          return { ...base, type, beforeRef: this.asNullableContentRef(operation.beforeRef) };
        }
        if (type === 'rename') {
          return {
            ...base,
            type,
            fromUri: this.asNonEmptyString(operation.fromUri) ?? base.uri,
            toUri: this.asNonEmptyString(operation.toUri) ?? base.uri,
          };
        }
        if (type === 'text-edit') {
          return {
            ...base,
            type,
            beforeRef: this.asRequiredContentRef(operation.beforeRef),
            afterRef: this.asRequiredContentRef(operation.afterRef),
            edits: this.asTextEdits(operation.edits),
          };
        }
        return {
          ...base,
          type: 'replace',
          beforeRef: this.asNullableContentRef(operation.beforeRef),
          afterRef: this.asNullableContentRef(operation.afterRef),
        };
      });
  }

  private asTextEdits(raw: unknown) {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map(value => this.asRecord(value))
      .map(edit => ({
        startLine: this.asNumber(edit.startLine) ?? 0,
        startColumn: this.asNumber(edit.startColumn) ?? 0,
        endLine: this.asNumber(edit.endLine) ?? 0,
        endColumn: this.asNumber(edit.endColumn) ?? 0,
        newText: typeof edit.newText === 'string' ? edit.newText : '',
      }));
  }

  private asNullableContentRef(raw: unknown) {
    if (raw == null) {
      return null;
    }
    return this.asRequiredContentRef(raw);
  }

  private asRequiredContentRef(raw: unknown) {
    const value = this.asRecord(raw);
    return {
      hash: this.asNonEmptyString(value.hash) ?? '',
      encoding: value.encoding === 'base64' ? 'base64' : 'utf8',
      byteLength: this.asNumber(value.byteLength) ?? 0,
    } as const;
  }

  private asStringArray(raw: unknown): string[] {
    return Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [];
  }

  private asRequestStatus(raw: unknown): TimelineRequestScope['status'] {
    return raw === 'completed' || raw === 'restored' || raw === 'discarded' ? raw : 'open';
  }

  private asContentKind(raw: unknown): 'text' | 'binary' | 'notebook' {
    return raw === 'binary' || raw === 'notebook' ? raw : 'text';
  }

  private asOperationType(raw: unknown): TimelineFileOperation['type'] {
    return raw === 'create' || raw === 'delete' || raw === 'rename' || raw === 'replace' || raw === 'text-edit'
      ? raw
      : 'replace';
  }

  private asRecord(raw: unknown): any {
    return raw && typeof raw === 'object' ? raw : {};
  }

  private asNumber(raw: unknown): number | undefined {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  }

  private asNonEmptyString(raw: unknown): string | undefined {
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  }

  private hasFs(): boolean {
    return typeof window !== 'undefined' && !!AilyHost.get().fs;
  }

  private fileExists(path: string): boolean {
    try {
      return AilyHost.get().fs.existsSync(path);
    } catch {
      return false;
    }
  }

  private ensureDir(path: string): void {
    if (!this.fileExists(path)) {
      AilyHost.get().fs.mkdirSync(path, { recursive: true });
    }
  }

  private readFileSync(path: string): string {
    return AilyHost.get().fs.readFileSync(path, 'utf-8');
  }

  private writeFileSync(path: string, content: string): void {
    AilyHost.get().fs.writeFileSync(path, content, 'utf-8');
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
