/** A confirmed user stop is a terminal control outcome, not a compiler error. */
export function buildCancelledResult(text: string) {
  return {
    state: 'warn' as const,
    text,
    code: 'BUILD_CANCELLED' as const,
    buildOutcome: 'cancelled' as const,
    cancelled: true as const,
    reason: 'user_cancelled' as const,
    retryable: false as const,
  };
}

export function isBuildCancelled(value: unknown): boolean {
  const result = value as Partial<ReturnType<typeof buildCancelledResult>> | undefined;
  return result?.code === 'BUILD_CANCELLED' && result.buildOutcome === 'cancelled';
}
