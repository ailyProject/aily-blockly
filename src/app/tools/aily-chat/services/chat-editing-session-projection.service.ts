import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

import {
  type ChatRuntimeHost,
  type ChatRuntimeHostEditingSessionContentRef,
  type ChatRuntimeHostEditingSessionEntry,
  type ChatRuntimeHostEditingSessionNavigationPlan,
  type ChatRuntimeHostEditingSessionRequestEntry,
  type ChatRuntimeHostEditingSessionRequestSummary,
  type ChatRuntimeHostEditingSessionState,
  type ChatRuntimeHostEventSubscription,
} from '../core/chat-runtime-host-contract';
import { createElectronChatRuntimeHostTransport } from '../core/electron-chat-runtime-host-transport';
import type { EditFileSummary, EditsSummary } from './edit-checkpoint.service';
import { EditingTextDiffService } from './editing-text-diff.service';

export interface ChatEditingSessionProjection {
  readonly revision: number;
  readonly state: ChatRuntimeHostEditingSessionState;
  readonly summary: EditsSummary | null;
  readonly requestSummaryByRequestId: ReadonlyMap<string, EditsSummary | null>;
  readonly requestSummaryByTurnId: ReadonlyMap<string, EditsSummary | null>;
  readonly originalTextByUri: ReadonlyMap<string, string | null>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface ChatEditingSessionProjectionChangedEvent {
  readonly sessionId: string;
  readonly revision: number;
}

export interface ChatEditingSessionTurnDiffUpdatedEvent {
  readonly sessionId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly diff: string;
}

interface ProjectionRecord {
  readonly subject: BehaviorSubject<ChatEditingSessionProjection | null>;
  appliedRevision: number;
  failedRevision: number;
  requestedRevision: number;
  loading: Promise<void> | null;
}

@Injectable({ providedIn: 'root' })
export class ChatEditingSessionProjectionService implements OnDestroy {
  private readonly host: ChatRuntimeHost | null = createElectronChatRuntimeHostTransport();
  private readonly diffService = new EditingTextDiffService();
  private readonly records = new Map<string, ProjectionRecord>();
  private readonly contentCache = new Map<string, string>();
  private readonly hostEvents: ChatRuntimeHostEventSubscription | null;
  private readonly changedSubject = new Subject<ChatEditingSessionProjectionChangedEvent>();
  private readonly turnDiffUpdatedSubject = new Subject<ChatEditingSessionTurnDiffUpdatedEvent>();
  readonly changed$ = this.changedSubject.asObservable();
  readonly turnDiffUpdated$ = this.turnDiffUpdatedSubject.asObservable();

  constructor() {
    this.hostEvents = this.host?.onEvent(event => {
      if (event.kind === 'turn-diff') {
        this.turnDiffUpdatedSubject.next({
          sessionId: event.sessionId,
          turnId: event.turnId,
          revision: event.revision,
          diff: event.diff,
        });
        return;
      }
      if (event.kind !== 'editing-session') {
        return;
      }
      const record = this.records.get(event.sessionId);
      if (!record || event.revision <= Math.max(record.appliedRevision, record.failedRevision)) {
        return;
      }
      record.requestedRevision = Math.max(record.requestedRevision, event.revision);
      this.scheduleRead(event.sessionId, record);
    }) ?? null;
  }

  ngOnDestroy(): void {
    this.hostEvents?.dispose();
    for (const record of this.records.values()) {
      record.subject.complete();
    }
    this.changedSubject.complete();
    this.turnDiffUpdatedSubject.complete();
    this.records.clear();
    this.contentCache.clear();
  }

  observe(sessionId: string): Observable<ChatEditingSessionProjection | null> {
    const normalizedSessionId = sessionId.trim();
    const record = this.getOrCreateRecord(normalizedSessionId);
    this.scheduleRead(normalizedSessionId, record);
    return record.subject.asObservable();
  }

  ensureLoaded(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    const record = this.getOrCreateRecord(normalizedSessionId);
    if (!record.subject.value) {
      this.scheduleRead(normalizedSessionId, record);
    }
  }

