export interface ToolCloseLifecycle {
  childHostRegistered: boolean;
  requestChildClose(): Promise<Record<string, unknown>>;
  completeClose(): void;
}

export async function closeToolThroughLifecycle(lifecycle: ToolCloseLifecycle): Promise<boolean> {
  if (!lifecycle.childHostRegistered) {
    lifecycle.completeClose();
    return true;
  }

  const result = await lifecycle.requestChildClose();
  // Web hosts settle the original product close before delegating removal to
  // the owning UI. Legacy hosts complete their own presentation removal.
  if (result['ok'] === true && result['closeSettled'] === true) lifecycle.completeClose();
  return result['ok'] === true;
}
