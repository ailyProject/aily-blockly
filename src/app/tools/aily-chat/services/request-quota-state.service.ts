import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import type { TurnResponseQuotaSnapshot, TurnResponseTurn } from 'aily-lex/browser';

import { ChatAPI } from '../core/api-endpoints';
import { AilyHost } from '../core/host';
import {
  createRequestQuotaSnapshot,
  createRequestQuotaSnapshotFromServiceState,
  type RequestQuotaSnapshot,
} from './request-quota-snapshot';

export interface RequestQuotaUsageSnapshot {
  readonly entitlement: number;
  readonly remaining: number;
  readonly percentRemaining: number;
  readonly unlimited?: boolean;
  readonly overageCount?: number;
  readonly overagePermitted?: boolean;
  readonly resetAt: string;
}

export interface RequestQuotaServiceState {
  readonly quotaSnapshots?: Readonly<Record<string, RequestQuotaUsageSnapshot>>;
  readonly rateLimitSnapshots?: Readonly<Record<string, RequestQuotaUsageSnapshot>>;
  readonly chatQuotaExceeded?: boolean;
  readonly rateLimited?: boolean;
  readonly errorCode?: string;
  readonly retryAfterMs?: number;
  readonly updatedAt?: string;
  readonly sourceInteractionId?: string | null;
}

const QUOTA_HEADER_PREMIUM_MODELS = 'x-aily-quota-snapshot-premium-models';
const QUOTA_HEADER_PREMIUM_INTERACTIONS = 'x-aily-quota-snapshot-premium-interactions';
const QUOTA_HEADER_MONTHLY = 'x-aily-quota-snapshot-monthly';
const QUOTA_HEADER_DAILY = 'x-aily-quota-snapshot-daily';
const RATE_LIMIT_HEADER_SESSION = 'x-aily-ratelimit-snapshot-session';
const RATE_LIMIT_HEADER_WEEKLY = 'x-aily-ratelimit-snapshot-weekly';
const RATE_LIMIT_HEADER_BURST = 'x-aily-ratelimit-snapshot-burst';
const QUOTA_HEADER_EXCEEDED = 'x-aily-chat-quota-exceeded';
const RATE_LIMIT_HEADER_EXCEEDED = 'x-aily-rate-limited';
const QUOTA_HEADER_UPDATED_AT = 'x-aily-quota-updated-at';
const QUOTA_HEADER_SOURCE_INTERACTION_ID = 'x-aily-source-interaction-id';

@Injectable({
  providedIn: 'root',
})
export class RequestQuotaStateService {
  private readonly snapshotSubject = new BehaviorSubject<RequestQuotaServiceState | null>(null);
  readonly snapshot$ = this.snapshotSubject.asObservable();
  private readonly requestQuotaSnapshotSubject = new BehaviorSubject<RequestQuotaSnapshot | null>(null);
  readonly requestQuotaSnapshot$ = this.requestQuotaSnapshotSubject.asObservable();
  private readonly quotaExceededSubject = new Subject<void>();
  readonly onDidChangeQuotaExceeded = this.quotaExceededSubject.asObservable();
  private readonly quotaRemainingSubject = new Subject<void>();
  readonly onDidChangeQuotaRemaining = this.quotaRemainingSubject.asObservable();
  private inFlightRefresh: Promise<RequestQuotaServiceState | null> | null = null;
  // Holds display-only fallback projected from live code-only failures.
  private transientRequestQuotaSnapshot: RequestQuotaSnapshot | null = null;

  getSnapshot(): RequestQuotaServiceState | null {
    return this.snapshotSubject.getValue();
  }

  getRequestQuotaSnapshot(): RequestQuotaSnapshot | null {
    return this.requestQuotaSnapshotSubject.getValue();
  }

  async refresh(): Promise<RequestQuotaServiceState | null> {
    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }

    this.inFlightRefresh = this.fetchSnapshot().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  clear(): void {
    this.transientRequestQuotaSnapshot = null;
    this.acceptSnapshot(null);
  }

  replaceProjectedState(snapshot: RequestQuotaServiceState | null | undefined): RequestQuotaServiceState | null {
    this.transientRequestQuotaSnapshot = null;
    this.replaceSnapshot(snapshot ?? null);
    return this.getSnapshot();
  }