  refresh(sessionId: string): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    const record = this.getOrCreateRecord(normalizedSessionId);
    if (!this.host || !normalizedSessionId) {
      return Promise.resolve();
    }
    if (record.loading) {
      return record.loading;
    }
    record.loading = this.readOnce(normalizedSessionId, record)
      .catch(error => {
        console.warn('[AilyChat][EditingSessionProjection] Failed to refresh editing session:', error);
      })
      .finally(() => {
        record.loading = null;
        if (record.requestedRevision > Math.max(record.appliedRevision, record.failedRevision)) {
          this.scheduleRead(normalizedSessionId, record);
        }
      });
    return record.loading;
  }

  getOriginalText(sessionId: string, uri: string): string | null | undefined {
    return this.records.get(sessionId.trim())?.subject.value?.originalTextByUri.get(uri);
  }

  getCurrent(sessionId: string): ChatEditingSessionProjection | null {
    return this.records.get(sessionId.trim())?.subject.value ?? null;
  }

  getSummary(sessionId: string): EditsSummary | null | undefined {
    return this.records.get(sessionId.trim())?.subject.value?.summary;
  }

  getRequestSummary(
    sessionId: string,
    requestOrTurnId: string,
  ): EditsSummary | null | undefined {
    const projection = this.records.get(sessionId.trim())?.subject.value;
    const normalizedId = requestOrTurnId.trim();
    if (!projection || !normalizedId) {
      return undefined;
    }
    if (projection.requestSummaryByRequestId.has(normalizedId)) {
      return projection.requestSummaryByRequestId.get(normalizedId);
    }
    return projection.requestSummaryByTurnId.get(normalizedId);
  }

  buildNavigationPlan(
    sessionId: string,
    checkpointId: string,
    direction: 'restore' | 'redo',
  ): Promise<ChatRuntimeHostEditingSessionNavigationPlan> {
    const normalizedSessionId = sessionId.trim();
    const normalizedCheckpointId = checkpointId.trim();
    if (!this.host || !normalizedSessionId || !normalizedCheckpointId) {
      return Promise.reject(new Error('Editing-session navigation requires the execution host and checkpoint identity.'));
    }
    return this.host.buildEditingSessionNavigationPlan({
      sessionId: normalizedSessionId,
      checkpointId: normalizedCheckpointId,
      direction,
    });
  }

  private getOrCreateRecord(sessionId: string): ProjectionRecord {
    let record = this.records.get(sessionId);
    if (!record) {
      record = {
        subject: new BehaviorSubject<ChatEditingSessionProjection | null>(null),
        appliedRevision: -1,
        failedRevision: -1,
        requestedRevision: 0,
        loading: null,
      };
      this.records.set(sessionId, record);
    }
    return record;
  }

  private scheduleRead(sessionId: string, record: ProjectionRecord): void {
    if (
      !sessionId
      || !this.host
      || record.loading
      || record.requestedRevision <= Math.max(record.appliedRevision, record.failedRevision)
    ) {
      return;
    }
    record.loading = this.readUntilCurrent(sessionId, record)
      .catch(error => {
        // Mark the requested revision as failed so a hard host error cannot tight-loop IPC.
        // Later editing-session events with a higher revision will still schedule a fresh read.
        record.failedRevision = Math.max(record.failedRevision, record.requestedRevision);
        console.warn('[AilyChat][EditingSessionProjection] Failed to read editing session:', error);
      })
      .finally(() => {
        record.loading = null;
        if (record.requestedRevision > Math.max(record.appliedRevision, record.failedRevision)) {
          this.scheduleRead(sessionId, record);
        }
      });
  }

  private async readUntilCurrent(sessionId: string, record: ProjectionRecord): Promise<void> {
    while (
      this.host
      && record.requestedRevision > Math.max(record.appliedRevision, record.failedRevision)
    ) {
      const requestedRevision = record.requestedRevision;
      const state = await this.host.readEditingSessionState(sessionId);
      if (state.revision <= record.appliedRevision) {
        return;
      }
      let projection: ChatEditingSessionProjection;
      try {
        projection = await this.buildProjection(sessionId, state);
      } catch (error) {
        record.failedRevision = Math.max(record.failedRevision, state.revision);
        throw error;
      }
      if (projection.revision <= record.appliedRevision) {
        return;
      }
      record.appliedRevision = projection.revision;
      if (record.failedRevision <= projection.revision) {
        record.failedRevision = -1;
      }
      record.subject.next(projection);
      this.changedSubject.next({ sessionId, revision: projection.revision });
      if (record.requestedRevision <= projection.revision && requestedRevision <= projection.revision) {
        return;
      }
    }
  }

