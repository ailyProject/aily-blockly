/** Public ledger fields used by the account panel; amounts stay in integer micros. */
export interface AuthCreditSnapshot {
  readonly available_micros: number;
  readonly reserved_micros: number;
  readonly included_granted_micros: number | null;
  readonly next_reset_at: string | null;
  readonly subscription_plan: string | null;
}

export function normalizeAuthCreditSnapshot(value: unknown): AuthCreditSnapshot | undefined {
  if (!value || typeof value !== 'object' || !('unit' in value) || value.unit !== 'credits') return undefined;
  return normalizeCreditLedgerSnapshot(value);
}

/** /api/v1/credits/me returns CreditSnapshotResponse directly, without an envelope or unit tag. */
export function normalizeCreditLedgerSnapshot(value: unknown): AuthCreditSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data['unit'] !== undefined && data['unit'] !== 'credits') return undefined;
  const available = data['available_micros'];
  const reserved = data['reserved_micros'];
  const granted = data['included_granted_micros'] ?? null;
  const reset = data['next_reset_at'] ?? null;
  const plan = data['subscription_plan'] ?? null;
  if (!isMicros(available) || !isMicros(reserved)) return undefined;
  if (granted !== null && !isMicros(granted)) return undefined;
  if (reset !== null && (typeof reset !== 'string' || !Number.isFinite(Date.parse(reset)))) return undefined;
  if (plan !== null && (typeof plan !== 'string' || !plan.trim())) return undefined;
  return {
    available_micros: available,
    reserved_micros: reserved,
    included_granted_micros: isMicros(granted) ? granted : null,
    next_reset_at: typeof reset === 'string' ? reset : null,
    subscription_plan: typeof plan === 'string' ? plan : null,
  };
}

function isMicros(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
