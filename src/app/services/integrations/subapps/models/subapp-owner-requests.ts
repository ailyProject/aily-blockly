type CleanupSource = 'native-batch' | 'web-semantic';
export interface SubappOwnerRequestCleanupError { source: CleanupSource; error: string }
export interface SubappOwnerRequestCancellationReceipt {
  schemaVersion: 1;
  requestId: string;
  terminalReceived: boolean;
  cleanupConfirmed: boolean;
  source: CleanupSource | 'none' | null;
  reason: 'request-not-observed' | 'request-ambiguous' | 'cleanup-not-joined'
    | 'cleanup-acknowledged' | 'cleanup-failed' | 'cleanup-timeout';
}

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
        // A failed observer retains the original cleanup responsibility;
        // a cancellation receipt cannot retire that failure.
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

  async cancel(owner: string, requestId: string): Promise<SubappOwnerRequestCancellationReceipt> {
    // Capture before abort: a synchronous completion may retire this exact
    // request immediately. Absence later must never manufacture an ACK.
    const matches = [...(this.owners.get(owner) || [])].filter(([, request]) => request.requestId === requestId);
    const receipt = (source: SubappOwnerRequestCancellationReceipt['source'],
      reason: SubappOwnerRequestCancellationReceipt['reason'], terminalReceived = false,
      cleanupConfirmed = false): SubappOwnerRequestCancellationReceipt => ({
      schemaVersion: 1, requestId, terminalReceived, cleanupConfirmed, source, reason,
    });
    for (const [controller] of matches) controller.abort();
    if (matches.length !== 1) return receipt(null, matches.length ? 'request-ambiguous' : 'request-not-observed');
    const request = matches[0][1], source = request.join ? request.source : 'none';
    const timeout = Symbol('cleanup-timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // This bounds only the observer. The original done/release responsibility
      // survives a timeout; cancellation never ends the shared owner lease.
      const result = await Promise.race([request.done,
        new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), 3000); })]);
      if (result === timeout) return receipt(source, 'cleanup-timeout');
      if (result !== undefined) return receipt(source, 'cleanup-failed', true);
      if (source === 'none') return receipt(source, 'cleanup-not-joined', true);
      return receipt(source, 'cleanup-acknowledged', true, true);
    } finally { clearTimeout(timer); }
  }

  stop(): void { for (const owner of this.owners.keys()) void this.release(owner); }
}
