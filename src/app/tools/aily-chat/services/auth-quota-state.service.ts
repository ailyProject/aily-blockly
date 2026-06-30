import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

import { AilyHost } from '../core/host';
import type { AuthSnapshot } from '../core/auth-snapshot';
import {
  createAuthQuotaApproachingInputNotice,
  createAuthQuotaExhaustedInputNoticeFromState,
  createAuthQuotaSnapshotFromState,
  type AuthQuotaSnapshot,
} from './auth-quota-snapshot';
import type { ChatInputNotice } from './chat-input-notice';

const INPUT_NOTICE_THRESHOLDS = [50, 75, 90, 95];

export interface AuthQuotaInfo {
  readonly source: 'auth-me' | 'token' | 'summary';
  readonly usageUnit: 'tokens' | 'interactions';
  readonly quota: number;
  readonly used: number;
  readonly remaining: number;
  readonly percentRemaining: number;
  readonly unlimited?: boolean;
  readonly overageCount?: number;
  readonly overagePermitted?: boolean;
  readonly resetTime?: string;
}

export interface AuthQuotaState {
  readonly plan?: string;
  readonly serviceTier?: string;
  readonly subscriptionStatus?: string;
  readonly subscriptionEndDate?: string;
  readonly quotaInfo?: AuthQuotaInfo;
}

@Injectable({
  providedIn: 'root',
})
export class AuthQuotaStateService {
  private readonly snapshotSubject = new BehaviorSubject<AuthQuotaState | null>(null);
  readonly snapshot$ = this.snapshotSubject.asObservable();
  private readonly quotaInfoSubject = new BehaviorSubject<AuthQuotaInfo | null>(null);
  readonly quotaInfo$ = this.quotaInfoSubject.asObservable();
  private readonly authQuotaSnapshotSubject = new BehaviorSubject<AuthQuotaSnapshot | null>(null);
  readonly authQuotaSnapshot$ = this.authQuotaSnapshotSubject.asObservable();
  private readonly authQuotaInputNoticeSubject = new BehaviorSubject<ChatInputNotice | null>(null);
  readonly authQuotaInputNotice$ = this.authQuotaInputNoticeSubject.asObservable();
  private readonly didChangeSubject = new Subject<void>();
  readonly onDidChange = this.didChangeSubject.asObservable();

  getSnapshot(): AuthQuotaState | null {
    return this.snapshotSubject.getValue();
  }

  getQuotaInfo(): AuthQuotaInfo | null {
    return this.quotaInfoSubject.getValue();
  }

  getAuthQuotaSnapshot(): AuthQuotaSnapshot | null {
    return this.authQuotaSnapshotSubject.getValue();
  }

  getAuthQuotaInputNotice(): ChatInputNotice | null {
    return this.authQuotaInputNoticeSubject.getValue();
  }

  get quotaExhausted(): boolean {
    const quotaInfo = this.getQuotaInfo();
    return isAuthQuotaInfoExhausted(quotaInfo);
  }

  clear(): void {
    this.acceptSnapshot(null);
  }

  handleMessageSubmitted(): void {
    const notice = this.getAuthQuotaInputNotice();
    if (notice?.autoDismissOnMessage) {
      this.authQuotaInputNoticeSubject.next(null);
    }
  }

  acceptAuthSnapshot(authSnapshot: AuthSnapshot | null | undefined): AuthQuotaState | null {
    const snapshot = readAuthQuotaStateSnapshot(authSnapshot);
    const nextSnapshot = hasAuthQuotaState(snapshot) ? snapshot : null;
    this.acceptSnapshot(nextSnapshot);
    return nextSnapshot;
  }

  syncAuthSnapshotFromHost(): AuthQuotaState | null {
    return this.acceptAuthSnapshot(AilyHost.get().auth.getSnapshot?.() ?? null);
  }

  acceptProjectedQuotaInfo(
    quotaInfo: AuthQuotaInfo | null | undefined,
    metadata?: Omit<AuthQuotaState, 'quotaInfo'>,
  ): AuthQuotaState | null {
    if (!quotaInfo) {
      return this.getSnapshot();
    }

    const previous = this.getSnapshot();
    this.acceptSnapshot({
      ...(typeof metadata?.plan === 'string'
        ? { plan: metadata.plan }
        : typeof previous?.plan === 'string'
          ? { plan: previous.plan }
          : {}),
      ...(typeof metadata?.serviceTier === 'string'
        ? { serviceTier: metadata.serviceTier }
        : typeof previous?.serviceTier === 'string'
          ? { serviceTier: previous.serviceTier }
          : {}),
      ...(typeof metadata?.subscriptionStatus === 'string'
        ? { subscriptionStatus: metadata.subscriptionStatus }
        : typeof previous?.subscriptionStatus === 'string'
          ? { subscriptionStatus: previous.subscriptionStatus }
          : {}),
      ...(typeof metadata?.subscriptionEndDate === 'string'
        ? { subscriptionEndDate: metadata.subscriptionEndDate }
        : typeof previous?.subscriptionEndDate === 'string'
          ? { subscriptionEndDate: previous.subscriptionEndDate }
          : {}),
      quotaInfo,
    });
    return this.getSnapshot();
  }

