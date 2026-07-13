import type { TurnResponseQuotaSnapshot, TurnResponseTurn } from 'aily-lex/browser';

import type { RequestQuotaServiceState, RequestQuotaUsageSnapshot } from './request-quota-state.service';
import { appendQuotaResetLabel, formatQuotaResetLabel } from './chat-quota-reset-label';
import type { ChatInputNotice } from './chat-input-notice';

export type RequestQuotaSeverity = 'warning' | 'danger';

export interface RequestQuotaDisplayQuota {
  readonly kind: 'monthly' | 'daily' | 'session' | 'weekly' | 'burst' | 'premium_models' | 'premium_interactions';
  readonly errorCode?: string;
  readonly retryAfterMs?: number;
  readonly resetAt?: string;
}

export interface RequestQuotaSnapshot {
  readonly label: string;
  readonly badgeText: string;
  readonly severity: RequestQuotaSeverity;
  readonly statusText: string;
  readonly detailText?: string;
  readonly quota: RequestQuotaDisplayQuota;
}

export function createRequestRateLimitInputNotice(
  type: 'session' | 'weekly',
  percentUsed: number,
  resetAt?: string,
): ChatInputNotice {
  return {
    id: `request-quota:rate-limit:${type}`,
    source: 'request-quota',
    kind: 'rate-limit',
    title: type === 'session'
      ? `You've used ${percentUsed}% of your session rate limit.`
      : `You've used ${percentUsed}% of your weekly rate limit.`,
    subtitle: buildRateLimitNoticeSubtitle(type, resetAt),
    tone: 'info',
    iconClass: 'fa-light fa-circle-info',
    autoDismissOnMessage: true,
  };
}

export function createRequestQuotaInputNotice(
  snapshot: RequestQuotaSnapshot | null,
): ChatInputNotice | null {
  if (!snapshot) {
    return null;
  }

  const normalizedErrorCode = normalizeRequestQuotaErrorCode(snapshot.quota.errorCode);
  const exhausted = snapshot.severity === 'danger';
  return {
    id: exhausted
      ? `request-quota:exhausted:${normalizedErrorCode ?? snapshot.quota.kind}`
      : `request-quota:rate-limit:${normalizedErrorCode ?? snapshot.quota.kind}`,
    source: 'request-quota',
    kind: exhausted ? 'exhausted' : 'rate-limit',
    title: exhausted
      ? buildRequestQuotaExceededNoticeTitle(snapshot.quota, normalizedErrorCode)
      : buildRequestRateLimitedNoticeTitle(snapshot.quota, normalizedErrorCode),
    subtitle: exhausted
      ? buildRequestQuotaExceededNoticeSubtitle(snapshot.quota, normalizedErrorCode)
      : buildRequestRateLimitedNoticeSubtitle(snapshot.quota, normalizedErrorCode),
    tone: exhausted ? 'error' : 'warning',
    iconClass: exhausted ? 'fa-light fa-triangle-exclamation' : 'fa-light fa-hourglass-clock',
  };
}

type RequestQuotaComparableSnapshot = {
  readonly entitlement?: number;
  readonly remaining: number;
  readonly unlimited?: boolean;
  readonly overagePermitted?: boolean;
  readonly resetAt?: string;
};

export function createRequestQuotaSnapshot(
  turns: readonly TurnResponseTurn[] | null | undefined,
): RequestQuotaSnapshot | null {
  const quota = findLatestRequestQuotaSnapshot(turns ?? []);
  if (!quota) {
    return null;
  }

  return buildRequestQuotaSnapshot(quota);
}

export function createRequestQuotaSnapshotFromServiceState(
  serviceState: RequestQuotaServiceState | null,
): RequestQuotaSnapshot | null {
  const serviceQuota = findServiceQuotaSnapshot(serviceState);
  return serviceQuota ? buildRequestQuotaSnapshot(serviceQuota) : null;
}

function buildRequestQuotaSnapshot(quota: RequestQuotaDisplayQuota): RequestQuotaSnapshot {
  const normalizedErrorCode = normalizeRequestQuotaErrorCode(quota.errorCode);
  const severity: RequestQuotaSeverity = quota.kind === 'monthly'
    || quota.kind === 'daily'
    || quota.kind === 'premium_models'
    || quota.kind === 'premium_interactions'
    ? 'danger'
    : 'warning';

  return {
    label: 'Quota',
    badgeText: quota.kind === 'monthly'
      || quota.kind === 'daily'
      || quota.kind === 'premium_models'
      || quota.kind === 'premium_interactions'
      ? 'Blocked'
      : 'Wait',
    severity,
    statusText: getStatusText(quota, normalizedErrorCode),
    detailText: getDetailText(quota, normalizedErrorCode),
    quota,
  };
}

