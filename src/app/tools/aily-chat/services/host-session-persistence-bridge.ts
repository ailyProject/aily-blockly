import { HostSessionRecordStore } from './host-session-record-store';
import { normalizePersistedChatSessionTitleSource, type PersistedChatSessionTitleSource } from '../core/chat-session-title';
import {
  buildSessionTurnOwnerDiagnostics,
  hasBlockingSessionTurnOwnerMismatch,
} from '../helpers/session-turn-owner-diagnostics';

import type {
  HostSessionRecord,
  LiveHostSessionRecord,
  SessionIndexEntry,
  SessionMetadata,
  SessionTitleUpdateOptions,
} from './chat-history.service';
import { countHostRecordMessages } from './chat-history.service';
import { ChatPerformanceTracer } from './chat-perf-tracer';

type LiveSessionProvider = (sessionId: string) => LiveHostSessionRecord | null;
type PendingTitleUpdate = { title: string; source: PersistedChatSessionTitleSource };
type DurablePersistedTitleCandidate = { title: string; source?: PersistedChatSessionTitleSource };
export type HostSessionDirtyPolicy = 'recovery-snapshot' | 'authoritative';

export interface HostSessionDirtyOptions {
  readonly policy?: HostSessionDirtyPolicy;
}

export interface HostSessionFlushOptions {
  readonly shouldSkipSession?: (sessionId: string, policy: HostSessionDirtyPolicy) => boolean;
}

interface HostSessionDirtyState {
  readonly policy: HostSessionDirtyPolicy;
  readonly revision: number;
}

function resolveDurablePersistedTitleCandidate(
  title: unknown,
  source: unknown,
  defaultTitle?: unknown,
): DurablePersistedTitleCandidate | null {
  const normalizedTitle = typeof title === 'string' ? title.trim() : '';
  if (!normalizedTitle) {
    return null;
  }

  const normalizedSource = normalizePersistedChatSessionTitleSource(source);
  if (normalizedSource) {
    return {
      title: normalizedTitle,
      source: normalizedSource,
    };
  }

  const normalizedDefaultTitle = typeof defaultTitle === 'string' ? defaultTitle.trim() : '';
  return !normalizedDefaultTitle || normalizedTitle !== normalizedDefaultTitle
    ? { title: normalizedTitle }
    : null;
}

export interface HostSessionPersistenceBridgeOptions {
  ensureIndexLoaded: () => void;
  findIndexEntry: (sessionId: string) => SessionIndexEntry | undefined;
  upsertIndexEntry: (
    sessionId: string,
    metadata: SessionMetadata,
    messageCount: number,
    updateTimestamp?: boolean,
    options?: { readonly dataAvailable?: boolean },
  ) => void;
  writeIndex: () => void;
  writeIndexAsync?: () => Promise<void>;
  markIndexDirty: () => void;
  hasDirtyIndex: () => boolean;
  isSamePath: (a: string | null | undefined, b: string | null | undefined) => boolean;
}

/**
 * Host-side session persistence coordinator.
 *
 * Keeps cache/dirty tracking/title persistence/flush behavior out of ChatHistoryService.
 */
