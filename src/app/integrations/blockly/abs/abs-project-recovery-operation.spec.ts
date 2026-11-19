import { ProjectService } from '@domain/project/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';

describe('failed-load same-project operation receipts', () => {
  let service: any, reload: jasmine.Spy, inspect: jasmine.Spy;
  const request = 'recover-project-request';
  let previous: any;
  beforeEach(() => {
    previous = window['fs'];
    const files = new Map<string, string>();
    window['fs'] = { projectSyncStorageVersion: 2, openProjectSyncStorage: async (project, guard) => {
      const read = async key => { guard(); return files.get(`${project}/${key}`) ?? null; };
      return { read, withLock: operation => new Promise((resolve, reject) => operation({ read,
        replace: async (key, expected, text) => {
          const before = await read(key);
          if ((before === null ? null : `sha256:${await sha256Hex(before)}`) !== expected) return false;
          files.set(`${project}/${key}`, text); return true;
        } }, result => result.ok ? resolve(result.value) : reject(new Error(result.error.message)))) };
    } } as any;
    reload = jasmine.createSpy('reload same project').and.resolveTo({ ok: true, project: '/project', ready: true,
      loadStatus: { ready: true, state: 'loaded' } });
    inspect = jasmine.createSpy('current temporary write admission').and.resolveTo({ project: '/project', abiHash: 'verified-current' });
    service = Object.create(ProjectService.prototype);
    Object.defineProperty(service, 'currentProjectPath', { value: '/project', writable: true });
    Object.assign(service, { recoveryTargets: { inspect },
      assertSavedRecoveryContext: () => {}, reloadSavedRecoveryTarget: reload,
      getBlocklyProjectLoadStatus: () => ({ ready: true, state: 'loaded' }) });
  });
  afterEach(() => window['fs'] = previous);
  it('observes the original request after readiness without replaying navigation or claiming its candidate applied', async () => {
    const first = await service.recoverFailedBlocklyProject(request);
    expect(first.ok).toBeTrue(); expect(first.ready).toBeTrue(); expect(first.candidateApplied).toBeFalse();
    expect(first.receipt).toEqual({ version: 2, requestId: request, action: 'recover_project', candidateApplied: false });
    expect(await service.recoverFailedBlocklyProject(request, true)).toEqual(first);
    expect(await service.recoverFailedBlocklyProject(request)).toEqual(first);
    expect(reload).toHaveBeenCalledOnceWith('/project'); expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('does not replay an unknown request after restart or use an old receipt on another project', async () => {
    expect((await service.recoverFailedBlocklyProject('unknown-original-request', true)).code).toBe('PROJECT_RECOVERY_REQUEST_UNKNOWN');
    expect(reload).not.toHaveBeenCalled();
    await service.recoverFailedBlocklyProject(request); service.currentProjectPath = '/new-project';
    expect((await service.recoverFailedBlocklyProject(request, true)).code).toBe('PROJECT_RECOVERY_CONTEXT_STALE');
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('retains a failed reload result for observation instead of creating another project', async () => {
    reload.and.resolveTo({ ok: false, ready: false, loadStatus: { ready: false, state: 'error', error: 'Missing library definition' } });
    const first = await service.recoverFailedBlocklyProject(request);
    expect(first.code).toBe('PROJECT_RECOVERY_LOAD_FAILED'); expect(first.message).toBe('Missing library definition');
    expect(await service.recoverFailedBlocklyProject(request, true)).toEqual(first);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('reads the original completed result after host recreation without another runtime reload', async () => {
    const first = await service.recoverFailedBlocklyProject(request);
    service.failedLoadRecoveries = undefined;
    const observed = await service.recoverFailedBlocklyProject(request, true);
    expect(observed).toEqual({ ...first, recoveryObservation: { durable: true, resultKnown: true } });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await service.recoverFailedBlocklyProject(request)).toEqual(observed);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