  acceptTurnResponseQuotaSnapshot(turns: readonly TurnResponseTurn[] | null | undefined): RequestQuotaServiceState | null {
    const sidecarState = readRequestQuotaStateTurnSidecar(turns);
    if (!sidecarState) {
      this.publishRequestQuotaSnapshot(this.getSnapshot());
      return this.getSnapshot();
    }

    if (!hasStructuredRequestQuotaState(sidecarState)) {
      this.transientRequestQuotaSnapshot = readTransientRequestQuotaSnapshot(turns);
      this.publishRequestQuotaSnapshot(this.getSnapshot());
      return this.getSnapshot();
    }

    const snapshot = mergeLatestTurnSidecarQuotaState(this.getSnapshot(), sidecarState);
    if (snapshot && this.getSnapshot() && isOlderRequestQuotaState(snapshot, this.getSnapshot()!)) {
      return this.getSnapshot();
    }

    this.transientRequestQuotaSnapshot = null;
    this.acceptSnapshot(snapshot);
    return snapshot;
  }

  acceptInteractionErrorResponse(
    payload: unknown,
    headers?: Headers | null | undefined,
  ): RequestQuotaServiceState | null {
    const payloadState = readRequestQuotaStateErrorPayload(payload);
    const headerState = headers ? readRequestQuotaStateHeaders(headers) : {};
    const incoming = payloadState
      ? mergeRequestQuotaServiceState(payloadState, headerState)
      : hasStructuredRequestQuotaState(headerState)
        ? headerState
        : null;

    if (!incoming || !hasStructuredRequestQuotaState(incoming)) {
      this.publishRequestQuotaSnapshot(this.getSnapshot());
      return this.getSnapshot();
    }

    this.transientRequestQuotaSnapshot = null;
    const snapshot = mergeLatestTurnSidecarQuotaState(this.getSnapshot(), incoming);
    this.acceptSnapshot(snapshot);
    return snapshot;
  }

  private async fetchSnapshot(): Promise<RequestQuotaServiceState | null> {
    try {
      const token = await AilyHost.get().auth.getToken?.();
      if (!token) {
        this.acceptSnapshot(null);
        return null;
      }

      const headers: HeadersInit = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      const response = await fetch(ChatAPI.interactionQuotaSnapshot, { headers });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.acceptSnapshot(null);
        }
        return this.getSnapshot();
      }

      const payload = await response.json();
      if (!payload || typeof payload !== 'object') {
        const headerState = readRequestQuotaStateHeaders(response.headers);
        const snapshot = hasStructuredRequestQuotaState(headerState) ? headerState : null;
        this.acceptSnapshot(snapshot);
        return snapshot;
      }

      const snapshot = mergeRequestQuotaServiceState(
        payload as RequestQuotaServiceState,
        readRequestQuotaStateHeaders(response.headers),
      );
      this.acceptSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      console.warn('[RequestQuotaStateService] refresh failed:', error);
      return this.getSnapshot();
    }
  }

  private acceptSnapshot(snapshot: RequestQuotaServiceState | null): void {
    const previous = this.getSnapshot();
    if (snapshot && previous && isOlderRequestQuotaState(snapshot, previous)) {
      return;
    }

    this.replaceSnapshot(snapshot);
  }

  private replaceSnapshot(snapshot: RequestQuotaServiceState | null): void {
    const previous = this.getSnapshot();
    this.snapshotSubject.next(snapshot);
    this.publishRequestQuotaSnapshot(snapshot);

    const change = compareRequestQuotaState(previous, snapshot);
    if (change.exceeded) {
      this.quotaExceededSubject.next();
    }
    if (change.remaining) {
      this.quotaRemainingSubject.next();
    }
  }
  private publishRequestQuotaSnapshot(snapshot: RequestQuotaServiceState | null): void {
    this.requestQuotaSnapshotSubject.next(
      this.transientRequestQuotaSnapshot ?? createRequestQuotaSnapshotFromServiceState(snapshot),
    );
  }
}

function readTransientRequestQuotaSnapshot(
  turns: readonly TurnResponseTurn[] | null | undefined,
): RequestQuotaSnapshot | null {
  const snapshot = createRequestQuotaSnapshot(turns);
  if (!snapshot) {
    return null;
  }

  if (typeof snapshot.quota.errorCode !== 'string' && typeof snapshot.quota.retryAfterMs !== 'number') {
    return null;
  }

  // Only code-only failures stay on this transient display path.
  return snapshot;
}