function findLatestRequestQuotaSnapshot(
  turns: readonly TurnResponseTurn[],
): RequestQuotaDisplayQuota | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const quotaSnapshot = turns[index]?.responseModel?.quotaSnapshot;
    if (quotaSnapshot) {
      return toDisplayQuotaFromTurnSidecar(quotaSnapshot);
    }
  }

  return null;
}

function toDisplayQuotaFromTurnSidecar(quotaSnapshot: TurnResponseQuotaSnapshot): RequestQuotaDisplayQuota {
  const premiumModels = quotaSnapshot.quotaSnapshots?.['premium_models'];
  if (isAllocatedExhaustedQuota(premiumModels)) {
    return { kind: 'premium_models', errorCode: quotaSnapshot.errorCode, resetAt: premiumModels?.resetAt };
  }

  const premiumInteractions = quotaSnapshot.quotaSnapshots?.['premium_interactions'];
  if (isAllocatedExhaustedQuota(premiumInteractions)) {
    return { kind: 'premium_interactions', errorCode: quotaSnapshot.errorCode, resetAt: premiumInteractions?.resetAt };
  }

  const monthly = quotaSnapshot.quotaSnapshots?.['chat_monthly'];
  if (isAllocatedExhaustedQuota(monthly)) {
    return { kind: 'monthly', errorCode: quotaSnapshot.errorCode, resetAt: monthly?.resetAt };
  }

  const daily = quotaSnapshot.quotaSnapshots?.['daily_interactions'];
  if (isAllocatedExhaustedQuota(daily)) {
    return { kind: 'daily', errorCode: quotaSnapshot.errorCode, resetAt: daily?.resetAt };
  }

  const session = quotaSnapshot.rateLimitSnapshots?.['session'];
  if (isExhausted(session)) {
    return {
      kind: 'session',
      errorCode: quotaSnapshot.errorCode,
      retryAfterMs: getRetryAfterMs(session.resetAt),
      resetAt: session.resetAt,
    };
  }

  const weekly = quotaSnapshot.rateLimitSnapshots?.['weekly'];
  if (isExhausted(weekly)) {
    return {
      kind: 'weekly',
      errorCode: quotaSnapshot.errorCode,
      retryAfterMs: getRetryAfterMs(weekly.resetAt),
      resetAt: weekly.resetAt,
    };
  }

  const burst = quotaSnapshot.rateLimitSnapshots?.['burst_10m'];
  const extended = quotaSnapshot as TurnResponseQuotaSnapshot & {
    rateLimited?: boolean;
    retryAfterMs?: number;
  };
  if (isExhausted(burst) || extended.rateLimited === true) {
    return {
      kind: 'burst',
      errorCode: quotaSnapshot.errorCode,
      retryAfterMs: typeof extended.retryAfterMs === 'number'
        ? extended.retryAfterMs
        : getRetryAfterMs(burst?.resetAt),
      resetAt: burst?.resetAt,
    };
  }

  return buildCodeOnlyDisplayQuotaFromTurnSidecar(quotaSnapshot);
}