  private acceptSnapshot(snapshot: AuthQuotaState | null): void {
    const previous = this.getSnapshot();
    const nextSnapshot = preserveStableQuotaInfo(previous, snapshot);
    this.snapshotSubject.next(nextSnapshot);
    this.quotaInfoSubject.next(nextSnapshot?.quotaInfo ?? null);
    this.authQuotaSnapshotSubject.next(createAuthQuotaSnapshotFromState(nextSnapshot));
    this.authQuotaInputNoticeSubject.next(this.computeInputNotice(nextSnapshot));

    if (hasAuthQuotaStateChanged(previous, nextSnapshot)) {
      this.didChangeSubject.next();
    }
  }

  private computeInputNotice(snapshot: AuthQuotaState | null): ChatInputNotice | null {
    const exhaustedNotice = createAuthQuotaExhaustedInputNoticeFromState(snapshot);
    if (exhaustedNotice) {
      return exhaustedNotice;
    }

    const quotaInfo = snapshot?.quotaInfo;
    if (!snapshot || !quotaInfo || quotaInfo.quota < 0) {
      return null;
    }

    const percentUsed = 100 - quotaInfo.percentRemaining;
    if (percentUsed < INPUT_NOTICE_THRESHOLDS[0]) {
      return null;
    }

    return createAuthQuotaApproachingInputNotice(snapshot, Math.round(percentUsed));
  }
}

export function readAuthQuotaStateSnapshot(authSnapshot: AuthSnapshot | null | undefined): AuthQuotaState {
  const tokenLikeQuotaInfo = readAuthQuotaInfoFromTokenLikeSnapshot(authSnapshot);
  const summaryQuotaInfo = readAuthQuotaInfoFromSummary(authSnapshot);

  return {
    ...(typeof authSnapshot?.plan === 'string' ? { plan: authSnapshot.plan } : {}),
    ...(typeof authSnapshot?.serviceTier === 'string' ? { serviceTier: authSnapshot.serviceTier } : {}),
    ...(typeof authSnapshot?.subscriptionStatus === 'string'
      ? { subscriptionStatus: authSnapshot.subscriptionStatus }
      : {}),
    ...(typeof authSnapshot?.subscriptionEndDate === 'string'
      ? { subscriptionEndDate: authSnapshot.subscriptionEndDate }
      : {}),
    ...((tokenLikeQuotaInfo ?? summaryQuotaInfo)
      ? { quotaInfo: tokenLikeQuotaInfo ?? summaryQuotaInfo }
      : {}),
  };
}

function readAuthQuotaInfoFromTokenLikeSnapshot(
  authSnapshot: AuthSnapshot | null | undefined,
): AuthQuotaInfo | undefined {
  const quotaSnapshots = authSnapshot?.quotaInfoSnapshot?.quotaSnapshots;
  const quotaSnapshot = quotaSnapshots?.['premium_interactions']
    ?? quotaSnapshots?.['chat'];
  if (!quotaSnapshot) {
    return undefined;
  }

  const quota = quotaSnapshot.entitlement;
  const remaining = quotaSnapshot.remaining;
  const used = quota >= 0
    ? Math.max(0, quota - remaining)
    : 0;

  return {
    source: authSnapshot?.quotaInfoSnapshot?.source ?? 'token',
    usageUnit: 'interactions',
    quota,
    used,
    remaining,
    percentRemaining: Math.max(0, Math.min(100, quotaSnapshot.percentRemaining)),
    ...(typeof quotaSnapshot.unlimited === 'boolean'
      ? { unlimited: quotaSnapshot.unlimited }
      : quota < 0
        ? { unlimited: true }
        : {}),
    overageCount: typeof quotaSnapshot.overageCount === 'number'
      ? quotaSnapshot.overageCount
      : 0,
    overagePermitted: typeof quotaSnapshot.overagePermitted === 'boolean'
      ? quotaSnapshot.overagePermitted
      : false,
    ...(typeof quotaSnapshot.resetDate === 'string'
      ? { resetTime: quotaSnapshot.resetDate }
      : typeof authSnapshot?.quotaInfoSnapshot?.quotaResetDate === 'string'
        ? { resetTime: authSnapshot.quotaInfoSnapshot.quotaResetDate }
        : typeof authSnapshot?.quotaSummary?.resetTime === 'string'
          ? { resetTime: authSnapshot.quotaSummary.resetTime }
          : {}),
  };
}

