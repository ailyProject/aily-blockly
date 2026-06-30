import {
  isAuthQuotaInfoExhausted,
  type AuthQuotaInfo,
  type AuthQuotaState,
} from './auth-quota-state.service';
import { appendQuotaResetLabel, formatQuotaResetLabel, trimQuotaResetLabel } from './chat-quota-reset-label';
import type { ChatInputNotice } from './chat-input-notice';

export type AuthQuotaSeverity = 'warning' | 'danger';

export interface AuthQuotaSnapshot {
  readonly label: string;
  readonly badgeText: string;
  readonly severity?: AuthQuotaSeverity;
  readonly statusText: string;
  readonly detailText?: string;
}

export function createAuthQuotaSnapshotFromState(
  serviceState: AuthQuotaState | null,
): AuthQuotaSnapshot | null {
  if (!serviceState) {
    return null;
  }

  const planLabel = serviceState.serviceTier || serviceState.plan || 'Plan';
  const quotaInfo = serviceState.quotaInfo;
  if (quotaInfo) {
    return buildQuotaInfoSnapshot(planLabel, quotaInfo);
  }

  return null;
}

function buildQuotaInfoSnapshot(
  planLabel: string,
  quotaInfo: AuthQuotaInfo,
): AuthQuotaSnapshot {
  const unlimited = quotaInfo.unlimited === true || quotaInfo.quota < 0;
  const exhausted = isAuthQuotaInfoExhausted(quotaInfo);
  const severity = unlimited
    ? undefined
    : exhausted
      ? 'danger'
      : quotaInfo.percentRemaining <= 20
        ? 'warning'
        : undefined;

  return {
    label: planLabel,
    badgeText: unlimited ? 'Unlimited' : `${Math.round(quotaInfo.percentRemaining)}%`,
    severity,
    statusText: unlimited
      ? buildUnlimitedStatusText(planLabel, quotaInfo)
      : `${quotaInfo.remaining} / ${quotaInfo.quota} ${getQuotaUsageLabel(quotaInfo)} remaining.`,
    detailText: buildDetailText(quotaInfo),
  };
}

function getQuotaUsageLabel(quotaInfo: AuthQuotaInfo): string {
  return quotaInfo.usageUnit === 'interactions'
    ? 'effective submissions'
    : 'tokens';
}

function buildUnlimitedStatusText(
  planLabel: string,
  quotaInfo: AuthQuotaInfo,
): string {
  return quotaInfo.usageUnit === 'interactions'
    ? `${planLabel} includes unlimited effective submissions.`
    : `${planLabel} includes unlimited usage.`;
}

export function createAuthQuotaExhaustedInputNoticeFromState(
  serviceState: AuthQuotaState | null,
): ChatInputNotice | null {
  const quotaInfo = serviceState?.quotaInfo;
  if (!serviceState || !quotaInfo || !isAuthQuotaInfoExhausted(quotaInfo)) {
    return null;
  }

  return {
    id: 'auth-quota:exhausted',
    source: 'auth-quota',
    kind: 'exhausted',
    title: "You've reached your monthly quota.",
    subtitle: buildExhaustedSubtitle(quotaInfo),
    tone: 'info',
    iconClass: 'fa-light fa-circle-info',
    actionLabel: 'View Usage',
  };
}

export function createAuthQuotaApproachingInputNotice(
  serviceState: AuthQuotaState,
  percentUsed: number,
): ChatInputNotice {
  const quotaInfo = serviceState.quotaInfo;
  return {
    id: 'auth-quota:approaching',
    source: 'auth-quota',
    kind: 'approaching',
    title: `You've used ${percentUsed}% of your monthly quota.`,
    subtitle: buildApproachingSubtitle(quotaInfo),
    tone: 'info',
    iconClass: 'fa-light fa-gauge-simple-high',
    actionLabel: 'View Usage',
    autoDismissOnMessage: true,
  };
}

function buildDetailText(
  quotaInfo: AuthQuotaInfo,
): string | undefined {
  const resetLabel = trimQuotaResetLabel(formatQuotaResetLabel(quotaInfo.resetTime));
  return resetLabel ? `${resetLabel}.` : undefined;
}

function buildExhaustedSubtitle(
  quotaInfo: AuthQuotaInfo,
): string {
  return appendQuotaResetLabel(
    quotaInfo.usageUnit === 'interactions'
      ? 'Your monthly effective submission quota is exhausted.'
      : 'Your monthly chat quota is exhausted.',
    quotaInfo.resetTime,
  );
}

function buildApproachingSubtitle(
  quotaInfo: AuthQuotaInfo | undefined,
): string {
  return quotaInfo
    ? appendQuotaResetLabel(`${quotaInfo.remaining} / ${quotaInfo.quota} ${getQuotaUsageLabel(quotaInfo)} remaining.`, quotaInfo.resetTime)
    : 'Your monthly effective submission quota is nearing its limit.';
}