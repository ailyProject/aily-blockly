/** Request cancellation is independent of shared Runtime/process ownership. */
export class SubappOwnerRequests {
  private readonly owners = new Map<string, Map<AbortController, { requestId: string; done: Promise<string | undefined>; join: boolean }>>();

  start(owner: string, external?: AbortSignal, requestId = ''): { signal: AbortSignal; waitForCleanup(): void; finish(cleanupError?: string): void } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (external?.aborted) abort();
    else external?.addEventListener('abort', abort, { once: true });
    let requests = this.owners.get(owner);
    if (!requests) this.owners.set(owner, requests = new Map());
    let finished!: (cleanupError?: string) => void;
    const done = new Promise<string | undefined>(resolve => { finished = resolve; });
    const request = { requestId, done, join: false };
    requests.set(controller, request);
    return {
      signal: controller.signal,
      // Only resource-owning calls need joined cleanup. Pure UI discovery may
      // finish later and is already prevented from opening resources by abort.
      waitForCleanup: () => { request.join = true; },
      finish: cleanupError => {
        external?.removeEventListener('abort', abort);
        requests.delete(controller);
        if (!requests.size && this.owners.get(owner) === requests) this.owners.delete(owner);
        finished(cleanupError);
      },
    };
  }

  async release(owner: string): Promise<string[]> {
    const requests = this.owners.get(owner);
    this.owners.delete(owner);
    for (const controller of requests?.keys() || []) controller.abort();
    const errors = await Promise.all([...(requests?.values() || [])].filter(request => request.join).map(request => request.done));
    return errors.filter((error): error is string => typeof error === 'string');
  }

  cancel(owner: string, requestId: string): void {
    for (const [controller, request] of this.owners.get(owner) || []) if (request.requestId === requestId) controller.abort();
  }

  stop(): void { for (const owner of this.owners.keys()) void this.release(owner); }
}