export class HostSessionPersistenceBridge {
  private readonly dirtySessions = new Map<string, HostSessionDirtyState>();
  private readonly sessionCache = new Map<string, HostSessionRecord>();
  private readonly pendingTitles = new Map<string, PendingTitleUpdate>();
  private liveSessionProvider: LiveSessionProvider | null = null;
  private nextDirtyRevision = 1;
  private storeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly hostRecordStore: HostSessionRecordStore,
    private readonly options: HostSessionPersistenceBridgeOptions,
  ) {}

  setLiveSessionProvider(provider: LiveSessionProvider | null): void {
    this.liveSessionProvider = provider;
  }

  saveHostRecord(
    record: LiveHostSessionRecord,
  ): void {
    ChatPerformanceTracer.runWithSurface('history_save', () => {
      this.saveHostRecordCore(record);
    }, 'full');
  }

  async saveHostRecordAsync(
    record: LiveHostSessionRecord,
    options?: { readonly allowEmptyTranscript?: boolean },
  ): Promise<void> {
    await this.enqueueStore(async () => {
      const { sessionId } = record;
      if (!sessionId) {
        return;
      }
      const dirtyRevision = this.dirtySessions.get(sessionId)?.revision;
      this.options.ensureIndexLoaded();
      if (this.shouldRejectRecordOwnerMismatch(record, 'saveHostRecordAsync')) {
        return;
      }

      const hostRecord = this.materializeHostRecord(record);
      const messageCount = countHostRecordMessages(hostRecord);
      if (messageCount === 0) {
        if (options?.allowEmptyTranscript === true) {
          this.sessionCache.set(sessionId, hostRecord);
          await this.hostRecordStore.writeOrThrowAsync(sessionId, hostRecord);
          this.clearDirtyRevision(sessionId, dirtyRevision);
        }
        return;
      }
      this.sessionCache.set(sessionId, hostRecord);
      const existingEntry = this.options.findIndexEntry(sessionId);
      const messageCountChanged = !existingEntry || existingEntry.messageCount !== messageCount;
      this.options.upsertIndexEntry(sessionId, hostRecord.metadata, messageCount, messageCountChanged);
      await this.hostRecordStore.writeOrThrowAsync(sessionId, hostRecord);
      await this.writeIndexAsync();
      this.clearDirtyRevision(sessionId, dirtyRevision);
    });
  }

  private saveHostRecordCore(
    record: LiveHostSessionRecord,
  ): void {
    const { sessionId } = record;
    if (!sessionId) {
      return;
    }

    this.options.ensureIndexLoaded();

    if (this.shouldRejectRecordOwnerMismatch(record, 'saveHostRecord')) {
      return;
    }

    const hostRecord = this.materializeHostRecord(record);
    const messageCount = countHostRecordMessages(hostRecord);
    if (messageCount === 0) {
      return;
    }

    this.sessionCache.set(sessionId, hostRecord);

    const existingEntry = this.options.findIndexEntry(sessionId);
    const messageCountChanged = !existingEntry || existingEntry.messageCount !== messageCount;
    this.options.upsertIndexEntry(sessionId, hostRecord.metadata, messageCount, messageCountChanged);

    this.hostRecordStore.write(sessionId, hostRecord);
    this.options.writeIndex();
    this.dirtySessions.delete(sessionId);
  }

  saveHostRecordMetadataOnly(
    record: LiveHostSessionRecord,
  ): void {
    ChatPerformanceTracer.runWithSurface('history_save', () => {
      this.saveHostRecordMetadataOnlyCore(record);
    }, 'metadata-only');
  }

  async saveHostRecordMetadataOnlyAsync(record: LiveHostSessionRecord): Promise<void> {
    await this.enqueueStore(async () => {
      const { sessionId } = record;
      if (!sessionId || record.sessionId !== sessionId) {
        return;
      }
      this.options.ensureIndexLoaded();
      const metadata = this.retainDurableTitle(
        this.applyPendingTitle(this.hostRecordStore.createFullMetadata(record.metadata)),
      );
      const existingEntry = this.options.findIndexEntry(sessionId);
      const messageCount = existingEntry?.messageCount ?? countHostRecordMessages(record);
      const dataAvailable = existingEntry?.dataAvailable ?? messageCount > 0;
      this.options.upsertIndexEntry(sessionId, metadata, messageCount, true, { dataAvailable });
      await this.writeIndexAsync();
    });
  }

  private saveHostRecordMetadataOnlyCore(
    record: LiveHostSessionRecord,
  ): void {
    const { sessionId } = record;
    if (!sessionId || record.sessionId !== sessionId) {
      return;
    }

    this.options.ensureIndexLoaded();

    const metadata = this.retainDurableTitle(
      this.applyPendingTitle(this.hostRecordStore.createFullMetadata(record.metadata)),
    );
    const existingEntry = this.options.findIndexEntry(sessionId);
    const messageCount = existingEntry?.messageCount ?? countHostRecordMessages(record);
    const dataAvailable = existingEntry?.dataAvailable ?? messageCount > 0;

    this.options.upsertIndexEntry(sessionId, metadata, messageCount, true, { dataAvailable });
    this.options.writeIndex();
  }

  updateTitle(sessionId: string, title: string, options?: SessionTitleUpdateOptions): void {
    this.options.ensureIndexLoaded();
    const entry = this.options.findIndexEntry(sessionId);
    const now = Date.now();
    const nextTitle = typeof title === 'string' ? title.trim() : '';
    if (!nextTitle) {
      return;
    }
    const nextSource = normalizePersistedChatSessionTitleSource(options?.source) ?? 'legacy-custom';

    if (entry) {
      entry.title = nextTitle;
      entry.titleSource = nextSource;
      entry.updatedAt = now;
      this.options.markIndexDirty();

      const cached = this.sessionCache.get(sessionId);
      if (cached) {
        cached.metadata.title = nextTitle;
        cached.metadata.titleSource = nextSource;
        cached.metadata.updatedAt = now;
        this.hostRecordStore.write(sessionId, cached);
      } else {
        const persisted = this.hostRecordStore.read(sessionId, entry.projectPath ?? null);
        if (persisted) {
          persisted.metadata.title = nextTitle;
          persisted.metadata.titleSource = nextSource;
          persisted.metadata.updatedAt = now;
          this.sessionCache.set(sessionId, persisted);
          this.hostRecordStore.write(sessionId, persisted);
        } else {
          this.pendingTitles.set(sessionId, { title: nextTitle, source: nextSource });
        }
      }

      this.options.writeIndex();
      console.log(`[ChatHistory] 标题已更新: ${sessionId} → "${nextTitle}"`);
      return;
    }

    const fallbackRecord = this.tryLoadLiveHostRecord(sessionId)
      ?? this.sessionCache.get(sessionId)
      ?? null;
    if (fallbackRecord) {
      const nextRecord: HostSessionRecord = {
        ...fallbackRecord,
        metadata: {
          ...fallbackRecord.metadata,
          title: nextTitle,
          titleSource: nextSource,
          updatedAt: now,
        },
      };
      const messageCount = countHostRecordMessages(nextRecord);
      if (messageCount === 0) {
        this.pendingTitles.set(sessionId, { title: nextTitle, source: nextSource });
        console.log(`[ChatHistory] 标题已暂存(等待首轮消息): ${sessionId} → "${nextTitle}"`);
        return;
      }

      this.sessionCache.set(sessionId, nextRecord);
      this.hostRecordStore.write(sessionId, nextRecord);

      this.options.upsertIndexEntry(sessionId, nextRecord.metadata, messageCount, true);
      this.options.writeIndex();
      console.log(`[ChatHistory] 标题已更新(补建条目): ${sessionId} → "${nextTitle}"`);
      return;
    }

    this.pendingTitles.set(sessionId, { title: nextTitle, source: nextSource });
    console.log(`[ChatHistory] 标题已暂存(等待会话持久化): ${sessionId} → "${nextTitle}"`);
    return;

  }

  markDirty(sessionId: string, options?: HostSessionDirtyOptions): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return;
    }

    const previousState = this.dirtySessions.get(normalizedSessionId);
    const nextPolicy = options?.policy ?? 'recovery-snapshot';
    this.dirtySessions.set(
      normalizedSessionId,
      {
        policy: previousState?.policy === 'authoritative' ? 'authoritative' : nextPolicy,
        revision: this.nextDirtyRevision++,
      },
    );
  }

  async updateTitleAsync(sessionId: string, title: string, options?: SessionTitleUpdateOptions): Promise<void> {
    await this.enqueueStore(() => this.updateTitleAsyncCore(sessionId, title, options));
  }

  private async updateTitleAsyncCore(sessionId: string, title: string, options?: SessionTitleUpdateOptions): Promise<void> {
    this.options.ensureIndexLoaded();
    const now = Date.now();
    const nextTitle = typeof title === 'string' ? title.trim() : '';
    if (!nextTitle) {
      return;
    }
    const nextSource = normalizePersistedChatSessionTitleSource(options?.source) ?? 'legacy-custom';
    const entry = this.options.findIndexEntry(sessionId);
    if (entry) {
      entry.title = nextTitle;
      entry.titleSource = nextSource;
      entry.updatedAt = now;
      this.options.markIndexDirty();

      const cached = this.sessionCache.get(sessionId);
      if (cached) {
        cached.metadata.title = nextTitle;
        cached.metadata.titleSource = nextSource;
        cached.metadata.updatedAt = now;
        await this.hostRecordStore.writeAsync(sessionId, cached);
      } else {
        this.pendingTitles.set(sessionId, { title: nextTitle, source: nextSource });
      }
      await this.writeIndexAsync();
      return;
    }

    const fallbackRecord = this.tryLoadLiveHostRecord(sessionId) ?? null;
    if (!fallbackRecord || countHostRecordMessages(fallbackRecord) === 0) {
      this.pendingTitles.set(sessionId, { title: nextTitle, source: nextSource });
      return;
    }
    const nextRecord: HostSessionRecord = {
      ...fallbackRecord,
      metadata: {
        ...fallbackRecord.metadata,
        title: nextTitle,
        titleSource: nextSource,
        updatedAt: now,
      },
    };
    const messageCount = countHostRecordMessages(nextRecord);
    this.sessionCache.set(sessionId, nextRecord);
    this.options.upsertIndexEntry(sessionId, nextRecord.metadata, messageCount, true);
    await this.hostRecordStore.writeAsync(sessionId, nextRecord);
    await this.writeIndexAsync();
  }

  private async writeIndexAsync(): Promise<void> {
    if (this.options.writeIndexAsync) {
      await this.options.writeIndexAsync();
      return;
    }
    this.options.writeIndex();
  }

  loadHostRecord(sessionId: string, projectPathHint?: string | null): HostSessionRecord | null {
    try {
      const cached = this.sessionCache.get(sessionId);
      if (cached) {
        return cached;
      }

      this.options.ensureIndexLoaded();
      const entry = this.options.findIndexEntry(sessionId);
      const primaryPath = entry?.projectPath || null;

      const data = this.hostRecordStore.read(sessionId, primaryPath);
      if (data) {
        if (this.shouldRejectRecordOwnerMismatch(data, 'loadHostRecord-primary')) {
          return null;
        }
        const hydrated = this.applyPendingTitleToRecord(data);
        if (hydrated !== data) {
          this.hostRecordStore.write(sessionId, hydrated);
        }
        this.syncIndexEntryFromRecord(sessionId, hydrated);
        this.sessionCache.set(sessionId, hydrated);
        return hydrated;
      }

      if (projectPathHint && !this.options.isSamePath(projectPathHint, primaryPath)) {
        const fallbackData = this.hostRecordStore.read(sessionId, projectPathHint);
        if (fallbackData) {
          if (this.shouldRejectRecordOwnerMismatch(fallbackData, 'loadHostRecord-fallback')) {
            return null;
          }
          const hydrated = this.applyPendingTitleToRecord(fallbackData);
          if (hydrated !== fallbackData) {
            this.hostRecordStore.write(sessionId, hydrated);
          }
          this.syncIndexEntryFromRecord(sessionId, hydrated);
          this.sessionCache.set(sessionId, hydrated);
          return hydrated;
        }
      }

      return null;
    } catch (error) {
      console.warn('[ChatHistory] 读取 session record 失败:', error);
      return null;
    }
  }

  flushAll(options?: HostSessionFlushOptions): void {
    ChatPerformanceTracer.runWithSurface('history_save', () => {
      this.flushAllCore(options);
    }, 'flush-all');
  }

  flushSession(sessionId: string, options?: HostSessionFlushOptions): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return;
    }

    ChatPerformanceTracer.runWithSurface('history_save', () => {
      this.flushSessionCore(normalizedSessionId, options);
    }, 'flush-session');
  }

  async flushAllAsync(options?: HostSessionFlushOptions): Promise<void> {
    await this.enqueueStore(async () => {
      const capturedStates = [...this.dirtySessions.entries()];
      const committed: Array<readonly [string, number]> = [];
      const writes: Promise<void>[] = [];

      for (const [sessionId, state] of capturedStates) {
        if (options?.shouldSkipSession?.(sessionId, state.policy)) {
          continue;
        }
        const hostRecord = this.resolveFlushHostRecord(sessionId, 'flushAllAsync');
        if (hostRecord && this.shouldRejectRecordOwnerMismatch(hostRecord, 'flushAllAsync-cache')) {
          continue;
        }
        if (hostRecord) {
          const messageCount = countHostRecordMessages(hostRecord);
          if (messageCount > 0) {
            writes.push(this.hostRecordStore.writeOrThrowAsync(sessionId, hostRecord));
            if (state.policy === 'authoritative') {
              this.options.upsertIndexEntry(sessionId, hostRecord.metadata, messageCount);
            }
          }
        }
        committed.push([sessionId, state.revision]);
      }

      await Promise.all(writes);
      if (this.options.hasDirtyIndex()) {
        await this.writeIndexAsync();
      }
      for (const [sessionId, revision] of committed) {
        this.clearDirtyRevision(sessionId, revision);
      }
    });
  }

  async flushSessionAsync(sessionId: string, options?: HostSessionFlushOptions): Promise<void> {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return;
    }

    await this.enqueueStore(async () => {
      const state = this.dirtySessions.get(normalizedSessionId);
      if (!state) {
        if (this.options.hasDirtyIndex()) {
          await this.writeIndexAsync();
        }
        return;
      }
      if (options?.shouldSkipSession?.(normalizedSessionId, state.policy)) {
        return;
      }

      const hostRecord = this.resolveFlushHostRecord(normalizedSessionId, 'flushSessionAsync');
      if (hostRecord && this.shouldRejectRecordOwnerMismatch(hostRecord, 'flushSessionAsync-cache')) {
        return;
      }
      if (hostRecord) {
        const messageCount = countHostRecordMessages(hostRecord);
        if (messageCount > 0) {
          await this.hostRecordStore.writeOrThrowAsync(normalizedSessionId, hostRecord);
          if (state.policy === 'authoritative') {
            this.options.upsertIndexEntry(normalizedSessionId, hostRecord.metadata, messageCount);
          }
        }
      }
      if (this.options.hasDirtyIndex()) {
        await this.writeIndexAsync();
      }
      this.clearDirtyRevision(normalizedSessionId, state.revision);
    });
  }

  private flushAllCore(options?: HostSessionFlushOptions): void {
    const committed: Array<readonly [string, number]> = [];
    for (const [sessionId, state] of this.dirtySessions) {
      if (options?.shouldSkipSession?.(sessionId, state.policy)) {
        continue;
      }

      let hostRecord = this.sessionCache.get(sessionId);
      let liveRecord: LiveHostSessionRecord | null = null;
      if (this.liveSessionProvider) {
        try {
          liveRecord = this.liveSessionProvider(sessionId);
        } catch (error) {
          console.warn('[ChatHistory] 获取 live session 失败:', error);
        }
      }

      if (liveRecord
        && liveRecord.sessionId === sessionId
        && countHostRecordMessages(liveRecord) > 0
        && !this.shouldRejectRecordOwnerMismatch(liveRecord, 'flushAll-live')) {
        hostRecord = this.materializeHostRecord(liveRecord);
        this.sessionCache.set(sessionId, hostRecord);
      }

      if (hostRecord) {
        if (this.shouldRejectRecordOwnerMismatch(hostRecord, 'flushAll-cache')) {
          continue;
        }
        const messageCount = countHostRecordMessages(hostRecord);
        if (messageCount === 0) {
          continue;
        }
        this.hostRecordStore.write(sessionId, hostRecord);
        if (state.policy === 'authoritative') {
          this.options.upsertIndexEntry(sessionId, hostRecord.metadata, messageCount);
        }
      }
      committed.push([sessionId, state.revision]);
    }
    for (const [sessionId, revision] of committed) {
      this.clearDirtyRevision(sessionId, revision);
    }

    if (this.options.hasDirtyIndex()) {
      this.options.writeIndex();
    }
  }

  private flushSessionCore(sessionId: string, options?: HostSessionFlushOptions): void {
    const state = this.dirtySessions.get(sessionId);
    if (!state) {
      if (this.options.hasDirtyIndex()) {
        this.options.writeIndex();
      }
      return;
    }

    if (options?.shouldSkipSession?.(sessionId, state.policy)) {
      return;
    }

    let hostRecord = this.sessionCache.get(sessionId);
    let liveRecord: LiveHostSessionRecord | null = null;
    if (this.liveSessionProvider) {
      try {
        liveRecord = this.liveSessionProvider(sessionId);
      } catch (error) {
        console.warn('[ChatHistory] Failed to read live session:', error);
      }
    }

    if (liveRecord
      && liveRecord.sessionId === sessionId
      && countHostRecordMessages(liveRecord) > 0
      && !this.shouldRejectRecordOwnerMismatch(liveRecord, 'flushSession-live')) {
      hostRecord = this.materializeHostRecord(liveRecord);
      this.sessionCache.set(sessionId, hostRecord);
    }

    if (hostRecord
      && !this.shouldRejectRecordOwnerMismatch(hostRecord, 'flushSession-cache')) {
      const messageCount = countHostRecordMessages(hostRecord);
      if (messageCount > 0) {
        this.hostRecordStore.write(sessionId, hostRecord);
        if (state.policy === 'authoritative') {
          this.options.upsertIndexEntry(sessionId, hostRecord.metadata, messageCount);
        }
      }
    }

    this.clearDirtyRevision(sessionId, state.revision);
    if (this.options.hasDirtyIndex()) {
      this.options.writeIndex();
    }
  }

  private resolveFlushHostRecord(sessionId: string, phase: string): HostSessionRecord | null {
    let hostRecord = this.sessionCache.get(sessionId) ?? null;
    if (!this.liveSessionProvider) {
      return hostRecord;
    }

    try {
      const liveRecord = this.liveSessionProvider(sessionId);
      if (liveRecord
        && liveRecord.sessionId === sessionId
        && countHostRecordMessages(liveRecord) > 0
        && !this.shouldRejectRecordOwnerMismatch(liveRecord, `${phase}-live`)) {
        hostRecord = this.materializeHostRecord(liveRecord);
        this.sessionCache.set(sessionId, hostRecord);
      }
    } catch (error) {
      console.warn(`[ChatHistory] Failed to read live session during ${phase}:`, error);
    }
    return hostRecord;
  }

  private clearDirtyRevision(sessionId: string, revision: number | undefined): void {
    if (revision == null) {
      return;
    }
    if (this.dirtySessions.get(sessionId)?.revision === revision) {
      this.dirtySessions.delete(sessionId);
    }
  }

  private enqueueStore<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.storeQueue.then(operation, operation);
    this.storeQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  hasDirtySessions(): boolean {
    return this.dirtySessions.size > 0;
  }

  getDirtySessionCount(): number {
    return this.dirtySessions.size;
  }

  getSessionCache(): Map<string, HostSessionRecord> {
    return this.sessionCache;
  }

  clearSessionState(sessionId: string): void {
    this.sessionCache.delete(sessionId);
    this.dirtySessions.delete(sessionId);
    this.pendingTitles.delete(sessionId);
  }

  private materializeHostRecord(record: LiveHostSessionRecord): HostSessionRecord {
    const fullMetadata = this.retainDurableTitle(
      this.applyPendingTitle(this.hostRecordStore.createFullMetadata(record.metadata)),
    );
    return this.hostRecordStore.createRecord(fullMetadata, record.turnResponses, record.sidecar, record.auxiliary);
  }

  private retainDurableTitle(metadata: SessionMetadata): SessionMetadata {
    const incomingTitle = resolveDurablePersistedTitleCandidate(
      metadata.title,
      metadata.titleSource,
      metadata.defaultTitle,
    );
    if (incomingTitle) {
      return {
        ...metadata,
        title: incomingTitle.title,
        titleSource: incomingTitle.source,
      };
    }

    const preservedTitle = this.readPersistedDurableTitle(metadata.sessionId);
    if (preservedTitle) {
      return {
        ...metadata,
        title: preservedTitle.title,
        titleSource: preservedTitle.source,
      };
    }

    if (!metadata.title && !metadata.titleSource) {
      return metadata;
    }

    return {
      ...metadata,
      title: '',
      titleSource: undefined,
    };
  }

  private readPersistedDurableTitle(sessionId: string): DurablePersistedTitleCandidate | null {
    const cached = this.sessionCache.get(sessionId);
    const cachedTitle = resolveDurablePersistedTitleCandidate(
      cached?.metadata.title,
      cached?.metadata.titleSource,
      cached?.metadata.defaultTitle,
    );
    if (cachedTitle) {
      return cachedTitle;
    }

    const entry = this.options.findIndexEntry(sessionId);
    return resolveDurablePersistedTitleCandidate(entry?.title, entry?.titleSource, entry?.defaultTitle);
  }

  private tryLoadLiveHostRecord(sessionId: string): HostSessionRecord | null {
    if (!this.liveSessionProvider) {
      return null;
    }

    try {
      const liveRecord = this.liveSessionProvider(sessionId);
      if (!liveRecord || liveRecord.sessionId !== sessionId) {
        return null;
      }

      if (this.shouldRejectRecordOwnerMismatch(liveRecord, 'tryLoadLiveHostRecord')) {
        return null;
      }

      return this.materializeHostRecord(liveRecord);
    } catch (error) {
      console.warn('[ChatHistory] 读取 live session 失败:', error);
      return null;
    }
  }

  private shouldRejectRecordOwnerMismatch(
    record: Pick<LiveHostSessionRecord, 'turnResponses' | 'metadata'> & { readonly sessionId?: string },
    phase: string,
  ): boolean {
    const sessionId = typeof record.sessionId === 'string' && record.sessionId.trim().length > 0
      ? record.sessionId.trim()
      : typeof record.metadata?.sessionId === 'string'
        ? record.metadata.sessionId.trim()
        : '';
    const diagnostics = buildSessionTurnOwnerDiagnostics(sessionId, record.turnResponses as any);
    if (diagnostics.mismatchCount === 0) {
      return false;
    }

    const allowForkedTurns = !!record.metadata?.forkedFromSessionId || !!record.metadata?.forkKind;
    console.warn('[ChatHistory][owner-mismatch]', {
      phase,
      sessionId,
      recordSessionId: record.sessionId,
      metadataSessionId: record.metadata?.sessionId ?? null,
      mismatchCount: diagnostics.mismatchCount,
      mismatchedOwners: diagnostics.mismatchedOwners,
      mismatchedTurnIds: diagnostics.mismatchedTurnIds.slice(0, 5),
      firstTurnId: diagnostics.firstTurnId,
      firstRequestPreview: diagnostics.firstRequestPreview,
      forkKind: record.metadata?.forkKind ?? null,
      forkedFromSessionId: record.metadata?.forkedFromSessionId ?? null,
    });

    if (!hasBlockingSessionTurnOwnerMismatch(diagnostics, { allowForkedTurns })) {
      return false;
    }

    console.warn('[ChatHistory][blocked-cross-session-record]', {
      phase,
      sessionId,
      mismatchedOwners: diagnostics.mismatchedOwners,
    });
    return true;
  }

  private applyPendingTitle(metadata: SessionMetadata): SessionMetadata {
    const pendingUpdate = this.pendingTitles.get(metadata.sessionId);
    if (!pendingUpdate) {
      return metadata;
    }

    this.pendingTitles.delete(metadata.sessionId);
    return {
      ...metadata,
      title: pendingUpdate.title,
      titleSource: pendingUpdate.source,
    };
  }

  private applyPendingTitleToRecord(record: HostSessionRecord): HostSessionRecord {
    const pendingUpdate = this.pendingTitles.get(record.metadata.sessionId);
    if (!pendingUpdate) {
      return record;
    }

    this.pendingTitles.delete(record.metadata.sessionId);
    return {
      ...record,
      metadata: {
        ...record.metadata,
        title: pendingUpdate.title,
        titleSource: pendingUpdate.source,
        updatedAt: Date.now(),
      },
    };
  }

  private syncIndexEntryFromRecord(sessionId: string, record: HostSessionRecord): void {
    const entry = this.options.findIndexEntry(sessionId);
    const nextTitle = record.metadata.title || '';
    const nextTitleSource = record.metadata.titleSource;
    const nextDefaultTitle = record.metadata.defaultTitle || '';
    if (
      entry
      && entry.title === nextTitle
      && (entry.titleSource ?? undefined) === nextTitleSource
      && (entry.defaultTitle || '') === nextDefaultTitle
    ) {
      return;
    }

    this.options.upsertIndexEntry(sessionId, record.metadata, countHostRecordMessages(record), false);
    this.options.writeIndex();
  }
}
