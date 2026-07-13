import type {
  HostSessionRecord,
  HostSessionRuntimeAuxiliary,
  HostSessionSidecar,
  PersistedHostTurnResponse,
  SessionMetadata,
} from './chat-history.service';

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
  private pendingPrevious: HostSessionRecord | undefined;
  private pendingEntryCount = 0;

  constructor(private readonly compactAfterEntries = 512) {}

  createInitial(record: HostSessionRecord): string {
    const next = clonePersistedValue(record);
    this.previous = next;
    this.entryCount = 1;
    this.clearPending();
    return appendEntryLines([{ kind: 'initial', v: next }]);
  }

  read(content: string): HostSessionRecord {
    let state: HostSessionRecord | undefined;
    let lineCount = 0;

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      lineCount++;
      const entry = JSON.parse(line) as HostSessionOperationLogEntry;
      switch (entry.kind) {
        case 'initial':
          state = clonePersistedValue(entry.v);
          break;
        case 'setMetadata':
          this.requireState(state, entry.kind).metadata = clonePersistedValue(entry.v);
          break;
        case 'setSidecar': {
          const target = this.requireState(state, entry.kind);
          if (entry.v) {
            target.sidecar = clonePersistedValue(entry.v);
          } else {
            delete target.sidecar;
          }
          break;
        }
        case 'setAuxiliary': {
          const target = this.requireState(state, entry.kind);
          if (entry.v) {
            target.auxiliary = clonePersistedValue(entry.v);
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
          turns[index] = clonePersistedValue(entry.v);
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
    this.clearPending();
    return clonePersistedValue(state);
  }

  write(record: HostSessionRecord): { readonly op: 'append' | 'replace'; readonly data: string } {
    const current = clonePersistedValue(record);
    const previous = this.previous;
    if (!previous || this.entryCount >= this.compactAfterEntries) {
      this.pendingPrevious = current;
      this.pendingEntryCount = 1;
      return {
        op: 'replace',
        data: appendEntryLines([{ kind: 'initial', v: current }]),
      };
    }

    const entries = this.diff(previous, current);
    if (entries.length === 0) {
      this.clearPending();
      return { op: 'append', data: '' };
    }

    this.pendingPrevious = current;
    this.pendingEntryCount = this.entryCount + entries.length;
    return {
      op: 'append',
      data: appendEntryLines(entries),
    };
  }

  confirmWrite(): void {
    if (!this.pendingPrevious) {
      return;
    }

    this.previous = this.pendingPrevious;
    this.entryCount = this.pendingEntryCount;
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
  }
}
