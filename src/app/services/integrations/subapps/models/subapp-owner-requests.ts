type CleanupSource = 'native-batch' | 'web-semantic';
export interface SubappOwnerRequestCleanupError { source: CleanupSource; error: string }

/** Request cancellation is independent of shared Runtime/process ownership. */
export class SubappOwnerRequests {
  private readonly owners = new Map<string, Map<AbortController, { requestId: string; done: Promise<string | undefined>;
    join: boolean; source: CleanupSource; cleanupError?: string }>>();

  start(owner: string, external?: AbortSignal, requestId = ''): {
    signal: AbortSignal; waitForCleanup(source?: CleanupSource): void; finish(cleanupError?: string): void;
  } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (external?.aborted) abort();
    else external?.addEventListener('abort', abort, { once: true });
    let requests = this.owners.get(owner);
    if (!requests) this.owners.set(owner, requests = new Map());
    let finished!: (cleanupError?: string) => void;
    const done = new Promise<string | undefined>(resolve => { finished = resolve; });
    const request = { requestId, done, join: false, source: 'native-batch' as CleanupSource,
      cleanupError: undefined as string | undefined };
    requests.set(controller, request);
    return {
      signal: controller.signal,
      // Only resource-owning calls need joined cleanup. Pure UI discovery may
      // finish later and is already prevented from opening resources by abort.
      waitForCleanup: (source = 'native-batch') => { request.join = true; request.source = source; },
      finish: cleanupError => {
        external?.removeEventListener('abort', abort);
        // A rejected observer does not prove that the original operation has
        // retired. No actual-terminal receipt is exposed at this boundary yet.
        if (cleanupError !== undefined) { request.join = true; request.cleanupError ??= cleanupError; }
        if (request.cleanupError !== undefined) { finished(request.cleanupError); return; }
        requests.delete(controller);
        if (!requests.size && this.owners.get(owner) === requests) this.owners.delete(owner);
        finished(cleanupError);
      },
    };
  }

  async release(owner: string): Promise<SubappOwnerRequestCleanupError[]> {
    const requests = this.owners.get(owner);
    const joined = [...(requests?.values() || [])].filter(request => request.join);
    for (const controller of requests?.keys() || []) controller.abort();
    const results = await Promise.all(joined.map(async request => {
      const error = await request.done;
      return typeof error === 'string' ? { source: request.source, error } : null;
    }));
    return results.filter((error): error is SubappOwnerRequestCleanupError => error !== null);
  }

  cancel(owner: string, requestId: string): void {
    for (const [controller, request] of this.owners.get(owner) || []) if (request.requestId === requestId) controller.abort();
  }

  stop(): void { for (const owner of this.owners.keys()) void this.release(owner); }
}