function readAuthQuotaInfoFromSummary(
  authSnapshot: AuthSnapshot | null | undefined,
): AuthQuotaInfo | undefined {
  const totalToken = authSnapshot?.quotaSummary?.totalToken;
  const usedToken = authSnapshot?.quotaSummary?.usedToken;
  const remainingToken = authSnapshot?.quotaSummary?.remainingToken;
  if (
    typeof totalToken !== 'number'
    || typeof usedToken !== 'number'
    || typeof remainingToken !== 'number'
  ) {
    return undefined;
  }

  return {
    source: 'summary',
    usageUnit: 'tokens',
    quota: totalToken,
    used: usedToken,
    remaining: remainingToken,
    percentRemaining: totalToken > 0
      ? Math.max(0, Math.min(100, (remainingToken / totalToken) * 100))
      : 0,
    ...(totalToken < 0 ? { unlimited: true } : {}),
    ...(typeof authSnapshot?.quotaSummary?.resetTime === 'string'
      ? { resetTime: authSnapshot.quotaSummary.resetTime }
      : {}),
  };
}

export function isAuthQuotaInfoExhausted(
  quotaInfo: AuthQuotaInfo | null | undefined,
): boolean {
  if (!quotaInfo) {
    return false;
  }

  const unlimited = quotaInfo.unlimited === true || quotaInfo.quota < 0;
  if (unlimited) {
    return false;
  }

  return quotaInfo.used >= quotaInfo.quota && quotaInfo.overagePermitted !== true;
}

function hasAuthQuotaState(snapshot: AuthQuotaState): boolean {
  return typeof snapshot.plan === 'string'
    || typeof snapshot.serviceTier === 'string'
    || typeof snapshot.subscriptionStatus === 'string'
    || typeof snapshot.subscriptionEndDate === 'string'
    || !!snapshot.quotaInfo;
}

function hasAuthQuotaStateChanged(
  previous: AuthQuotaState | null,
  current: AuthQuotaState | null,
): boolean {
  return previous?.plan !== current?.plan
    || previous?.serviceTier !== current?.serviceTier
    || previous?.subscriptionStatus !== current?.subscriptionStatus
    || previous?.subscriptionEndDate !== current?.subscriptionEndDate
    || previous?.quotaInfo?.source !== current?.quotaInfo?.source
    || previous?.quotaInfo?.usageUnit !== current?.quotaInfo?.usageUnit
    || previous?.quotaInfo?.quota !== current?.quotaInfo?.quota
    || previous?.quotaInfo?.used !== current?.quotaInfo?.used
    || previous?.quotaInfo?.remaining !== current?.quotaInfo?.remaining
    || previous?.quotaInfo?.percentRemaining !== current?.quotaInfo?.percentRemaining
    || previous?.quotaInfo?.unlimited !== current?.quotaInfo?.unlimited
    || previous?.quotaInfo?.overageCount !== current?.quotaInfo?.overageCount
    || previous?.quotaInfo?.overagePermitted !== current?.quotaInfo?.overagePermitted
    || previous?.quotaInfo?.resetTime !== current?.quotaInfo?.resetTime;
}

function preserveStableQuotaInfo(
  previous: AuthQuotaState | null,
  current: AuthQuotaState | null,
): AuthQuotaState | null {
  if (!current || !shouldPreservePreviousQuotaInfo(previous, current)) {
    return current;
  }

  return {
    ...current,
    quotaInfo: previous!.quotaInfo,
  };
}

function shouldPreservePreviousQuotaInfo(
  previous: AuthQuotaState | null,
  current: AuthQuotaState,
): previous is AuthQuotaState & { quotaInfo: AuthQuotaInfo } {
  const previousQuotaInfo = previous?.quotaInfo;
  const currentQuotaInfo = current.quotaInfo;

  return !!previousQuotaInfo
    && previousQuotaInfo.source !== 'summary'
    && (!currentQuotaInfo || currentQuotaInfo.source === 'summary')
    && previous?.serviceTier === current.serviceTier
    && previous?.subscriptionStatus === current.subscriptionStatus
    && previous?.subscriptionEndDate === current.subscriptionEndDate;
}