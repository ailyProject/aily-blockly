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
  private readonly dirtySessions = new Map<string, HostSessionDirtyPolicy>();
  private readonly sessionCache = new Map<string, HostSessionRecord>();
  private readonly pendingTitles = new Map<string, PendingTitleUpdate>();
  private liveSessionProvider: LiveSessionProvider | null = null;

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

    const previousPolicy = this.dirtySessions.get(normalizedSessionId);
    const nextPolicy = options?.policy ?? 'recovery-snapshot';
    this.dirtySessions.set(
      normalizedSessionId,
      previousPolicy === 'authoritative' ? 'authoritative' : nextPolicy,
    );
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

  private flushAllCore(options?: HostSessionFlushOptions): void {
    const skippedSessions = new Map<string, HostSessionDirtyPolicy>();
    for (const [sessionId, policy] of this.dirtySessions) {
      if (options?.shouldSkipSession?.(sessionId, policy)) {
        skippedSessions.set(sessionId, policy);
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
        if (policy === 'authoritative') {
          this.options.upsertIndexEntry(sessionId, hostRecord.metadata, messageCount);
        }
      }
    }
    this.dirtySessions.clear();
    for (const [sessionId, policy] of skippedSessions) {
      this.dirtySessions.set(sessionId, policy);
    }

    if (this.options.hasDirtyIndex()) {
      this.options.writeIndex();
    }
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
