import { AbsSyncStorageAccess, AbsSyncStoragePort } from './abs-baseline-store';
import { AbsSyncError } from './abs-state';
import { projectStorageBridge, requireProjectProgramPublication,
  type NativeProjectStorageBridge, type ProjectProgramPublicationHost } from '@shared/public-api';

export type AbsStorageSettlement<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } };
export interface AbsHostStorageCapability extends NativeProjectStorageBridge {
  read(key: string): Promise<string | null>;
  withLock<T>(operation: (storage: AbsSyncStorageAccess, settle: (result: AbsStorageSettlement<T>) => void) => void): Promise<T>;
}

export interface AbsHostStoragePort extends ProjectProgramPublicationHost {
  readonly projectSyncStorageVersion?: number;
  openProjectSyncStorage(projectPath: string, assertCurrent: () => void): Promise<AbsHostStorageCapability>;
}

/** One host-held lock spans the entire generation callback; individual CAS calls must not reacquire it. */
export async function openAbsHostStorage(
  projectPath: string, assertCurrent: () => void, host: AbsHostStoragePort = window['fs'],
): Promise<AbsSyncStoragePort> {
  assertCurrent();
  if (host?.projectSyncStorageVersion !== 2 || typeof host.openProjectSyncStorage !== 'function') {
    throw new AbsSyncError('ABS_STORAGE_HOST_UNAVAILABLE', 'ABS generation storage requires the updated Electron host.');
  }
  const native = await host.openProjectSyncStorage(projectPath, assertCurrent);
  assertCurrent();
  if (typeof native?.read !== 'function' || typeof native.withLock !== 'function') {
    throw new AbsSyncError('ABS_STORAGE_HOST_UNAVAILABLE', 'Invalid ABS generation storage capability.');
  }
  const storage = projectStorageBridge(native, assertCurrent);
  return {
    attachment: storage.attachment,
    executor: storage.executor,
    ...(storage.observeExecutor ? { observeExecutor: (original: NonNullable<AbsSyncStoragePort['executor']>) => storage.observeExecutor!(original) } : {}),
    read: key => storage.read(key),
    // Return void to contextBridge. Zone/native promises stay on their owning side;
    // only plain results/errors pass through the explicit native settlement callback.
    withLock: operation => storage.withLock((locked, settle) => {
      const access: AbsSyncStorageAccess = { ...locked, replace: (key, expected, content) => {
        if (['project.abi', 'project.abs', 'project.abs.map.json', 'prepared.json', 'committed.json'].includes(key)
          || key.startsWith('baselines/')) requireProjectProgramPublication(host);
        return locked.replace(key, expected, content);
      } };
      Promise.resolve().then(() => operation(access)).then(
        value => settle({ ok: true, value }),
        error => settle({ ok: false, error: { ...(typeof error?.code === 'string' ? { code: error.code } : {}),
          message: error instanceof Error ? error.message : String(error) } }),
      );
    }),
  };
}
