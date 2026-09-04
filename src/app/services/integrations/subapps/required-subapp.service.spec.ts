import {
  RequiredSubappService,
  RequiredSubappState,
  resolveRequiredSubappState,
} from './required-subapp.service';
import { BehaviorSubject } from 'rxjs';

function catalogEntry(installed: boolean) {
  return {
    id: 'aily-coder-editor',
    installed,
    config: installed ? { id: 'aily-coder-editor' } : null,
  };
}

describe('RequiredSubappService', () => {
  it('reports a detected package without a runnable config as incomplete', () => {
    const incomplete = resolveRequiredSubappState(
      'aily-coder-editor',
      {
        loading: false,
        source: 'cache',
        indexUrl: '',
        installRoot: '',
        apps: [{ ...catalogEntry(true), config: null } as any],
      },
      null,
    );

    expect(incomplete.status).toBe('error');
    expect(incomplete.installed).toBeFalse();
    expect(incomplete.error).toContain('installation is incomplete');
  });

  it('uses the rollback-safe reinstall action for an installed required subapp', async () => {
    const manager: any = {
      state: { apps: [catalogEntry(true)] },
      state$: { pipe: () => undefined },
      progress$: { pipe: () => undefined },
      initialize: jasmine.createSpy('initialize').and.resolveTo(),
      refresh: jasmine.createSpy('refresh').and.resolveTo(),
      install: jasmine.createSpy('install').and.resolveTo(),
      reinstall: jasmine.createSpy('reinstall').and.resolveTo(),
    };
    const service = new RequiredSubappService(manager);

    const result = await service.reinstall('aily-coder-editor');

    expect(result).toEqual({ installedNow: true });
    expect(manager.reinstall).toHaveBeenCalledOnceWith('aily-coder-editor', {
      forceClose: true,
    });
    expect(manager.install).not.toHaveBeenCalled();
  });

  it('repairs an incomplete detected package during the normal startup check', async () => {
    const manager: any = {
      state: { apps: [{ ...catalogEntry(true), config: null }] },
      state$: { pipe: () => undefined },
      progress$: { pipe: () => undefined },
      initialize: jasmine.createSpy('initialize').and.resolveTo(),
      refresh: jasmine.createSpy('refresh').and.resolveTo(),
      install: jasmine.createSpy('install').and.resolveTo(),
      reinstall: jasmine.createSpy('reinstall').and.callFake(async () => {
        manager.state.apps = [catalogEntry(true)];
      }),
    };
    const service = new RequiredSubappService(manager);

    await service.ensureInstalled('aily-coder-editor');

    expect(manager.reinstall).toHaveBeenCalledOnceWith('aily-coder-editor', {
      forceClose: true,
    });
    expect(manager.install).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent retry and reinstall requests', async () => {
    let completeInstall!: () => void;
    const installResult = new Promise<void>((resolve) => {
      completeInstall = resolve;
    });
    const manager: any = {
      state: { apps: [catalogEntry(false)] },
      state$: { pipe: () => undefined },
      progress$: { pipe: () => undefined },
      initialize: jasmine.createSpy('initialize').and.resolveTo(),
      refresh: jasmine.createSpy('refresh').and.resolveTo(),
      install: jasmine.createSpy('install').and.returnValue(installResult),
      reinstall: jasmine.createSpy('reinstall').and.resolveTo(),
    };
    const service = new RequiredSubappService(manager);

    const first = service.ensureInstalled('aily-coder-editor');
    const second = service.reinstall('aily-coder-editor');
    expect(second).toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.install).toHaveBeenCalledTimes(1);
    completeInstall();
    manager.state.apps = [catalogEntry(true)];
    await first;

    expect(manager.reinstall).not.toHaveBeenCalled();
  });

  it('publishes an actionable error after reinstallation fails', async () => {
    const manager: any = {
      state: { apps: [catalogEntry(true)] },
      state$: new BehaviorSubject({
        loading: false,
        apps: [catalogEntry(true)],
      }),
      progress$: new BehaviorSubject(null),
      initialize: jasmine.createSpy('initialize').and.resolveTo(),
      refresh: jasmine.createSpy('refresh').and.resolveTo(),
      install: jasmine.createSpy('install').and.resolveTo(),
      reinstall: jasmine
        .createSpy('reinstall')
        .and.rejectWith(new Error('network offline')),
    };
    const service = new RequiredSubappService(manager);
    let latest: RequiredSubappState | undefined;
    const subscription = service
      .observe('aily-coder-editor')
      .subscribe((state) => (latest = state));

    await expectAsync(
      service.reinstall('aily-coder-editor'),
    ).toBeRejectedWithError('network offline');

    expect(latest?.status).toBe('error');
    expect(latest?.error).toBe('network offline');
    subscription.unsubscribe();
  });
});
