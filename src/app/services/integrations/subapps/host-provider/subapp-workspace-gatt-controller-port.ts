import { createWorkspaceConnectivityControllerPort } from './subapp-workspace-network-controller-port';
import { validateHostGattProducerStateV1 } from '@aily-project/simulator-protocol/host';
type Data = Record<string, unknown>;

/** Each producer has an exact Main-issued identity. Ending GATT never rebuilds
 * the common Product/Network channel; old cleanup remains on its own token. */
export function createWorkspaceGattControllerPort(options: {
  invoke(input: Data): Promise<Data>;
  requireCurrentBinding(cleanup: boolean): void;
}) {
  type Actor = { fenced: boolean; port: ReturnType<typeof createWorkspaceConnectivityControllerPort>; closing?: Promise<void> };
  const actors = new Map<string, Actor>();
  const observed = new Set<string>();
  let closed = false;
  let currentProducer: string | null = null;
  let revision = 0, admissionFenced = false;
  const retired = new Set<string>();
  const identity = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error('Invalid GATT producer identity');
    return value;
  };
  function actor(producerId: string): Actor {
    const id = identity(producerId); let current = actors.get(id);
    if (current) return current;
    if (closed || !observed.has(id) || actors.size >= 16) throw new Error('Original GATT producer is unavailable');
    const next = { fenced: false } as Actor;
    next.port = createWorkspaceConnectivityControllerPort({
      isCleanupRequest: request => request['operation'] === 'release',
      invoke: input => options.invoke({ ...input, producerId: id }),
      requireCurrentBinding(cleanup) {
        options.requireCurrentBinding(cleanup);
        if (!cleanup && (closed || next.fenced)) throw new Error('Original GATT producer ended');
      },
    });
    actors.set(id, next); return next;
  }
  async function closeProducer(producerId: string): Promise<void> {
    const id = identity(producerId), current = actors.get(id);
    if (!current) return;
    current.fenced = true;
    if (current.closing) return current.closing;
    const original = current.port.close().then(() => { if (actors.get(id) === current) actors.delete(id); observed.delete(id); });
    current.closing = original;
    try { await original; } finally { if (current.closing === original) current.closing = undefined; }
  }
  return {
    async bindingState(signal: AbortSignal): Promise<Data> {
      options.requireCurrentBinding(false); signal.throwIfAborted();
      if (closed) throw new Error('GATT Product binding ended');
      const value = validateHostGattProducerStateV1(await options.invoke({ action: 'binding-state' }));
      options.requireCurrentBinding(false); signal.throwIfAborted();
      const id = identity(value.producerId);
      if (value.revision < revision || retired.has(id)
          || value.revision === revision && currentProducer !== id
          || value.revision === revision && admissionFenced && value.state === 'ready')
        throw new Error('Stale GATT producer observation');
      if (value.revision > revision) { revision = value.revision; admissionFenced = false; }
      if (value.state !== 'ready') admissionFenced = true;
      if (currentProducer !== id) {
          for (const [oldId, old] of actors) if (oldId !== id) {
            old.fenced = true;
            void closeProducer(oldId).catch(() => { /* Keep unknown old IPC cleanup for retry. */ });
          }
          for (const oldId of observed) if (oldId !== id && !actors.has(oldId)) observed.delete(oldId);
          currentProducer = id;
      }
      if (value.state !== 'ready') { const current = actors.get(id); if (current) current.fenced = true; }
      if (value.state === 'ready') {
        if (observed.size >= 64 && !observed.has(id)) throw new Error('GATT producer receipt capacity exhausted');
        observed.add(id);
      }
      return value as unknown as Data;
    },
    request(producerId: string, request: Data, signal: AbortSignal) {
      options.requireCurrentBinding(request['operation'] === 'release'); return actor(producerId).port.request(request, signal);
    },
    closeProducer,
    observeRetired(producerId: string): void {
      retired.add(identity(producerId));
      if (retired.size > 64) retired.delete(retired.values().next().value!);
      const current = actors.get(producerId);
      if (current) { current.fenced = true; void closeProducer(producerId).catch(() => { /* Exact actor retained for explicit cleanup retry. */ }); }
      else observed.delete(producerId);
    },
    async close(): Promise<void> {
      closed = true;
      const result = await Promise.allSettled([...actors.keys()].map(closeProducer));
      if (result.some(value => value.status === 'rejected') || actors.size) throw new Error('Original GATT producers require cleanup retry');
      observed.clear();
    },
  };
}
