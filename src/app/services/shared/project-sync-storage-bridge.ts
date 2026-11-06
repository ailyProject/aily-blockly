export type ProjectStorageSettlement<T> = { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } };
export interface ProjectStorageAccess {
  read(key: string): Promise<string | null>;
  replace(key: string, expected: string | null, content: string | null): Promise<boolean>;
}
interface NativeProjectStorageAccess extends ProjectStorageAccess {
  readResult?(key: string): Promise<ProjectStorageSettlement<string | null>>;
  replaceResult?(key: string, expected: string | null, content: string | null): Promise<ProjectStorageSettlement<boolean>>;
}
export interface ProjectStorageBridge {
  read(key: string): Promise<string | null>;
  withLock<T>(run: (storage: ProjectStorageAccess, settle: (result: ProjectStorageSettlement<T>) => void) => void): Promise<T>;
}
export interface NativeProjectStorageBridge extends ProjectStorageBridge {
  readResult?(key: string): Promise<ProjectStorageSettlement<string | null>>;
  withLockResult?<T>(run: (storage: NativeProjectStorageAccess,
    settle: (result: ProjectStorageSettlement<T>) => void) => void): Promise<ProjectStorageSettlement<T>>;
}

function value<T>(result: ProjectStorageSettlement<T>): T {
  if (result?.ok === true) return result.value;
  if (result?.ok === false && typeof result.error?.message === 'string')
    throw Object.assign(new Error(result.error.message), typeof result.error.code === 'string' ? { code: result.error.code } : {});
  throw Object.assign(new Error('Invalid project storage bridge result.'), { code: 'ABS_STORAGE_RESULT_INVALID' });
}

/** Decode the existing host settlement protocol on this side of contextBridge.
 * No ambient lock or file authority is created; legacy hosts remain compatible. */
export function projectStorageBridge(storage: NativeProjectStorageBridge, assertCurrent: () => void): ProjectStorageBridge {
  const read = async (access: NativeProjectStorageBridge | NativeProjectStorageAccess, key: string) => {
    assertCurrent();
    const result = access.readResult ? await access.readResult(key) : { ok: true as const, value: await access.read(key) };
    assertCurrent(); return value(result);
  };
  return {
    read: key => read(storage, key),
    withLock<T>(run: (storage: ProjectStorageAccess, settle: (result: ProjectStorageSettlement<T>) => void) => void) {
      if (!storage.withLockResult) return storage.withLock(run);
      return storage.withLockResult<T>((locked, settle) => run({
        read: key => read(locked, key),
        replace: async (key, expected, content) => {
          assertCurrent();
          const result = locked.replaceResult ? await locked.replaceResult(key, expected, content)
            : { ok: true as const, value: await locked.replace(key, expected, content) };
          assertCurrent(); return value(result);
        },
      }, settle)).then(result => { assertCurrent(); return value(result); });
    },
  };
}
