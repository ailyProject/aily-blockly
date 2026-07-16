import type {
  HostSessionRecord,
  HostSessionRuntimeAuxiliary,
  HostSessionSidecar,
  PersistedHostTurnResponse,
  SessionMetadata,
} from './chat-history.service';

export const HOST_SESSION_OPERATION_LOG_COMPACT_AFTER_BYTES = 4 * 1024 * 1024;

type HostSessionOperationLogEntry =
  | { readonly kind: 'initial'; readonly v: HostSessionRecord }
  | { readonly kind: 'setMetadata'; readonly v: SessionMetadata }
  | { readonly kind: 'setSidecar'; readonly v?: HostSessionSidecar | null }
  | { readonly kind: 'setAuxiliary'; readonly v?: HostSessionRuntimeAuxiliary | null }
  | { readonly kind: 'truncateTurns'; readonly length: number }
  | { readonly kind: 'replaceTurn'; readonly index: number; readonly v: PersistedHostTurnResponse };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalHostSessionSnapshot(value: unknown): value is HostSessionRecord {
  return isRecord(value)
    && isRecord(value['metadata'])
    && Array.isArray(value['turnResponses']);
}

function clonePersistedValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => clonePersistedValue(item)) as T;
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, clonePersistedValue(entryValue)]),
    ) as T;
  }

  return value;
}

function serializeStable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function areEqual(left: unknown, right: unknown): boolean {
  return serializeStable(left) === serializeStable(right);
}

function appendEntryLines(entries: readonly HostSessionOperationLogEntry[]): string {
  return entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
}

