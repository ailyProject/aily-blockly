import type { AuthSnapshot } from './auth-snapshot';

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

/** Projects the host-owned auth snapshot into the quota shape used by product UI. */
export function projectAuthQuotaInfo(
  authSnapshot: AuthSnapshot | null | undefined,
): AuthQuotaInfo | null {
  const quotaSnapshots = authSnapshot?.quotaInfoSnapshot?.quotaSnapshots;
  const quotaSnapshot = quotaSnapshots?.['premium_interactions']
    ?? quotaSnapshots?.['chat'];
  if (quotaSnapshot) {
    const quota = quotaSnapshot.entitlement;
    const remaining = quotaSnapshot.remaining;
    return {
      source: authSnapshot?.quotaInfoSnapshot?.source ?? 'token',
      usageUnit: 'interactions',
      quota,
      used: quota >= 0 ? Math.max(0, quota - remaining) : 0,
      remaining,
      percentRemaining: clampPercent(quotaSnapshot.percentRemaining),
      unlimited: quotaSnapshot.unlimited === true || quota < 0,
      overageCount: quotaSnapshot.overageCount ?? 0,
      overagePermitted: quotaSnapshot.overagePermitted ?? false,
      ...(quotaSnapshot.resetDate
        ? { resetTime: quotaSnapshot.resetDate }
        : authSnapshot?.quotaInfoSnapshot?.quotaResetDate
          ? { resetTime: authSnapshot.quotaInfoSnapshot.quotaResetDate }
          : authSnapshot?.quotaSummary?.resetTime
            ? { resetTime: authSnapshot.quotaSummary.resetTime }
            : {}),
    };
  }

  const summary = authSnapshot?.quotaSummary;
  if (
    typeof summary?.totalToken !== 'number'
    || typeof summary.usedToken !== 'number'
    || typeof summary.remainingToken !== 'number'
  ) {
    return null;
  }
  return {
    source: 'summary',
    usageUnit: 'tokens',
    quota: summary.totalToken,
    used: summary.usedToken,
    remaining: summary.remainingToken,
    percentRemaining: summary.totalToken > 0
      ? clampPercent((summary.remainingToken / summary.totalToken) * 100)
      : 0,
    ...(summary.totalToken < 0 ? { unlimited: true } : {}),
    ...(summary.resetTime ? { resetTime: summary.resetTime } : {}),
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
