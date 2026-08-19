import type {
  AuthQuotaInfoSnapshotItem,
  AuthSnapshot,
  AuthUserInfo,
} from '../aily-chat/core/auth-snapshot';

export interface ChildAuthUserIdentity {
  readonly id?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly login?: string;
}

export interface ChildAuthQuotaUsageSnapshot {
  readonly entitlement?: number;
  readonly remaining: number;
  readonly percentRemaining?: number;
  readonly unlimited?: boolean;
  readonly overageCount?: number;
  readonly overagePermitted?: boolean;
  readonly resetAt?: string;
}

export interface ChildAuthStateSnapshot {
  readonly authenticated: boolean;
  readonly user?: ChildAuthUserIdentity;
  readonly quotaSnapshot?: {
    readonly quotaSnapshots: Readonly<Record<string, ChildAuthQuotaUsageSnapshot>>;
  };
}

/**
 * Build the small, token-free auth payload exposed to child applications.
 * The main process has already hydrated this data, so forwarding it must not
 * add another request to the child-frame startup path.
 */
export function buildChildAuthStateSnapshot(
  authenticated: boolean,
  user: AuthUserInfo | null | undefined,
  authSnapshot: AuthSnapshot | null | undefined,
): ChildAuthStateSnapshot {
  if (!authenticated) {
    return { authenticated: false };
  }

  const identity = pickChildAuthUserIdentity(user);
  const quotaSnapshots = buildChildQuotaSnapshots(authSnapshot);

  return {
    authenticated: true,
    ...(identity ? { user: identity } : {}),
    ...(quotaSnapshots ? { quotaSnapshot: { quotaSnapshots } } : {}),
  };
}

function pickChildAuthUserIdentity(user: AuthUserInfo | null | undefined): ChildAuthUserIdentity | undefined {
  if (!user) return undefined;

  const identity: ChildAuthUserIdentity = {
    ...pickNonEmptyString(user, 'id'),
    ...pickNonEmptyString(user, 'email'),
    ...pickNonEmptyString(user, 'phone'),
    ...pickNonEmptyString(user, 'login'),
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function buildChildQuotaSnapshots(
  authSnapshot: AuthSnapshot | null | undefined,
): Readonly<Record<string, ChildAuthQuotaUsageSnapshot>> | undefined {
  const resetAt = authSnapshot?.quotaInfoSnapshot?.quotaResetDate
    ?? authSnapshot?.quotaSummary?.resetTime;
  const quotaSnapshots = Object.fromEntries(
    Object.entries(authSnapshot?.quotaInfoSnapshot?.quotaSnapshots ?? {})
      .map(([key, snapshot]) => [key, toChildQuotaUsageSnapshot(snapshot, resetAt)] as const),
  );

  // The main software's legacy endpoint names the general chat bucket `chat`,
  // while the current child quota contract calls the same bucket `chat_monthly`.
  if (!quotaSnapshots['chat_monthly'] && quotaSnapshots['chat']) {
    quotaSnapshots['chat_monthly'] = { ...quotaSnapshots['chat'] };
  }

  if (Object.keys(quotaSnapshots).length > 0) {
    return quotaSnapshots;
  }

  const summary = authSnapshot?.quotaSummary;
  if (!summary) return undefined;

  return {
    chat_monthly: {
      entitlement: summary.totalToken,
      remaining: summary.remainingToken,
      percentRemaining: summary.totalToken > 0
        ? Math.max(0, Math.min(100, (summary.remainingToken / summary.totalToken) * 100))
        : 0,
      ...(summary.totalToken < 0 ? { unlimited: true } : {}),
      ...(summary.resetTime ? { resetAt: summary.resetTime } : {}),
    },
  };
}

function toChildQuotaUsageSnapshot(
  snapshot: AuthQuotaInfoSnapshotItem,
  fallbackResetAt?: string,
): ChildAuthQuotaUsageSnapshot {
  return {
    entitlement: snapshot.entitlement,
    remaining: snapshot.remaining,
    percentRemaining: snapshot.percentRemaining,
    ...(typeof snapshot.unlimited === 'boolean' ? { unlimited: snapshot.unlimited } : {}),
    ...(typeof snapshot.overageCount === 'number' ? { overageCount: snapshot.overageCount } : {}),
    ...(typeof snapshot.overagePermitted === 'boolean'
      ? { overagePermitted: snapshot.overagePermitted }
      : {}),
    ...(snapshot.resetDate || fallbackResetAt ? { resetAt: snapshot.resetDate ?? fallbackResetAt } : {}),
  };
}

function pickNonEmptyString<K extends keyof ChildAuthUserIdentity>(
  user: AuthUserInfo,
  key: K,
): Pick<ChildAuthUserIdentity, K> | Record<string, never> {
  const value = user[key];
  return typeof value === 'string' && value.trim() ? { [key]: value.trim() } as Pick<ChildAuthUserIdentity, K> : {};
}