type RequestQuotaChange = {
  readonly exceeded: boolean;
  readonly remaining: boolean;
};

export function readRequestQuotaStateHeaders(headers: Headers): RequestQuotaServiceState {
  const premiumModels = parseQuotaSnapshotHeader(headers.get(QUOTA_HEADER_PREMIUM_MODELS));
  const premiumInteractions = parseQuotaSnapshotHeader(headers.get(QUOTA_HEADER_PREMIUM_INTERACTIONS));
  const monthly = parseQuotaSnapshotHeader(headers.get(QUOTA_HEADER_MONTHLY));
  const daily = parseQuotaSnapshotHeader(headers.get(QUOTA_HEADER_DAILY));
  const session = parseRateLimitSnapshotHeader(headers.get(RATE_LIMIT_HEADER_SESSION));
  const weekly = parseRateLimitSnapshotHeader(headers.get(RATE_LIMIT_HEADER_WEEKLY));
  const burst = parseRateLimitSnapshotHeader(headers.get(RATE_LIMIT_HEADER_BURST));

  return normalizeRequestQuotaServiceState({
    quotaSnapshots: {
      ...(premiumModels ? { premium_models: premiumModels } : {}),
      ...(premiumInteractions ? { premium_interactions: premiumInteractions } : {}),
      ...(monthly ? { chat_monthly: monthly } : {}),
      ...(daily ? { daily_interactions: daily } : {}),
    },
    rateLimitSnapshots: {
      ...(session ? { session: session } : {}),
      ...(weekly ? { weekly: weekly } : {}),
      ...(burst ? { burst_10m: burst } : {}),
    },
    chatQuotaExceeded: parseBooleanHeader(headers.get(QUOTA_HEADER_EXCEEDED)),
    rateLimited: parseBooleanHeader(headers.get(RATE_LIMIT_HEADER_EXCEEDED)),
    updatedAt: headers.get(QUOTA_HEADER_UPDATED_AT) || undefined,
    sourceInteractionId: headers.get(QUOTA_HEADER_SOURCE_INTERACTION_ID),
  });
}

export function readRequestQuotaStateTurnSidecar(
  turns: readonly TurnResponseTurn[] | null | undefined,
): RequestQuotaServiceState | null {
  if (!turns) {
    return null;
  }

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const quotaSnapshot = turns[index]?.responseModel?.quotaSnapshot;
    if (quotaSnapshot) {
      return readRequestQuotaStateQuotaSnapshot(quotaSnapshot);
    }
  }

  return null;
}

export function readRequestQuotaStateErrorPayload(payload: unknown): RequestQuotaServiceState | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const quotaSnapshot = readInteractionErrorQuotaSnapshot(record['quota_snapshot']);
  if (!quotaSnapshot) {
    return null;
  }

  if (typeof quotaSnapshot.errorCode === 'string' && quotaSnapshot.errorCode.trim().length > 0) {
    return quotaSnapshot;
  }

  const topLevelErrorCode = normalizeInteractionErrorCode(record['error']);
  return topLevelErrorCode
    ? { ...quotaSnapshot, errorCode: topLevelErrorCode }
    : quotaSnapshot;
}

