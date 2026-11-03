import type { AbsFailure } from './abs-diagnostics';
import { serializeAbsFailure } from './abs-diagnostics';
import type { AbsGenerationBinding, AbsGenerationCandidateRequest } from './abs-generation-protocol';
import { AbsSyncError } from './abs-state';

export interface AbsNativeCandidateFailureInput {
  /** Host identity of the exact scope, baseline, candidate, intent, runtime, canvas and disk. */
  key: string;
  base: AbsGenerationBinding;
  candidate: AbsGenerationCandidateRequest['candidate'];
  error: unknown;
  source: string;
  request: AbsGenerationCandidateRequest;
  assertCurrent?: () => void;
  allowRecovery?: boolean;
}

export type AbsNativeCandidateFailureCapture = Readonly<Omit<AbsNativeCandidateFailureInput, 'error' | 'allowRecovery'>>;
export interface AbsNativeCandidateFailureDescription extends AbsFailure {
  version: 1;
  preparationRequestId: string;
  base: AbsGenerationBinding;
  candidate: AbsGenerationCandidateRequest['candidate'];
  recovery?: { action: 'prepare_native'; strategy: 'rebuild-library-runtime'; token: string; requestId: string; status: 'available' | 'running' };
}
export interface AbsNativeCandidateRecoveryResult<T = unknown> {
  status: 'running' | 'completed' | 'failed' | 'unavailable';
  value?: T;
  failure?: AbsFailure;
}
interface FailureEntry {
  captured: AbsNativeCandidateFailureCapture;
  originalError: unknown;
  failure: AbsFailure;
  requestId: string;
  token?: string;
  ready?: Promise<void>;
  status: 'available' | 'running' | 'completed' | 'failed' | 'unavailable';
  value?: unknown;
  recoveryFailure?: AbsFailure;
}

/** One exact failed native candidate, not a retry loop or a general runtime capability. */
export class AbsNativeCandidateFailures {
  private entry?: FailureEntry;
  /** A consumed request survives candidate/runtime replacement for read-only acknowledgement recovery. */
  private recoveryEntry?: FailureEntry;

  matching(key: string): unknown | undefined {
    if (this.entry?.captured.key !== key) { this.entry = undefined; return undefined; }
    return this.entry.originalError;
  }

  async remember(input: AbsNativeCandidateFailureInput): Promise<AbsNativeCandidateFailureDescription | undefined> {
    if (this.entry?.captured.key === input.key) {
      const current = this.entry;
      await current.ready;
      if (this.entry !== current) return undefined;
      return this.describe(input.key);
    }
    this.entry = undefined;
    if (!input.error || typeof input.error !== 'object' || typeof (input.error as { code?: unknown }).code !== 'string') return undefined;
    const failure = serializeAbsFailure(input.error);
    if (!/^ABS_(?:NATIVE_|RUNTIME_)/.test(failure.code)
      && !['ABS_GENERATION_FAILED', 'ABS_LIMIT', 'ABS_CONTRACT_MUTATION'].includes(failure.code)) return undefined;
    const { key, source, assertCurrent } = input;
    const request = structuredClone(input.request);
    const entry: FailureEntry = {
      captured: { key, source, assertCurrent, request, base: structuredClone(input.base), candidate: { ...input.candidate } },
      originalError: input.error, failure, requestId: crypto.randomUUID(),
      status: input.allowRecovery !== false && failure.code === 'ABS_NATIVE_TIMEOUT' ? 'available' : 'unavailable',
    };
    this.entry = entry;
    if (entry.status === 'available') {
      entry.ready = this.token(key, entry.requestId)
        .then(token => { if (this.entry === entry) entry.token = token; });
      await entry.ready;
    }
    if (this.entry !== entry) return undefined;
    return this.describe(key);
  }

  describe(key?: string): AbsNativeCandidateFailureDescription | undefined {
    const entry = this.entry;
    if (!entry) return undefined;
    if (key !== undefined && entry.captured.key !== key) { this.entry = undefined; return undefined; }
    return { version: 1, ...structuredClone(entry.failure), preparationRequestId: entry.captured.request.requestId,
      base: structuredClone(entry.captured.base),
      candidate: { ...entry.captured.candidate },
      ...(entry.token && (entry.status === 'available' || entry.status === 'running') ? {
        recovery: { action: 'prepare_native' as const, strategy: 'rebuild-library-runtime' as const,
          token: entry.token, requestId: entry.requestId, status: entry.status },
      } : {}) };
  }

  capture(token: string, requestId: string): AbsNativeCandidateFailureCapture {
    return this.copyCapture(this.require(token, requestId));
  }

  private copyCapture(entry: FailureEntry): AbsNativeCandidateFailureCapture {
    return { ...entry.captured, request: structuredClone(entry.captured.request), base: structuredClone(entry.captured.base),
      candidate: { ...entry.captured.candidate } };
  }

  async run<T>(token: string, requestId: string, observe: boolean,
    operation: (captured: AbsNativeCandidateFailureCapture) => Promise<T>): Promise<AbsNativeCandidateRecoveryResult<T>> {
    const entry = this.require(token, requestId);
    if (observe || entry.status !== 'available') return this.result<T>(entry);
    if (this.recoveryEntry?.status === 'running' && this.recoveryEntry !== entry) return { status: 'unavailable' };
    // Admission is consumed synchronously, before callbacks or any asynchronous work.
    entry.status = 'running';
    this.recoveryEntry = entry;
    try {
      entry.captured.assertCurrent?.();
      entry.value = structuredClone(await operation(this.copyCapture(entry)));
      entry.status = 'completed';
    } catch (error) {
      entry.recoveryFailure = serializeAbsFailure(error);
      entry.status = 'failed';
    }
    return this.result<T>(entry);
  }

  private require(token: string, requestId: string): FailureEntry {
    const entry = [this.entry, this.recoveryEntry].find(value => value?.token === token && value.requestId === requestId);
    if (!entry?.token || entry.token !== token || entry.requestId !== requestId) {
      throw new AbsSyncError('ABS_NATIVE_RECOVERY_STALE', 'The exact native candidate recovery is unavailable. Inspect the current candidate; do not replay an unknown recovery.');
    }
    return entry;
  }

  private async token(key: string, requestId: string): Promise<string> {
    const input = JSON.stringify({ version: 1, key, requestId, strategy: 'rebuild-library-runtime' });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  private result<T>(entry: FailureEntry): AbsNativeCandidateRecoveryResult<T> {
    if (entry.status === 'completed') return { status: 'completed', value: structuredClone(entry.value) as T };
    if (entry.status === 'failed') return { status: 'failed', failure: structuredClone(entry.recoveryFailure!) };
    return { status: entry.status === 'running' ? 'running' : 'unavailable' };
  }
}
