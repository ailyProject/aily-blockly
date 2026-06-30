export function formatQuotaResetLabel(resetAt: string | undefined): string | undefined {
  const display = resolveQuotaResetDisplay(resetAt);
  if (!display) {
    return undefined;
  }

  if (display.kind === 'raw') {
    return `Resets ${display.value}.`;
  }

  if (!display.timeLabel) {
    return `Resets ${display.dateLabel}.`;
  }

  return `Resets ${display.dateLabel} at ${display.timeLabel}.`;
}

export function formatQuotaResetMetaLabel(resetAt: string | undefined): string | undefined {
  const display = resolveQuotaResetDisplay(resetAt);
  if (!display) {
    return undefined;
  }

  if (display.kind === 'raw') {
    return `Reset on ${display.value}`;
  }

  if (!display.timeLabel) {
    return `Reset on ${display.dateLabel}`;
  }

  return `Reset on ${display.dateLabel} ${display.timeLabel}`;
}

export function appendQuotaResetLabel(
  message: string,
  resetAt: string | undefined,
): string {
  const resetLabel = formatQuotaResetLabel(resetAt);
  return resetLabel ? `${message} ${resetLabel}` : message;
}

export function trimQuotaResetLabel(label: string | undefined): string | undefined {
  return label?.replace(/[.]$/, '');
}

function hasExplicitResetTime(resetAt: string): boolean {
  return !/^\d{4}-\d{2}-\d{2}$/.test(resetAt);
}

function resolveQuotaResetDisplay(resetAt: string | undefined):
  | { kind: 'formatted'; dateLabel: string; timeLabel?: string }
  | { kind: 'raw'; value: string }
  | undefined {
  if (!resetAt) {
    return undefined;
  }

  const normalized = resetAt.trim();
  if (!normalized) {
    return undefined;
  }

  const resetAtMs = Date.parse(normalized);
  if (!Number.isFinite(resetAtMs)) {
    return { kind: 'raw', value: normalized };
  }

  const resetDate = new Date(resetAtMs);
  const now = new Date();
  const includeYear = resetDate.getFullYear() !== now.getFullYear();
  const dateOptions: Intl.DateTimeFormatOptions = includeYear
    ? { month: 'long', day: 'numeric', year: 'numeric' }
    : { month: 'long', day: 'numeric' };
  const dateLabel = new Intl.DateTimeFormat(undefined, dateOptions).format(resetDate);
  if (!hasExplicitResetTime(normalized)) {
    return { kind: 'formatted', dateLabel };
  }

  const timeLabel = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(resetDate);
  return { kind: 'formatted', dateLabel, timeLabel };
}