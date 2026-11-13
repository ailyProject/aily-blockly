import { encodeAbsProjection, decodeAbsProjection } from './abs-map-json';
import { stringifyProjectJson } from '@domain/project/project-document-json';
import type { AbsBaselineStore, AbsSyncStorageAccess, AbsSyncStoragePort } from './abs-baseline-store';
import type { AbsProjectionContext } from './abs-identity-map';
import type { AbsAbiWorkspace, AbsProjection } from './abs-state';

/** One background publication, with the same native storage authority as a foreground save. */
export class AbsBackgroundComputation {
  private readonly worker: Worker;
  private readonly inflight = new Set<Promise<void>>();
  private sequence = 0;
  private readonly pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void }>();
  private readonly locks = new Map<number, { access: AbsSyncStorageAccess; release(): void; done: Promise<unknown> }>();
  private commitAbi?: (text: string, hash: string | null, access: AbsSyncStorageAccess) => Promise<void>;
  private readonly ready: Promise<unknown>;
  private failed?: Error;
  constructor(private readonly port: AbsSyncStoragePort, scope: AbsProjection['map']['scope'], private readonly assertCurrent: () => void, worker?: Worker) {
    this.worker = worker ?? new Worker(new URL('./abs-background.worker', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'fatal') { this.dispose(new Error(data.error)); return; }
      if (data.type === 'io') {
        const task = this.handleIo(data); this.inflight.add(task);
        void task.finally(() => this.inflight.delete(task)); return;
      }
      const task = this.pending.get(data.id); this.pending.delete(data.id);
      if (!task) return;
      try {
        if (data.error) task.reject(Object.assign(new Error(data.error.message), data.error));
        else {
          let value = data.json === undefined ? undefined : JSON.parse(data.json);
          if (['projection', 'loadCommitted'].includes(task.method)) value = decodeAbsProjection(value, true);
          else if (task.method === 'inspectCommitted' && value) value = { ...value, projection: decodeAbsProjection(value.projection, true) };
          task.resolve(value);
        }
      } catch (error) { task.reject(error); }
    };
    this.worker.onerror = event => this.dispose(new Error(event.message || 'Background save worker failed.'));
    this.worker.onmessageerror = () => this.dispose(new Error('Background save worker message could not be read.'));
    this.ready = this.call('init', [scope]);
  }
  private call(method: string, args: unknown[]): Promise<any> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; this.pending.set(id, { method, resolve, reject });
      try {
        // Structured-clone deserialization overflows on deep Blockly chains in
        // a worker's smaller stack. Transfer stack-safe JSON, preserving absent arguments.
        if (method === 'stage') args = [{ ...args[0] as any, projection: encodeAbsProjection((args[0] as any).projection) }, ...args.slice(1)];
        this.worker.postMessage({ type: 'call', id, method,
          json: stringifyProjectJson(args.map(value => value === undefined ? null : value)),
          absent: args.flatMap((value, index) => value === undefined ? [index] : []) });
      }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  private async invoke(method: string, args: unknown[]): Promise<any> {
    await this.ready; this.assertCurrent();
    const result = await this.call(method, args); this.assertCurrent(); return result;
  }
  recoverLocation(): Promise<void> { return this.invoke('recoverLocation', []); }
  projection(workspace: AbsAbiWorkspace, context: AbsProjectionContext): Promise<AbsProjection> {
    return this.invoke('projection', [workspace, context]);
  }
  store(fallback: AbsBaselineStore): AbsBaselineStore {
    const proxy = Object.create(fallback);
    for (const method of ['captureDisk', 'inspectPending', 'inspectCommitted', 'loadCommitted', 'readDerivedAbi', 'stage', 'readArchivedDraft']) {
      proxy[method] = (...args: unknown[]) => this.invoke(method, args);
    }
    proxy.commit = async (generation: string, guard: () => void, commit: typeof this.commitAbi) => {
      this.commitAbi = commit;
      try { guard(); const result = await this.invoke('commit', [generation]); guard(); return result; }
      finally { this.commitAbi = undefined; }
    };
    return proxy;
  }
  private async handleIo({ id, method, args }: { id: number; method: string; args: any[] }) {
    try {
      let value: any;
      // Unlock must always run, even when a project switches or a guard rejects.
      if (method === 'unlock') {
        const lock = this.locks.get(args[0]);
        if (!lock) throw new Error('Background publication lock is no longer owned.');
        lock.release(); await lock.done; this.locks.delete(args[0]);
      } else {
        this.assertCurrent();
        if (method === 'lock') {
          const lockId = ++this.sequence;
          await new Promise<void>((resolve, reject) => {
            const done = this.port.withLock(async access => {
              await Promise.resolve();
              this.assertCurrent();
              await new Promise<void>(release => { this.locks.set(lockId, { access, release, done }); resolve(); });
            });
            done.catch(reject);
          });
          value = lockId;
        } else if (method === 'read') {
          const access = args[1] === undefined ? this.port : this.locks.get(args[1])?.access;
          if (!access) throw new Error('Background read has no owned storage access.');
          value = await access.read(args[0]);
        } else if (method === 'replace') {
          const access = this.locks.get(args[3])?.access;
          if (!access) throw new Error('Background write has no owned storage lock.');
          value = await access.replace(args[0], args[1], args[2]);
        } else if (method === 'commitAbi') {
          const access = this.locks.get(args[2])?.access;
          if (!access || !this.commitAbi) throw new Error('Background ABI commit has no owned publication.');
          value = await this.commitAbi(args[0], args[1], access);
        } else throw new Error('Unsupported background storage operation.');
        this.assertCurrent();
      }
      if (!this.failed) this.worker.postMessage({ type: 'io-result', id, value });
    } catch (error: any) {
      if (!this.failed) this.worker.postMessage({ type: 'io-result', id, error: { message: error?.message ?? String(error), code: error?.code } });
    }
  }
  dispose(error = new Error('Background save computation closed.')): void {
    if (this.failed) return; this.failed = error;
    this.worker.terminate();
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    // A terminated worker must not release a host lock while a dispatched
    // native CAS is still running. Settle that I/O before admitting another writer.
    void Promise.allSettled([...this.inflight]).then(() => {
      for (const lock of this.locks.values()) lock.release();
      this.locks.clear();
    });
  }
}