function compareRequestQuotaState(
  previous: RequestQuotaServiceState | null,
  current: RequestQuotaServiceState | null,
): RequestQuotaChange {
  const chatMonthlyChanged = compareUsageSnapshot(
    previous?.quotaSnapshots?.['chat_monthly'],
    current?.quotaSnapshots?.['chat_monthly'],
  );
  const premiumModelsChanged = compareUsageSnapshot(
    previous?.quotaSnapshots?.['premium_models'],
    current?.quotaSnapshots?.['premium_models'],
  );
  const premiumInteractionsChanged = compareUsageSnapshot(
    previous?.quotaSnapshots?.['premium_interactions'],
    current?.quotaSnapshots?.['premium_interactions'],
  );
  const dailyChanged = compareUsageSnapshot(
    previous?.quotaSnapshots?.['daily_interactions'],
    current?.quotaSnapshots?.['daily_interactions'],
  );
  const burstChanged = compareUsageSnapshot(
    previous?.rateLimitSnapshots?.['burst_10m'],
    current?.rateLimitSnapshots?.['burst_10m'],
  );
  const sessionChanged = compareUsageSnapshot(
    previous?.rateLimitSnapshots?.['session'],
    current?.rateLimitSnapshots?.['session'],
  );
  const weeklyChanged = compareUsageSnapshot(
    previous?.rateLimitSnapshots?.['weekly'],
    current?.rateLimitSnapshots?.['weekly'],
  );

  const chatQuotaExceededChanged = previous?.chatQuotaExceeded !== current?.chatQuotaExceeded;
  const rateLimitedChanged = previous?.rateLimited !== current?.rateLimited;

  return {
    exceeded:
      chatMonthlyChanged.exceeded
      || premiumModelsChanged.exceeded
      || premiumInteractionsChanged.exceeded
      || dailyChanged.exceeded
      || sessionChanged.exceeded
      || weeklyChanged.exceeded
      || burstChanged.exceeded
      || chatQuotaExceededChanged
      || rateLimitedChanged,
    remaining:
      chatMonthlyChanged.remaining
      || premiumModelsChanged.remaining
      || premiumInteractionsChanged.remaining
      || dailyChanged.remaining
      || sessionChanged.remaining
      || weeklyChanged.remaining
      || burstChanged.remaining,
  };
}

function compareUsageSnapshot(
  previous: RequestQuotaUsageSnapshot | undefined,
  current: RequestQuotaUsageSnapshot | undefined,
): RequestQuotaChange {
  return {
    exceeded: isRequestQuotaUsageSnapshotExhausted(previous) !== isRequestQuotaUsageSnapshotExhausted(current),
    remaining: previous?.remaining !== current?.remaining,
  };
}

function isRequestQuotaUsageSnapshotExhausted(
  snapshot: RequestQuotaUsageSnapshot | undefined,
): boolean {
  return !!snapshot
    && snapshot.unlimited !== true
    && snapshot.overagePermitted !== true
    && snapshot.remaining === 0;
}

function readRequestQuotaStateQuotaSnapshot(
  quotaSnapshot: TurnResponseQuotaSnapshot,
): RequestQuotaServiceState {
  const ext = quotaSnapshot as TurnResponseQuotaSnapshot & {
    updatedAt?: string;
    sourceInteractionId?: string;
    chatQuotaExceeded?: boolean;
    rateLimited?: boolean;
    retryAfterMs?: number;
  };
  return normalizeRequestQuotaServiceState({
    ...(typeof ext.updatedAt === 'string' ? { updatedAt: ext.updatedAt } : {}),
    ...(typeof ext.sourceInteractionId === 'string' ? { sourceInteractionId: ext.sourceInteractionId } : {}),
    ...(typeof ext.chatQuotaExceeded === 'boolean' ? { chatQuotaExceeded: ext.chatQuotaExceeded } : {}),
    ...(typeof ext.rateLimited === 'boolean' ? { rateLimited: ext.rateLimited } : {}),
    ...(typeof quotaSnapshot.errorCode === 'string' ? { errorCode: quotaSnapshot.errorCode } : {}),
    ...(typeof ext.retryAfterMs === 'number' && Number.isFinite(ext.retryAfterMs)
      ? { retryAfterMs: ext.retryAfterMs }
      : {}),
    quotaSnapshots: normalizeQuotaSnapshotMap(quotaSnapshot.quotaSnapshots),
    rateLimitSnapshots: normalizeRateLimitSnapshotMap(quotaSnapshot.rateLimitSnapshots),
  });
}

function readInteractionErrorQuotaSnapshot(payload: unknown): RequestQuotaServiceState | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return readRequestQuotaStateQuotaSnapshot(payload as TurnResponseQuotaSnapshot);
}

function normalizeInteractionErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'string') {
    return undefined;
  }

  const normalized = error.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function mergeRequestQuotaServiceState(
  payload: RequestQuotaServiceState,
  headerState: RequestQuotaServiceState,
): RequestQuotaServiceState {
  if (isOlderRequestQuotaState(headerState, payload)) {
    return normalizeRequestQuotaServiceState(payload);
  }

  return normalizeRequestQuotaServiceState({
    ...payload,
    ...(headerState.updatedAt ? { updatedAt: headerState.updatedAt } : {}),
    ...(headerState.sourceInteractionId !== null && headerState.sourceInteractionId !== undefined
      ? { sourceInteractionId: headerState.sourceInteractionId }
      : {}),
    ...(typeof headerState.chatQuotaExceeded === 'boolean'
      ? { chatQuotaExceeded: headerState.chatQuotaExceeded }
      : {}),
    ...(typeof headerState.rateLimited === 'boolean'
      ? { rateLimited: headerState.rateLimited }
      : {}),
    ...(typeof headerState.errorCode === 'string'
      ? { errorCode: headerState.errorCode }
      : {}),
    ...(typeof headerState.retryAfterMs === 'number' && Number.isFinite(headerState.retryAfterMs)
      ? { retryAfterMs: headerState.retryAfterMs }
      : {}),
    quotaSnapshots: {
      ...(payload.quotaSnapshots ?? {}),
      ...(headerState.quotaSnapshots ?? {}),
    },
    rateLimitSnapshots: {
      ...(payload.rateLimitSnapshots ?? {}),
      ...(headerState.rateLimitSnapshots ?? {}),
    },
  });
}

function mergeLatestTurnSidecarQuotaState(
  existing: RequestQuotaServiceState | null,
  incoming: RequestQuotaServiceState,
): RequestQuotaServiceState {
  if (existing && isOlderRequestQuotaState(incoming, existing)) {
    return existing;
  }

  return incoming;
}

function isOlderRequestQuotaState(
  incoming: RequestQuotaServiceState,
  existing: RequestQuotaServiceState,
): boolean {
  const incomingUpdatedAt = Date.parse(incoming.updatedAt ?? '');
  const existingUpdatedAt = Date.parse(existing.updatedAt ?? '');
  return Number.isFinite(incomingUpdatedAt)
    && Number.isFinite(existingUpdatedAt)
    && incomingUpdatedAt < existingUpdatedAt;
}

function normalizeQuotaSnapshotMap(
  snapshots: Readonly<Record<string, {
    readonly entitlement: number;
    readonly remaining: number;
    readonly percentRemaining: number;
    readonly unlimited?: boolean;
    readonly overageCount?: number;
    readonly overagePermitted?: boolean;
    readonly resetAt?: string;
  }>> | undefined,
): Readonly<Record<string, RequestQuotaUsageSnapshot>> | undefined {
  return normalizeUsageSnapshotMap(snapshots, true);
}

function normalizeRateLimitSnapshotMap(
  snapshots: Readonly<Record<string, {
    readonly entitlement: number;
    readonly remaining: number;
    readonly percentRemaining: number;
    readonly unlimited?: boolean;
    readonly overageCount?: number;
    readonly overagePermitted?: boolean;
    readonly resetAt?: string;
  }>> | undefined,
): Readonly<Record<string, RequestQuotaUsageSnapshot>> | undefined {
  return normalizeUsageSnapshotMap(snapshots, false);
}

