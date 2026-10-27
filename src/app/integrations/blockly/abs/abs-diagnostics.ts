import { isReservedAbsWorkspaceCode, trustedAbsWorkspaceFailure } from './abs-workspace-availability';

/** Data-only diagnostics shared by the isolated runtime and tool boundary. No Blockly runtime dependency. */
export interface AbsDiagnostic {
  blockType?: string;
  parentBlockType?: string;
  field?: string;
  received?: string | number | boolean | null;
  allowedValues?: readonly (string | number | boolean)[];
  expectedTypes?: readonly string[];
  actualTypes?: readonly string[];
  modelName?: string;
  availableName?: string;
  conflicts?: AbsModelConflict[];
  hint?: string;
  reason?: string;
  identity?: AbsIdentityDiagnostic;
  resource?: AbsResourceDiagnostic;
  capacity?: { phase: string; resource: string; actual: number; limit: number };
  nativeTiming?: AbsNativeTiming;
  truncated?: boolean;
}

/** Bounded aggregate observations only: no source, field values or file paths. */
export interface AbsNativeUiTiming {
  callbacks: number;
  pending: number;
  snapshots: number;
  callbackMs: number;
  snapshotMs: number;
}
export interface AbsNativeTiming {
  elapsedMs: number;
  lastObservationAgeMs: number;
  realmElapsedMs?: number;
  completedPhases: Array<{ phase: string; elapsedMs: number }>;
  ui?: AbsNativeUiTiming;
}

export function boundedAbsNativeUiTiming(value: unknown): AbsNativeUiTiming | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const count = (key: string) => Number.isSafeInteger(input[key]) && (input[key] as number) >= 0 && (input[key] as number) <= 1000000;
  const time = (key: string) => typeof input[key] === 'number' && Number.isFinite(input[key]) && (input[key] as number) >= 0 && (input[key] as number) <= Number.MAX_SAFE_INTEGER;
  if (!['callbacks', 'pending', 'snapshots'].every(count) || !['callbackMs', 'snapshotMs'].every(time)) return undefined;
  return { callbacks: input['callbacks'] as number, pending: input['pending'] as number, snapshots: input['snapshots'] as number,
    callbackMs: input['callbackMs'] as number, snapshotMs: input['snapshotMs'] as number };
}

function boundedNativeTiming(value: unknown): AbsNativeTiming | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, any>;
  const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  if (!time(input['elapsedMs']) || !time(input['lastObservationAgeMs']) || !Array.isArray(input['completedPhases'])) return undefined;
  const completedPhases = input['completedPhases'].slice(0, 11).filter((entry: any) => entry
    && typeof entry.phase === 'string' && /^[a-z-]{1,40}$/.test(entry.phase) && time(entry.elapsedMs))
    .map((entry: any) => ({ phase: entry.phase, elapsedMs: entry.elapsedMs }));
  const ui = boundedAbsNativeUiTiming(input['ui']);
  return { elapsedMs: input['elapsedMs'], lastObservationAgeMs: input['lastObservationAgeMs'], completedPhases,
    ...(time(input['realmElapsedMs']) ? { realmElapsedMs: input['realmElapsedMs'] } : {}), ...(ui ? { ui } : {}) };
}

/** Host runtime asset evidence, never response bodies or URL credentials. */
export interface AbsResourceDiagnostic {
  url: string;
  status?: number;
  expectedHash?: string;
  actualHash?: string;
}

export interface AbsModelConflict {
  blockType?: string;
  field?: string;
  modelName?: string;
  availableName?: string;
  expectedTypes?: readonly string[];
  actualTypes?: readonly string[];
}

export interface AbsIdentityDiagnostic {
  evidence: 'missing' | 'tracked';
  batches: number;
  edits: number;
  baselineCount: number;
  candidateCount: number;
  /** UTF-16 call-name ranges in baseline / candidate source respectively. */
  baselineRanges: { start: number; end: number }[];
  candidateRanges: { start: number; end: number }[];
  /** Baseline call-name tokens overwritten by the recorded edits. */
  replacedBaselineRanges: { start: number; end: number }[];
}

export interface AbsFailure {
  code: string;
  message: string;
  range?: { start: number; end: number };
  diagnostic?: AbsDiagnostic;
}