function normalizeTurnLength(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

export class HostSessionOperationLog {
  private previous: HostSessionRecord | undefined;
  private entryCount = 0;
  private byteCount = 0;
  private pendingPrevious: HostSessionRecord | undefined;
  private pendingEntryCount = 0;
  private pendingByteCount = 0;

  constructor(
    private readonly compactAfterEntries = 512,
    private readonly compactAfterBytes = HOST_SESSION_OPERATION_LOG_COMPACT_AFTER_BYTES,
  ) {}

  createInitial(record: HostSessionRecord): string {
    const next = clonePersistedValue(record);
    const data = appendEntryLines([{ kind: 'initial', v: next }]);
    this.previous = next;
    this.entryCount = 1;
    this.byteCount = data.length;
    this.clearPending();
    return data;
  }

  read(content: string): HostSessionRecord {
    let state: HostSessionRecord | undefined;
    let lineCount = 0;

    let offset = 0;
    while (offset < content.length) {
      const newlineIndex = content.indexOf('\n', offset);
      const end = newlineIndex >= 0 ? newlineIndex : content.length;
      const line = content.slice(offset, end).replace(/\r$/, '');
      offset = newlineIndex >= 0 ? newlineIndex + 1 : content.length;
      if (!line.trim()) {
        continue;
      }

      lineCount++;
      const parsed = JSON.parse(line) as unknown;
      if (isCanonicalHostSessionSnapshot(parsed)) {
        if (lineCount !== 1 || state) {
          throw new Error('Canonical host session snapshot must be the first operation-log entry');
        }
        state = parsed;
        continue;
      }
      const entry = parsed as HostSessionOperationLogEntry;
      switch (entry.kind) {
        case 'initial':
          state = entry.v;
          break;
        case 'setMetadata':
          this.requireState(state, entry.kind).metadata = entry.v;
          break;
        case 'setSidecar': {
          const target = this.requireState(state, entry.kind);
          if (entry.v) {
            target.sidecar = entry.v;
          } else {
            delete target.sidecar;
          }
          break;
        }
        case 'setAuxiliary': {
          const target = this.requireState(state, entry.kind);
          if (entry.v) {
            target.auxiliary = entry.v;
          } else {
            delete target.auxiliary;
          }
          break;
        }
        case 'truncateTurns': {
          const target = this.requireState(state, entry.kind);
          const turns = Array.isArray(target.turnResponses) ? target.turnResponses : [];
          const length = normalizeTurnLength(entry.length);
          target.turnResponses = turns.slice(0, length);
          if (target.turnResponses.length === 0) {
            delete target.turnResponses;
          }
          break;
        }
        case 'replaceTurn': {
          const target = this.requireState(state, entry.kind);
          const index = normalizeTurnLength(entry.index);
          const turns = Array.isArray(target.turnResponses) ? [...target.turnResponses] : [];
          turns[index] = entry.v;
          target.turnResponses = turns.filter(Boolean);
          break;
        }
      }
    }

    if (!state || lineCount === 0) {
      throw new Error('Host session operation log is empty');
    }

    this.previous = clonePersistedValue(state);
    this.entryCount = lineCount;
    this.byteCount = content.length;
    this.clearPending();
    return state;
  }

  write(record: HostSessionRecord): { readonly op: 'append' | 'replace'; readonly data: string } {
    const current = clonePersistedValue(record);
    const previous = this.previous;
    if (!previous) {
      const data = appendEntryLines([{ kind: 'initial', v: current }]);
      this.pendingPrevious = current;
      this.pendingEntryCount = 1;
      this.pendingByteCount = data.length;
      return {
        op: 'replace',
        data,
      };
    }

    const entries = this.diff(previous, current);
    if (entries.length === 0) {
      this.clearPending();
      return { op: 'append', data: '' };
    }

    const appendData = appendEntryLines(entries);
    if (this.entryCount >= this.compactAfterEntries
      || this.byteCount + appendData.length >= this.compactAfterBytes) {
      const data = appendEntryLines([{ kind: 'initial', v: current }]);
      this.pendingPrevious = current;
      this.pendingEntryCount = 1;
      this.pendingByteCount = data.length;
      return { op: 'replace', data };
    }

    this.pendingPrevious = current;
    this.pendingEntryCount = this.entryCount + entries.length;
    this.pendingByteCount = this.byteCount + appendData.length;
    return {
      op: 'append',
      data: appendData,
    };
  }

  confirmWrite(): void {
    if (!this.pendingPrevious) {
      return;
    }

    this.previous = this.pendingPrevious;
    this.entryCount = this.pendingEntryCount;
    this.byteCount = this.pendingByteCount;
    this.clearPending();
  }

  private diff(previous: HostSessionRecord, current: HostSessionRecord): HostSessionOperationLogEntry[] {
    const entries: HostSessionOperationLogEntry[] = [];

    if (!areEqual(previous.metadata, current.metadata)) {
      entries.push({ kind: 'setMetadata', v: clonePersistedValue(current.metadata) });
    }
    if (!areEqual(previous.sidecar, current.sidecar)) {
      entries.push({ kind: 'setSidecar', v: current.sidecar ? clonePersistedValue(current.sidecar) : null });
    }
    if (!areEqual(previous.auxiliary, current.auxiliary)) {
      entries.push({ kind: 'setAuxiliary', v: current.auxiliary ? clonePersistedValue(current.auxiliary) : null });
    }

    const previousTurns = Array.isArray(previous.turnResponses) ? previous.turnResponses : [];
    const currentTurns = Array.isArray(current.turnResponses) ? current.turnResponses : [];
    let sharedPrefixLength = 0;
    while (
      sharedPrefixLength < previousTurns.length
      && sharedPrefixLength < currentTurns.length
      && areEqual(previousTurns[sharedPrefixLength], currentTurns[sharedPrefixLength])
    ) {
      sharedPrefixLength++;
    }

    if (sharedPrefixLength < previousTurns.length) {
      entries.push({ kind: 'truncateTurns', length: sharedPrefixLength });
    }
    for (let index = sharedPrefixLength; index < currentTurns.length; index += 1) {
      entries.push({
        kind: 'replaceTurn',
        index,
        v: clonePersistedValue(currentTurns[index]),
      });
    }

    return entries;
  }

  private requireState(
    state: HostSessionRecord | undefined,
    operation: HostSessionOperationLogEntry['kind'],
  ): HostSessionRecord {
    if (!state) {
      throw new Error(`Host session operation log is missing initial entry before ${operation}`);
    }

    return state;
  }

  private clearPending(): void {
    this.pendingPrevious = undefined;
    this.pendingEntryCount = 0;
    this.pendingByteCount = 0;
  }
}
