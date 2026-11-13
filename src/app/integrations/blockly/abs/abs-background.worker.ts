/// <reference lib="webworker" />
import { encodeAbsProjection, decodeAbsProjection } from './abs-map-json';
import { AbsBaselineStore, type AbsSyncStorageAccess, type AbsSyncStoragePort } from './abs-baseline-store';
import { recoverAbsLocationMetadata } from './abs-baseline-recovery';
import { absJson, createAbsProjection, type AbsProjectionContext } from './abs-identity-map';

// This realm has no filesystem capability. Every read and mutation goes through
// the host's original attachment, lock and current-project guard.
let sequence = 0, store: AbsBaselineStore, port: AbsSyncStoragePort, scope: AbsProjectionContext['scope'];
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const io = (method: string, args: unknown[] = []): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); postMessage({ type: 'io', id, method, args });
});
const failure = (error: any) => ({ message: error?.message ?? String(error), code: error?.code, stack: error?.stack });
addEventListener('message', async ({ data }: MessageEvent) => {
  if (data.type === 'io-result') {
    const task = pending.get(data.id); pending.delete(data.id);
    if (data.error) task?.reject(Object.assign(new Error(data.error.message), data.error)); else task?.resolve(data.value);
    return;
  }
  if (data.type !== 'call') return;
  try {
    const args = JSON.parse(data.json);
    for (const index of data.absent ?? []) args[index] = undefined;
    if (data.method === 'stage') args[0] = { ...args[0], projection: decodeAbsProjection(args[0].projection) };
    let value: any;
    if (data.method === 'init') {
      port = {
        read: key => io('read', [key]),
        withLock: async operation => {
          const id = await io('lock');
          const access: AbsSyncStorageAccess & { lock: number } = { lock: id,
            read: key => io('read', [key, id]), replace: (key, hash, content) => io('replace', [key, hash, content, id]) };
          try { return await operation(access); } finally { await io('unlock', [id]); }
        },
      };
      scope = args[0]; store = new AbsBaselineStore(port, scope, true);
    } else if (data.method === 'recoverLocation') value = await recoverAbsLocationMetadata(port, scope, () => {});
    else if (data.method === 'projection') value = await createAbsProjection(args[0], args[1]);
    else if (data.method === 'commit') value = await store.commit(args[0], () => {},
      (text, hash, access) => io('commitAbi', [text, hash, (access as any).lock]));
    else value = await (store as any)[data.method](...args);
    if (['projection', 'loadCommitted'].includes(data.method)) value = encodeAbsProjection(value);
    else if (data.method === 'inspectCommitted' && value) value = { ...value, projection: encodeAbsProjection(value.projection) };
    postMessage({ type: 'result', id: data.id, json: value === undefined ? undefined : absJson(value) });
  } catch (error) { postMessage({ type: 'result', id: data.id, error: failure(error) }); }
});

addEventListener('messageerror', () => postMessage({ type: 'fatal', error: 'Background save input could not be read.' }));
