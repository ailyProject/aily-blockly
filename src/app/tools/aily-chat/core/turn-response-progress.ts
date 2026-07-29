import type { TurnResponseTurn } from 'aily-lex/browser';

export type TurnResponseProgressValue =
  NonNullable<TurnResponseTurn['response']['progressMessages']>[number];

export function isTurnResponseProgressTask(
  value: TurnResponseProgressValue | null | undefined,
): value is Extract<TurnResponseProgressValue, { readonly kind: 'progressTask' }> {
  return value?.kind === 'progressTask'
    && typeof (value as { readonly id?: unknown }).id === 'string'
    && !!(value as { readonly id: string }).id.trim();
}

export function upsertTurnResponseProgress(
  current: readonly TurnResponseProgressValue[] | undefined,
  value: TurnResponseProgressValue,
): TurnResponseProgressValue[] {
  const next = current ? [...current] : [];
  if (!isTurnResponseProgressTask(value)) {
    next.push({ ...value });
    return next;
  }

  const index = next.findIndex(candidate =>
    isTurnResponseProgressTask(candidate) && candidate.id === value.id);
  if (index >= 0) {
    next[index] = { ...value };
  } else {
    next.push({ ...value });
  }
  return next;
}
