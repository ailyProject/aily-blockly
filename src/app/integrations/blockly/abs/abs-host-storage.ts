import { AbsSyncStorageAccess, AbsSyncStoragePort } from './abs-baseline-store';
import { AbsSyncError } from './abs-state';

export type AbsStorageSettlement<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } };
export interface AbsHostStorageCapability {
  read(key: string): Promise<string | null>;
  withLock<T>(operation: (storage: AbsSyncStorageAccess, settle: (result: AbsStorageSettlement<T>) => void) => void): Promise<T>;
}

export interface AbsHostStoragePort {
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
  const storage = await host.openProjectSyncStorage(projectPath, assertCurrent);
  assertCurrent();
  if (typeof storage?.read !== 'function' || typeof storage.withLock !== 'function') {
    throw new AbsSyncError('ABS_STORAGE_HOST_UNAVAILABLE', 'Invalid ABS generation storage capability.');
  }
  return {
    read: key => storage.read(key),
    // Return void to contextBridge. Zone/native promises stay on their owning side;
    // only plain results/errors pass through the explicit native settlement callback.
    withLock: operation => storage.withLock((locked, settle) => {
      Promise.resolve().then(() => operation(locked)).then(
        value => settle({ ok: true, value }),
        error => settle({ ok: false, error: { ...(typeof error?.code === 'string' ? { code: error.code } : {}),
          message: error instanceof Error ? error.message : String(error) } }),
      );
    }),
  };
}
