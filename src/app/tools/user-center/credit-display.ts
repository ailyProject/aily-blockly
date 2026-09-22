import type { AuthCreditSnapshot } from '@core/auth/public-api';

export function isProCreditPlan(plan: string | null | undefined): boolean {
  return /^pro(?:$|[_+ -])/i.test(plan?.trim() ?? '');
}

export function formatCreditQuota(
  snapshot: AuthCreditSnapshot | null,
  locale?: string,
  subscriptionPlan?: string | null,
): string {
  // Product display policy only. The ledger and server admission remain finite.
  if (isProCreditPlan(snapshot?.subscription_plan ?? subscriptionPlan)) return '\u267e\ufe0f';
  if (!snapshot) return '--';
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
  const available = format.format(snapshot.available_micros / 1_000_000);
  const granted = snapshot.included_granted_micros;
  return granted === null
    ? `${available} Credit`
    : `${available}/${format.format(granted / 1_000_000)} Credit`;
}
