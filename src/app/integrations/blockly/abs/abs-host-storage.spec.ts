import { AbsHostStorageCapability, AbsHostStoragePort, openAbsHostStorage } from './abs-host-storage';

describe('ABS host generation storage capability', () => {
  const guard = () => undefined;
  const storage: AbsHostStorageCapability = { read: async () => null, withLock: operation => new Promise((resolve, reject) => {
    operation({ read: async () => null, replace: async () => true }, result => result.ok === true ? resolve(result.value) : reject(new Error(result.error.message)));
  }) };

  it('requires the exact host capability version and never falls back to direct filesystem writes', async () => {
    for (const host of [undefined, {}, { projectSyncStorageVersion: 0 }, { projectSyncStorageVersion: 1 },
      { projectSyncStorageVersion: 2 }]) {
      await expectAsync(openAbsHostStorage('/project', guard, host as AbsHostStoragePort))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_STORAGE_HOST_UNAVAILABLE' }));
    }
  });

  it('passes the project and live synchronous guard to the host and returns no ambient write method', async () => {
    const open = jasmine.createSpy('open').and.resolveTo(storage);
    const result = await openAbsHostStorage('/project', guard, { projectSyncStorageVersion: 2, openProjectSyncStorage: open });
    expect(open).toHaveBeenCalledOnceWith('/project', guard);
    expect(await result.read('prepared.json')).toBeNull();
    expect((result as any).replace).toBeUndefined();
  });

  it('rejects a stale context before invoking the host', async () => {
    const open = jasmine.createSpy('open').and.resolveTo(storage);
    await expectAsync(openAbsHostStorage('/project', () => { throw new Error('stale'); }, {
      projectSyncStorageVersion: 2, openProjectSyncStorage: open,
    })).toBeRejectedWithError('stale');
    expect(open).not.toHaveBeenCalled();
  });

  it('checks context again after the asynchronous host open', async () => {
    let current = true;
    await expectAsync(openAbsHostStorage('/project', () => { if (!current) throw new Error('stale'); }, {
      projectSyncStorageVersion: 2, openProjectSyncStorage: async () => { current = false; return storage; },
    })).toBeRejectedWithError('stale');
  });

  it('rejects malformed host capabilities instead of silently bypassing the common lock', async () => {
    for (const value of [null, {}, { read: async () => null }]) {
      await expectAsync(openAbsHostStorage('/project', guard, { projectSyncStorageVersion: 2,
        openProjectSyncStorage: async () => value as AbsHostStorageCapability,
      })).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_STORAGE_HOST_UNAVAILABLE' }));
    }
  });

  it('settles async renderer callbacks explicitly, including rejection, without returning Zone promises to the host', async () => {
    const host: AbsHostStoragePort = { projectSyncStorageVersion: 2, openProjectSyncStorage: async () => ({
      read: storage.read, withLock: operation => new Promise((resolve, reject) => {
        expect(operation({ read: async () => 'value', replace: async () => true }, result => {
          if (result.ok === true) resolve(result.value); else reject(new Error(result.error.message));
        })).toBeUndefined();
      }),
    }) };
    const port = await openAbsHostStorage('/project', guard, host);
    expect(await port.withLock(async locked => ({ text: await locked.read('project.abs') }))).toEqual({ text: 'value' });
    await expectAsync(port.withLock(async () => { await Promise.resolve(); throw new Error('callback failed'); })).toBeRejectedWithError('callback failed');
  });
});