function buildCodeOnlyDisplayQuotaFromTurnSidecar(
  quotaSnapshot: TurnResponseQuotaSnapshot,
): RequestQuotaDisplayQuota | null {
  const extended = quotaSnapshot as TurnResponseQuotaSnapshot & {
    chatQuotaExceeded?: boolean;
    rateLimited?: boolean;
    retryAfterMs?: number;
  };
  const retryAfterMs = typeof extended.retryAfterMs === 'number'
    ? extended.retryAfterMs
    : undefined;
  const normalizedErrorCode = normalizeRequestQuotaErrorCode(quotaSnapshot.errorCode);
  if (!normalizedErrorCode && extended.chatQuotaExceeded !== true && extended.rateLimited !== true) {
    return null;
  }

  switch (quotaSnapshot.kind) {
    case 'premium_models':
      return { kind: 'premium_models', errorCode: quotaSnapshot.errorCode };
    case 'premium_interactions':
      return { kind: 'premium_interactions', errorCode: quotaSnapshot.errorCode };
    case 'monthly':
      return { kind: 'monthly', errorCode: quotaSnapshot.errorCode };
    case 'daily':
      return { kind: 'daily', errorCode: quotaSnapshot.errorCode };
    case 'session':
      return { kind: 'session', errorCode: quotaSnapshot.errorCode, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    case 'weekly':
      return { kind: 'weekly', errorCode: quotaSnapshot.errorCode, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    case 'burst':
      return { kind: 'burst', errorCode: quotaSnapshot.errorCode, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    default:
      break;
  }

  switch (normalizedErrorCode) {
    case 'billing_not_configured':
    case 'overage_limit_reached':
    case 'premium_model_quota_exceeded':
      return { kind: 'premium_models', errorCode: quotaSnapshot.errorCode };
    case 'interaction_monthly_quota_exceeded':
    case 'quota_exceeded':
    case 'free_quota_exceeded':
      return { kind: 'monthly', errorCode: quotaSnapshot.errorCode };
    case 'interaction_daily_limit_exceeded':
      return { kind: 'daily', errorCode: quotaSnapshot.errorCode };
    case 'interaction_session_rate_limited':
    case 'user_global_rate_limited':
    case 'user_model_rate_limited':
      return { kind: 'session', errorCode: quotaSnapshot.errorCode, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    case 'interaction_weekly_rate_limited':
      return { kind: 'weekly', errorCode: quotaSnapshot.errorCode, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    case 'interaction_burst_rate_limited':
    case 'agent_mode_limit_exceeded':
    case 'integration_rate_limited':
    case 'model_overloaded':
    case 'upstream_provider_rate_limit':
      return { kind: 'burst', errorCode: quotaSnapshot.errorCode, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    default:
      return null;
  }
}

function findServiceQuotaSnapshot(serviceState: RequestQuotaServiceState | null): RequestQuotaDisplayQuota | null {
  if (!serviceState) {
    return null;
  }

  const quotaSnapshots = serviceState.quotaSnapshots ?? {};
  const premiumModels = quotaSnapshots['premium_models'];
  if (isAllocatedExhaustedQuota(premiumModels)) {
    return {
      kind: 'premium_models',
      ...(typeof serviceState.errorCode === 'string' ? { errorCode: serviceState.errorCode } : {}),
      resetAt: premiumModels?.resetAt,
    };
  }

  const premiumInteractions = quotaSnapshots['premium_interactions'];
  if (isAllocatedExhaustedQuota(premiumInteractions)) {
    return {
      kind: 'premium_interactions',
      ...(typeof serviceState.errorCode === 'string' ? { errorCode: serviceState.errorCode } : {}),
      resetAt: premiumInteractions?.resetAt,
    };
  }

  const monthly = quotaSnapshots['chat_monthly'];
  if (isAllocatedExhaustedQuota(monthly)) {
    return {
      kind: 'monthly',
      ...(typeof serviceState.errorCode === 'string' ? { errorCode: serviceState.errorCode } : {}),
      resetAt: monthly?.resetAt,
    };
  }

  const daily = quotaSnapshots['daily_interactions'];
  if (isAllocatedExhaustedQuota(daily)) {
    return {
      kind: 'daily',
      ...(typeof serviceState.errorCode === 'string' ? { errorCode: serviceState.errorCode } : {}),
      resetAt: daily?.resetAt,
    };
  }

  if (serviceState.chatQuotaExceeded) {
    const exhaustedQuota = Object.entries(quotaSnapshots).find(([, snapshot]) => isAllocatedExhaustedQuota(snapshot));
    if (exhaustedQuota) {
      return { kind: quotaSnapshotKeyToDisplayKind(exhaustedQuota[0]) };
    }
  }

  const session = serviceState.rateLimitSnapshots?.['session'];
  if (isExhausted(session)) {
    return {
      kind: 'session',
      ...(typeof serviceState.errorCode === 'string' ? { errorCode: serviceState.errorCode } : {}),
      retryAfterMs: serviceState.retryAfterMs ?? getRetryAfterMs(session?.resetAt),
      resetAt: session?.resetAt,
    };
  }

  const weekly = serviceState.rateLimitSnapshots?.['weekly'];
  if (isExhausted(weekly)) {
    return {
      kind: 'weekly',
      ...(typeof serviceState.errorCode === 'string' ? { errorCode: serviceState.errorCode } : {}),
      retryAfterMs: serviceState.retryAfterMs ?? getRetryAfterMs(weekly?.resetAt),
      resetAt: weekly?.resetAt,
    };
  }

  const burst = serviceState.rateLimitSnapshots?.['burst_10m'];
  if (isExhausted(burst) || serviceState.rateLimited) {
    return {
      kind: 'burst',
      ...(typeof serviceState.errorCode === 'string' ? { errorCode: serviceState.errorCode } : {}),
      retryAfterMs: serviceState.retryAfterMs ?? getRetryAfterMs(burst?.resetAt),
      resetAt: burst?.resetAt,
    };
  }

  return null;
}

function isExhausted(snapshot: RequestQuotaComparableSnapshot | undefined): boolean {
  return !!snapshot
    && snapshot.unlimited !== true
    && snapshot.overagePermitted !== true
    && snapshot.remaining === 0;
}

function isAllocatedExhaustedQuota(snapshot: RequestQuotaComparableSnapshot | undefined): boolean {
  return isExhausted(snapshot)
    && (snapshot?.unlimited === true || typeof snapshot?.entitlement !== 'number' || snapshot.entitlement > 0);
}

function getRetryAfterMs(resetAt: string | undefined): number | undefined {
  if (!resetAt) {
    return undefined;
  }

  const resetAtMs = Date.parse(resetAt);
  if (!Number.isFinite(resetAtMs)) {
    return undefined;
  }

  return Math.max(0, resetAtMs - Date.now());
}

function getStatusText(
  quota: RequestQuotaDisplayQuota,
  normalizedErrorCode: string | undefined,
): string {
  switch (normalizedErrorCode) {
    case 'billing_not_configured':
      return 'Premium billing is not configured';
    case 'overage_limit_reached':
      return 'Premium overage limit reached';
  }

  switch (quota.kind) {
    case 'premium_models':
      return 'Premium model quota exceeded';
    case 'premium_interactions':
      return 'Premium interactions quota exceeded';
    case 'monthly':
      return 'Monthly quota exceeded';
    case 'daily':
      return 'Daily limit exceeded';
    case 'session':
      return 'Session rate limited';
    case 'weekly':
      return 'Weekly rate limited';
    case 'burst':
      return 'Burst rate limited';
  }
}

function quotaSnapshotKeyToDisplayKind(
  key: string,
): RequestQuotaDisplayQuota['kind'] {
  switch (key) {
    case 'premium_models':
      return 'premium_models';
    case 'premium_interactions':
      return 'premium_interactions';
    case 'daily_interactions':
      return 'daily';
    case 'chat_monthly':
    default:
      return 'monthly';
  }
}

function getDetailText(
  quota: RequestQuotaDisplayQuota,
  normalizedErrorCode: string | undefined,
): string | undefined {
  switch (normalizedErrorCode) {
    case 'billing_not_configured':
      return 'Premium requests require billing before you can continue.';
    case 'overage_limit_reached':
      return appendQuotaResetLabel('Additional premium requests are unavailable right now.', quota.resetAt);
    case 'premium_model_quota_exceeded':
      return appendQuotaResetLabel('Premium model quota is exhausted for the current period.', quota.resetAt);
  }

  switch (quota.kind) {
    case 'premium_models':
    case 'premium_interactions':
    case 'monthly':
    case 'daily':
      return buildRequestQuotaExceededNoticeSubtitle(quota, normalizedErrorCode);
    case 'session':
    case 'weekly':
    case 'burst':
      return buildRequestRateLimitedNoticeSubtitle(quota, normalizedErrorCode);
    default:
      return undefined;
  }
}

function buildRateLimitNoticeSubtitle(
  type: 'session' | 'weekly',
  resetAt: string | undefined,
): string {
  if (!resetAt) {
    return type === 'session'
      ? 'You are nearing the current session rate limit.'
      : 'You are nearing the current weekly rate limit.';
  }

  const resetAtMs = Date.parse(resetAt);
  if (!Number.isFinite(resetAtMs)) {
    return `Resets ${resetAt}.`;
  }

  const resetDate = new Date(resetAtMs);
  const now = new Date();
  const includeYear = resetDate.getFullYear() !== now.getFullYear();
  const formatted = new Intl.DateTimeFormat(undefined, includeYear
    ? { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  ).format(resetDate);
  return `Resets on ${formatted}.`;
}

function normalizeRequestQuotaErrorCode(errorCode: string | undefined): string | undefined {
  if (!errorCode) {
    return undefined;
  }

  const normalized = errorCode.split(':')[0]?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function buildRequestQuotaExceededNoticeTitle(
  quota: RequestQuotaDisplayQuota,
  normalizedErrorCode: string | undefined,
): string {
  switch (normalizedErrorCode) {
    case 'billing_not_configured':
      return 'Premium billing is not configured.';
    case 'overage_limit_reached':
      return 'Additional premium requests are unavailable.';
    case 'premium_model_quota_exceeded':
      return "You've reached your premium model quota.";
    case 'quota_exceeded':
    case 'free_quota_exceeded':
    case 'interaction_monthly_quota_exceeded':
      return "You've reached your monthly interaction quota.";
    case 'interaction_daily_limit_exceeded':
      return "You've reached your daily interaction limit.";
    default:
      switch (quota.kind) {
        case 'premium_models':
          return "You've reached your premium model quota.";
        case 'premium_interactions':
          return "You've reached your premium interactions quota.";
        case 'daily':
          return "You've reached your daily interaction limit.";
        case 'monthly':
        default:
          return "You've reached your monthly interaction quota.";
      }
  }
}

function buildRequestQuotaExceededNoticeSubtitle(
  quota: RequestQuotaDisplayQuota,
  normalizedErrorCode: string | undefined,
): string {
  switch (normalizedErrorCode) {
    case 'billing_not_configured':
      return 'Premium requests require billing before you can continue.';
    case 'overage_limit_reached':
      return appendQuotaResetLabel('You cannot accrue additional premium requests right now.', quota.resetAt);
    case 'premium_model_quota_exceeded':
      return appendQuotaResetLabel('Try again after your premium model quota resets.', quota.resetAt);
    case 'interaction_daily_limit_exceeded':
      return appendQuotaResetLabel('Try again after your daily limit resets.', quota.resetAt);
    case 'quota_exceeded':
    case 'free_quota_exceeded':
    case 'interaction_monthly_quota_exceeded':
      return appendQuotaResetLabel('Try again after your monthly quota resets.', quota.resetAt);
    default:
      switch (quota.kind) {
        case 'premium_models':
          return appendQuotaResetLabel('Try again after your premium model quota resets.', quota.resetAt);
        case 'premium_interactions':
          return appendQuotaResetLabel('Try again after your premium interactions quota resets.', quota.resetAt);
        case 'daily':
          return appendQuotaResetLabel('Try again after your daily limit resets.', quota.resetAt);
        case 'monthly':
        default:
          return appendQuotaResetLabel('Try again after your monthly quota resets.', quota.resetAt);
      }
  }
}

function buildRequestRateLimitedNoticeTitle(
  quota: RequestQuotaDisplayQuota,
  normalizedErrorCode: string | undefined,
): string {
  switch (normalizedErrorCode) {
    case 'agent_mode_limit_exceeded':
      return "You've reached the current agent mode rate limit.";
    case 'user_global_rate_limited':
      return "You've hit your session rate limit.";
    case 'user_model_rate_limited':
      return "You've hit the rate limit for this model.";
    case 'integration_rate_limited':
      return 'The service is currently experiencing high demand.';
    case 'model_overloaded':
    case 'upstream_provider_rate_limit':
      return 'The upstream model provider is currently experiencing high demand.';
    default:
      switch (quota.kind) {
        case 'session':
          return "You've hit your session rate limit.";
        case 'weekly':
          return "You've reached your weekly rate limit.";
        case 'burst':
        default:
          return 'You are sending requests too quickly.';
      }
  }
}

function buildRequestRateLimitedNoticeSubtitle(
  quota: RequestQuotaDisplayQuota,
  normalizedErrorCode: string | undefined,
): string {
  const resetLabel = formatQuotaResetLabel(quota.resetAt);
  const retryAfter = getRetryAfterSubtitle(quota.retryAfterMs);
  if (retryAfter && resetLabel) {
    return `${retryAfter} ${resetLabel}`;
  }
  const fallback = getRequestRateLimitedFallbackSubtitle(quota, normalizedErrorCode);
  if (resetLabel) {
    return `${fallback} ${resetLabel}`;
  }
  if (retryAfter) {
    return retryAfter;
  }

  return fallback;
}

function getRequestRateLimitedFallbackSubtitle(
  quota: RequestQuotaDisplayQuota,
  normalizedErrorCode: string | undefined,
): string {
  switch (normalizedErrorCode) {
    case 'agent_mode_limit_exceeded':
      return 'Please wait for the agent mode limit to reset before trying again.';
    case 'user_global_rate_limited':
      return 'Please wait for your session rate limit to reset before trying again.';
    case 'user_model_rate_limited':
      return 'Please wait for this model rate limit to reset before trying again.';
    case 'integration_rate_limited':
    case 'model_overloaded':
    case 'upstream_provider_rate_limit':
      return 'Please wait a moment and try again.';
    default:
      switch (quota.kind) {
        case 'session':
          return 'Please wait for your session rate limit to reset before trying again.';
        case 'weekly':
          return 'Please wait for your weekly rate limit to reset before trying again.';
        case 'burst':
        default:
          return 'Please wait a moment before trying again.';
      }
  }
}

function getRetryAfterSubtitle(retryAfterMs: number | undefined): string | undefined {
  if (typeof retryAfterMs !== 'number' || retryAfterMs <= 0) {
    return undefined;
  }

  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `Try again in about ${seconds}s.`;
}
