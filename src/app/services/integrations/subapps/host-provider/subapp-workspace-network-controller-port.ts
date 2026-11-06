type RecordValue = Record<string, unknown>;

/** Thin cancellation/lifetime adapter for one original workspace IPC binding.
 * Actual simulation-owner authority, endpoint policy, grants and network work
 * remain in Main and the shared backend. No Scope or URL is manufactured here. */
export function createWorkspaceNetworkControllerPort(options: {
  invoke(input: RecordValue): Promise<RecordValue>;
  requireCurrentBinding(cleanup: boolean): void;
  observeDispatch?(request: RecordValue): void;
  observeResult?(request: RecordValue, result: RecordValue): void;
  beforeResult?(): Promise<void>;
}): { request(request: RecordValue, signal: AbortSignal): Promise<RecordValue>; close(): Promise<void> } {
  let closed = false, closing: Promise<void> | null = null;
  // A request is the only operation that can acquire an original Main
  // backend. Publish intent before invoking IPC: synchronous/unknown delivery
  // must still join Main cleanup, never be treated as an unused channel.
  let requestDispatched = false;
  const pending = new Map<string, { done: Promise<void>; cancel(): Promise<void> }>();
  const invoke = (input: RecordValue, cleanup: boolean, beforeDispatch?: () => void) => {
    options.requireCurrentBinding(cleanup);
    beforeDispatch?.();
    return options.invoke(input);
  };
  return {
    async request(request, signal) {
      options.requireCurrentBinding(false);
      if (closed || signal.aborted) throw new Error('Network Provider binding is retired or cancelled.');
      const id = request['requestId'];
      if (typeof id !== 'string' || id.length < 1 || id.length > 128 || pending.has(id) || pending.size >= 16) throw new Error('Network Provider request identity/capacity is unavailable.');
      let complete!: () => void, cancellation: Promise<void> | null = null, dispatched = false;
      const done = new Promise<void>(resolve => { complete = resolve; });
      const cancel = () => {
        if (!dispatched) return Promise.resolve();
        return cancellation ??= invoke({ action: 'cancel', requestId: id }, true).then(result => {
          if (result['ok'] !== true || result['completionConfirmed'] !== false) throw new Error('Network cancellation delivery is unconfirmed.');
        });
      };
      const aborted = () => { void cancel().catch(() => undefined); };
      pending.set(id, { done, cancel });
      signal.addEventListener('abort', aborted, { once: true });
      try {
        signal.throwIfAborted();
        // This one normal request precedes a possible cancel on the same IPC
        // channel. Unknown delivery is never automatically resent.
        dispatched = true;
        requestDispatched = true;
        // Reserve destructive-cleanup ordering before actual Main dispatch.
        // A stale selected identity cannot cancel a later pending chooser.
        const work = invoke({ action: 'request', request }, false, () => options.observeDispatch?.(request));
        if (signal.aborted) aborted();
        const result = await work;
        // Retain a genuine successful selection before cancellation can refuse
        // its business delivery. This observation authorizes cleanup only.
        options.observeResult?.(request, result);
        if (signal.aborted) await cancel();
        if (cancellation) await cancellation;
        await options.beforeResult?.();
        options.requireCurrentBinding(false);
        if (closed || signal.aborted) throw new Error('Network Provider result arrived after cancellation.');
        return result;
      } finally { signal.removeEventListener('abort', aborted); pending.delete(id); complete(); }
    },
    close() {
      closed = true;
      if (closing) return closing;
      const task = Promise.resolve().then(async () => {
        options.requireCurrentBinding(true);
        // No request left this exact original local binding, so it cannot own
        // a Main acquisition or resource. Do not manufacture an unknown IPC
        // cleanup authority after its Runtime/controller has already exited.
        if (!requestDispatched) return;
        // Close wakes original backend work first; it is not a local-only
        // abort or a synthetic acknowledgement of resource retirement.
        const result = await invoke({ action: 'close' }, true);
        if (result['ok'] !== true || result['closed'] !== true) throw new Error('Original network owner cleanup remains unconfirmed.');
        await Promise.all([...pending.values()].map(value => value.done));
      });
      closing = task;
      return task.finally(() => { if (closing === task) closing = null; });
    },
  };
}
