export interface SubappRuntimeLeaseOwner {
  acquire(toolId: string): Promise<unknown>;
  release(toolId: string): Promise<void>;
}

/**
 * Hold a Runtime lease while an independent renderer is being opened and its
 * first Agent RPC is attached. This closes the cross-renderer startup window
 * where both renderers could otherwise spawn and register competing Runtimes.
 */
export async function acquireSubappRuntimePresentationLease(
  owner: SubappRuntimeLeaseOwner,
  toolId: string,
): Promise<() => Promise<void>> {
  await owner.acquire(toolId);
  let released = false;

  return async () => {
    if (released) return;
    released = true;
    await owner.release(toolId);
  };
}
