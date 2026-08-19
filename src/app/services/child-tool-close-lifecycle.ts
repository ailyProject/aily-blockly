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
  return result['ok'] === true;
}