  private async readOnce(sessionId: string, record: ProjectionRecord): Promise<void> {
    if (!this.host) {
      return;
    }
    const state = await this.host.readEditingSessionState(sessionId);
    if (state.revision <= record.appliedRevision) {
      return;
    }
    let projection: ChatEditingSessionProjection;
    try {
      projection = await this.buildProjection(sessionId, state);
    } catch (error) {
      record.failedRevision = Math.max(record.failedRevision, state.revision);
      throw error;
    }
    if (projection.revision <= record.appliedRevision) {
      return;
    }
    record.requestedRevision = Math.max(record.requestedRevision, projection.revision);
    record.appliedRevision = projection.revision;
    if (record.failedRevision <= projection.revision) {
      record.failedRevision = -1;
    }
    record.subject.next(projection);
    this.changedSubject.next({ sessionId, revision: projection.revision });
  }

  private async buildProjection(
    sessionId: string,
    state: ChatRuntimeHostEditingSessionState,
  ): Promise<ChatEditingSessionProjection> {
    const projectedSessionId = typeof state.sessionId === 'string' ? state.sessionId.trim() : '';
    if (projectedSessionId && projectedSessionId !== sessionId) {
      throw new Error(
        `[AilyChat][EditingSessionProjection] Session identity mismatch: requested "${sessionId}", received "${projectedSessionId}".`,
      );
    }
    const changedEntries = state.entries.filter(isChangedEntry);
    const files = await Promise.all(changedEntries.map(entry => this.buildFileSummary(sessionId, state, entry)));
    const visibleFiles = files.filter((file): file is EditFileSummary => file !== null);
    const originalTextByUri = new Map<string, string | null>();

    for (const entry of changedEntries) {
      if (entry.contentKind !== 'text') {
        continue;
      }
      originalTextByUri.set(
        entry.uri,
        entry.originalRef ? await this.readText(sessionId, entry.originalRef) : null,
      );
    }

    const totalAdded = visibleFiles.reduce((sum, file) => sum + file.added, 0);
    const totalRemoved = visibleFiles.reduce((sum, file) => sum + file.removed, 0);
    const checkpointId = state.currentPointer.checkpointId
      || state.checkpoints.at(-1)?.checkpointId
      || 'current';
    const requestSummaries = await Promise.all(
      state.requestSummaries.map(request => this.buildRequestSummary(sessionId, state, request)),
    );
    const requestSummaryByRequestId = new Map<string, EditsSummary | null>();
    const requestSummaryByTurnId = new Map<string, EditsSummary | null>();
    for (const { request, summary } of requestSummaries) {
      requestSummaryByRequestId.set(request.requestId, summary);
      if (request.turnId) {
        requestSummaryByTurnId.set(request.turnId, summary);
      }
    }

    return {
      revision: state.revision,
      state,
      summary: visibleFiles.length > 0
        ? {
            checkpointId,
            turnContext: null,
            fileCount: visibleFiles.length,
            totalAdded,
            totalRemoved,
            files: visibleFiles,
          }
        : null,
      requestSummaryByRequestId,
      requestSummaryByTurnId,
      originalTextByUri,
      canUndo: state.currentPointer.epoch > 0,
      canRedo: state.currentPointer.epoch < state.epochCounter,
    };
  }

  private async buildRequestSummary(
    sessionId: string,
    state: ChatRuntimeHostEditingSessionState,
    request: ChatRuntimeHostEditingSessionRequestSummary,
  ): Promise<{
    readonly request: ChatRuntimeHostEditingSessionRequestSummary;
    readonly summary: EditsSummary | null;
  }> {
    const files = await Promise.all(
      request.entries.map(entry => this.buildRequestFileSummary(sessionId, state, entry)),
    );
    const visibleFiles = files.filter((file): file is EditFileSummary => file !== null);
    if (visibleFiles.length === 0) {
      return { request, summary: null };
    }
    return {
      request,
      summary: {
        checkpointId: request.checkpointIds.at(-1) || request.requestId,
        turnContext: null,
        fileCount: visibleFiles.length,
        totalAdded: visibleFiles.reduce((sum, file) => sum + file.added, 0),
        totalRemoved: visibleFiles.reduce((sum, file) => sum + file.removed, 0),
        files: visibleFiles,
      },
    };
  }