/** Allowlist and bounds apply even to errors thrown by third-party library callbacks. */
export function serializeAbsFailure(error: unknown): AbsFailure {
  const workspaceFailure = trustedAbsWorkspaceFailure(error);
  if (workspaceFailure) return workspaceFailure;
  const value = error && typeof error === 'object' ? error as Record<string, any> : {};
  const reserved = isReservedAbsWorkspaceCode(value['code']);
  const code = !reserved && typeof value['code'] === 'string' && /^ABS_[A-Z0-9_]{1,80}$/.test(value['code'])
    ? value['code'] : 'ABS_GENERATION_FAILED';
  const message = (typeof value['message'] === 'string' ? value['message'] : String(error)).slice(0, 2000);
  const result: AbsFailure = { code, message };
  if (reserved) return result;
  const range = value['range'];
  if (range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start) {
    result.range = { start: range.start, end: range.end };
  }
  const input = value['diagnostic'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  const diagnostic: AbsDiagnostic = {};
  const nativeTiming = boundedNativeTiming(input.nativeTiming);
  if (nativeTiming) diagnostic.nativeTiming = nativeTiming;
  const capacity = input.capacity;
  if (capacity && typeof capacity.phase === 'string' && /^[a-z-]{1,40}$/.test(capacity.phase)
    && typeof capacity.resource === 'string' && /^[a-zA-Z]{1,40}$/.test(capacity.resource)
    && Number.isSafeInteger(capacity.actual) && capacity.actual >= 0
    && Number.isSafeInteger(capacity.limit) && capacity.limit > 0) {
    diagnostic.capacity = { phase: capacity.phase, resource: capacity.resource, actual: capacity.actual, limit: capacity.limit };
  }
  let truncated = input.truncated === true;
  const text = (value: string) => { if (value.length > 256) truncated = true; return value.slice(0, 256); };
  for (const key of ['blockType', 'parentBlockType', 'field', 'modelName', 'availableName', 'hint', 'reason'] as const) {
    if (typeof input[key] === 'string') diagnostic[key] = text(input[key]);
  }
  if (typeof input.resource?.url === 'string' && input.resource.url.length <= 2048) {
    try {
      const url = new URL(input.resource.url);
      if (['http:', 'https:', 'file:'].includes(url.protocol)) {
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        const resource: AbsResourceDiagnostic = { url: url.href };
        if (Number.isInteger(input.resource.status) && input.resource.status >= 0 && input.resource.status <= 599) resource.status = input.resource.status;
        for (const key of ['expectedHash', 'actualHash'] as const) {
          if (typeof input.resource[key] === 'string' && /^[a-f0-9]{64}$/.test(input.resource[key])) resource[key] = input.resource[key];
        }
        diagnostic.resource = resource;
      }
    } catch { /* Reject malformed, oversized or executable resource URLs. */ }
  }
  if (Array.isArray(input.conflicts)) {
    if (input.conflicts.length > 16) truncated = true;
    diagnostic.conflicts = input.conflicts.slice(0, 16).filter(item => item && typeof item === 'object').map(item => {
      const conflict: AbsModelConflict = {};
      for (const key of ['blockType', 'field', 'modelName', 'availableName'] as const) {
        if (typeof item[key] === 'string') conflict[key] = text(item[key]);
      }
      for (const key of ['expectedTypes', 'actualTypes'] as const) if (Array.isArray(item[key])) {
        if (item[key].length > 16) truncated = true;
        conflict[key] = item[key].slice(0, 16).filter(value => typeof value === 'string').map(text);
      }
      return conflict;
    });
  }
  const primitive = (value: unknown): value is string | number | boolean => typeof value === 'string'
    || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
  if (input.received === null || primitive(input.received)) {
    diagnostic.received = typeof input.received === 'string' ? text(input.received) : input.received;
  }
  for (const key of ['allowedValues', 'expectedTypes', 'actualTypes'] as const) {
    if (!Array.isArray(input[key])) continue;
    if (input[key].length > 64) truncated = true;
    const items = input[key].slice(0, 64).filter((item: unknown) => key === 'allowedValues' ? primitive(item) : typeof item === 'string')
      .map((item: string | number | boolean) => typeof item === 'string' ? text(item) : item);
    if (key === 'allowedValues') diagnostic.allowedValues = items;
    else diagnostic[key] = items as string[];
  }
  const identity = input.identity;
  const counts = ['batches', 'edits', 'baselineCount', 'candidateCount'] as const;
  if (identity && ['missing', 'tracked'].includes(identity.evidence)
    && counts.every(key => Number.isSafeInteger(identity[key]) && identity[key] >= 0)) {
    const bounded: AbsIdentityDiagnostic = {
      evidence: identity.evidence, batches: identity.batches, edits: identity.edits,
      baselineCount: identity.baselineCount, candidateCount: identity.candidateCount,
      baselineRanges: [], candidateRanges: [], replacedBaselineRanges: [],
    };
    for (const key of ['baselineRanges', 'candidateRanges', 'replacedBaselineRanges'] as const) {
      if (!Array.isArray(identity[key])) continue;
      if (identity[key].length > 8) truncated = true;
      bounded[key] = identity[key].slice(0, 8).filter((r: any) => r && Number.isSafeInteger(r.start)
        && Number.isSafeInteger(r.end) && r.start >= 0 && r.end >= r.start)
        .map((r: any) => ({ start: r.start, end: r.end }));
    }
    diagnostic.identity = bounded;
  }
  if (truncated) diagnostic.truncated = true;
  if (Object.keys(diagnostic).length) result.diagnostic = diagnostic;
  return result;
}

export function restoreAbsFailure(value: unknown): Error & AbsFailure {
  const failure = serializeAbsFailure(value);
  return Object.assign(new Error(failure.message), failure);
}