function normalizeUsageSnapshotMap(
  snapshots: Readonly<Record<string, {
    readonly entitlement: number;
    readonly remaining: number;
    readonly percentRemaining: number;
    readonly unlimited?: boolean;
    readonly overageCount?: number;
    readonly overagePermitted?: boolean;
    readonly resetAt?: string;
  }>> | undefined,
  dropUnallocatedQuotaSnapshots: boolean,
): Readonly<Record<string, RequestQuotaUsageSnapshot>> | undefined {
  if (!snapshots) {
    return undefined;
  }

  const entries = Object.entries(snapshots)
    .map(([key, snapshot]) => {
      if (
        typeof snapshot.entitlement !== 'number'
        || typeof snapshot.remaining !== 'number'
        || typeof snapshot.percentRemaining !== 'number'
      ) {
        return undefined;
      }

      const normalizedSnapshot = {
        entitlement: snapshot.entitlement,
        remaining: snapshot.remaining,
        percentRemaining: snapshot.percentRemaining,
        ...(typeof snapshot.unlimited === 'boolean' ? { unlimited: snapshot.unlimited } : {}),
        ...(typeof snapshot.overageCount === 'number' ? { overageCount: snapshot.overageCount } : {}),
        ...(typeof snapshot.overagePermitted === 'boolean'
          ? { overagePermitted: snapshot.overagePermitted }
          : {}),
        resetAt: typeof snapshot.resetAt === 'string' ? snapshot.resetAt : '',
      } satisfies RequestQuotaUsageSnapshot;

      if (dropUnallocatedQuotaSnapshots && shouldDropUnallocatedQuotaSnapshot(normalizedSnapshot)) {
        return undefined;
      }

      return [key, normalizedSnapshot] as const;
    })
    .filter((entry): entry is readonly [string, RequestQuotaUsageSnapshot] => !!entry);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseQuotaSnapshotHeader(value: string | null): RequestQuotaUsageSnapshot | undefined {
  return parseSnapshotHeader(value, true);
}

function parseRateLimitSnapshotHeader(value: string | null): RequestQuotaUsageSnapshot | undefined {
  return parseSnapshotHeader(value, false);
}

function parseSnapshotHeader(
  value: string | null,
  dropUnallocatedQuotaSnapshots: boolean,
): RequestQuotaUsageSnapshot | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }

    const snapshot = parsed as Partial<RequestQuotaUsageSnapshot>;
    if (
      typeof snapshot.entitlement !== 'number'
      || typeof snapshot.remaining !== 'number'
      || typeof snapshot.percentRemaining !== 'number'
      || typeof snapshot.resetAt !== 'string'
    ) {
      return undefined;
    }

    const normalizedSnapshot = {
      entitlement: snapshot.entitlement,
      remaining: snapshot.remaining,
      percentRemaining: snapshot.percentRemaining,
      ...(typeof snapshot.unlimited === 'boolean' ? { unlimited: snapshot.unlimited } : {}),
      ...(typeof snapshot.overageCount === 'number'
        ? { overageCount: snapshot.overageCount }
        : typeof (parsed as Record<string, unknown>)['overage_count'] === 'number'
          ? { overageCount: (parsed as Record<string, unknown>)['overage_count'] as number }
          : {}),
      ...(typeof snapshot.overagePermitted === 'boolean'
        ? { overagePermitted: snapshot.overagePermitted }
        : typeof (parsed as Record<string, unknown>)['overage_permitted'] === 'boolean'
          ? { overagePermitted: (parsed as Record<string, unknown>)['overage_permitted'] as boolean }
          : {}),
      resetAt: snapshot.resetAt,
    } satisfies RequestQuotaUsageSnapshot;

    if (dropUnallocatedQuotaSnapshots && shouldDropUnallocatedQuotaSnapshot(normalizedSnapshot)) {
      return undefined;
    }

    return normalizedSnapshot;
  } catch {
    return undefined;
  }
}

function normalizeRequestQuotaServiceState(
  state: RequestQuotaServiceState,
): RequestQuotaServiceState {
  return {
    ...state,
    ...(state.quotaSnapshots !== undefined
      ? { quotaSnapshots: normalizeQuotaSnapshotMap(state.quotaSnapshots) }
      : {}),
    ...(state.rateLimitSnapshots !== undefined
      ? { rateLimitSnapshots: normalizeRateLimitSnapshotMap(state.rateLimitSnapshots) }
      : {}),
  };
}

function shouldDropUnallocatedQuotaSnapshot(
  snapshot: RequestQuotaUsageSnapshot,
): boolean {
  return snapshot.unlimited !== true && snapshot.entitlement === 0;
}

function parseBooleanHeader(value: string | null): boolean | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

function hasRequestQuotaState(state: RequestQuotaServiceState): boolean {
  return !!(
    state.updatedAt
    || state.sourceInteractionId
    || Object.keys(state.quotaSnapshots ?? {}).length > 0
    || Object.keys(state.rateLimitSnapshots ?? {}).length > 0
    || typeof state.chatQuotaExceeded === 'boolean'
    || typeof state.rateLimited === 'boolean'
    || typeof state.errorCode === 'string'
    || typeof state.retryAfterMs === 'number'
  );
}

function hasStructuredRequestQuotaState(state: RequestQuotaServiceState): boolean {
  return !!(
    state.updatedAt
    || state.sourceInteractionId
    || Object.keys(state.quotaSnapshots ?? {}).length > 0
    || Object.keys(state.rateLimitSnapshots ?? {}).length > 0
    || typeof state.chatQuotaExceeded === 'boolean'
    || typeof state.rateLimited === 'boolean'
  );
}