  private async buildFileSummary(
    sessionId: string,
    state: ChatRuntimeHostEditingSessionState,
    entry: ChatRuntimeHostEditingSessionEntry,
  ): Promise<EditFileSummary | null> {
    return this.buildFileSummaryFromRefs(
      sessionId,
      state,
      entry,
      entry.existedAtBaseline,
    );
  }

  private async buildRequestFileSummary(
    sessionId: string,
    state: ChatRuntimeHostEditingSessionState,
    entry: ChatRuntimeHostEditingSessionRequestEntry,
  ): Promise<EditFileSummary | null> {
    return this.buildFileSummaryFromRefs(
      sessionId,
      state,
      entry,
      entry.existedAtStart,
    );
  }

  private async buildFileSummaryFromRefs(
    sessionId: string,
    state: ChatRuntimeHostEditingSessionState,
    entry: Pick<
      ChatRuntimeHostEditingSessionEntry,
      'uri' | 'contentKind' | 'originalRef' | 'currentRef' | 'deleted'
    >,
    existedAtStart: boolean,
  ): Promise<EditFileSummary | null> {
    let added = 0;
    let removed = 0;
    if (entry.contentKind === 'text') {
      const before = entry.originalRef ? await this.readText(sessionId, entry.originalRef) : null;
      const after = entry.currentRef ? await this.readText(sessionId, entry.currentRef) : null;
      ({ added, removed } = await this.computeLineCounts(before, after));
    }

    return {
      path: toWorkspaceRelativePath(state.workspaceRoot, entry.uri),
      fullPath: entry.uri,
      type: entry.deleted ? 'delete' : existedAtStart ? 'modify' : 'create',
      contentKind: entry.contentKind,
      added,
      removed,
    };
  }

  private async readText(
    sessionId: string,
    ref: ChatRuntimeHostEditingSessionContentRef,
  ): Promise<string> {
    if (!sessionId || !isContentRef(ref)) {
      throw new Error(
        '[AilyChat][EditingSessionProjection] Canonical editing-session content requires a session id and valid content reference.',
      );
    }
    const key = `${ref.hash}:${ref.encoding}:${ref.byteLength}`;
    const cached = this.contentCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (!this.host) {
      return '';
    }
    const content = await this.host.readEditingSessionContent({ sessionId, contentRef: ref });
    const text = decodeBase64Utf8(content.dataBase64);
    this.contentCache.set(key, text);
    return text;
  }

  private async computeLineCounts(
    before: string | null,
    after: string | null,
  ): Promise<{ added: number; removed: number }> {
    const original = before ?? '';
    const modified = after ?? '';
    const diff = await this.diffService.computeDiff(original, modified, {
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
}

function isChangedEntry(entry: ChatRuntimeHostEditingSessionEntry): boolean {
  return entry.state === 'modified'
    && (entry.deleted !== !entry.existedAtBaseline
      || !sameContentRef(entry.originalRef, entry.currentRef));
}

function sameContentRef(
  left: ChatRuntimeHostEditingSessionContentRef | null,
  right: ChatRuntimeHostEditingSessionContentRef | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.hash === right.hash
    && left.encoding === right.encoding
    && left.byteLength === right.byteLength;
}

function isContentRef(value: unknown): value is ChatRuntimeHostEditingSessionContentRef {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const ref = value as Partial<ChatRuntimeHostEditingSessionContentRef>;
  return typeof ref.hash === 'string'
    && ref.hash.length > 0
    && (ref.encoding === 'utf8' || ref.encoding === 'base64')
    && typeof ref.byteLength === 'number'
    && Number.isFinite(ref.byteLength)
    && ref.byteLength >= 0;
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function toWorkspaceRelativePath(workspaceRoot: string, uri: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedUri = uri.replace(/\\/g, '/');
  const rootPrefix = `${normalizedRoot}/`;
  if (normalizedRoot && normalizedUri.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    return normalizedUri.slice(rootPrefix.length);
  }
  const segments = normalizedUri.split('/');
  return segments.at(-1) || normalizedUri;
}
