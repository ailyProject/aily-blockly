import {
  SERVICE_REGION_LOGIN_REASON,
  switchServiceRegionAndRequestLogin,
} from './service-region-switch';

describe('switchServiceRegionAndRequestLogin', () => {
  it('invalidates the old local session and runtime before switching and opening login', async () => {
    const calls: string[] = [];

    await switchServiceRegionAndRequestLogin('eu', {
      closeProtectedTools: async () => { calls.push('close-protected-tools'); },
      clearLocalAuthSession: async () => { calls.push('clear-local-auth'); },
      stopProtectedRuntime: async () => { calls.push('stop-protected-runtime'); },
      setRegion: async (regionKey) => { calls.push(`set-region:${regionKey}`); },
      requestLogin: (reason) => { calls.push(`request-login:${reason}`); },
    });

    expect(calls).toEqual([
      'close-protected-tools',
      'clear-local-auth',
      'stop-protected-runtime',
      'clear-local-auth',
      'set-region:eu',
      `request-login:${SERVICE_REGION_LOGIN_REASON}`,
    ]);
  });

  it('does not switch region or request login when local session invalidation fails', async () => {
    const setRegion = jasmine.createSpy('setRegion');
    const requestLogin = jasmine.createSpy('requestLogin');

    await expectAsync(switchServiceRegionAndRequestLogin('eu', {
      closeProtectedTools: async () => undefined,
      clearLocalAuthSession: async () => { throw new Error('local auth clear failed'); },
      stopProtectedRuntime: async () => undefined,
      setRegion,
      requestLogin,
    })).toBeRejectedWithError('local auth clear failed');

    expect(setRegion).not.toHaveBeenCalled();
    expect(requestLogin).not.toHaveBeenCalled();
  });

  it('does not open login until the new region has been applied', async () => {
    const requestLogin = jasmine.createSpy('requestLogin');

    await expectAsync(switchServiceRegionAndRequestLogin('eu', {
      closeProtectedTools: async () => undefined,
      clearLocalAuthSession: async () => undefined,
      stopProtectedRuntime: async () => undefined,
      setRegion: async () => { throw new Error('switch failed'); },
      requestLogin,
    })).toBeRejectedWithError('switch failed');

    expect(requestLogin).not.toHaveBeenCalled();
  });

  it('does not invalidate the session or switch region when a protected tool cannot close', async () => {
    const clearLocalAuthSession = jasmine.createSpy('clearLocalAuthSession');
    const stopProtectedRuntime = jasmine.createSpy('stopProtectedRuntime');
    const setRegion = jasmine.createSpy('setRegion');
    const requestLogin = jasmine.createSpy('requestLogin');

    await expectAsync(switchServiceRegionAndRequestLogin('eu', {
      closeProtectedTools: async () => { throw new Error('close failed'); },
      clearLocalAuthSession,
      stopProtectedRuntime,
      setRegion,
      requestLogin,
    })).toBeRejectedWithError('close failed');

    expect(clearLocalAuthSession).not.toHaveBeenCalled();
    expect(stopProtectedRuntime).not.toHaveBeenCalled();
    expect(setRegion).not.toHaveBeenCalled();
    expect(requestLogin).not.toHaveBeenCalled();
  });
});
