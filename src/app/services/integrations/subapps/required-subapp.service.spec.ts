import {
  RequiredSubappService,
  RequiredSubappState,
  resolveRequiredSubappState,
} from './required-subapp.service';
import { BehaviorSubject } from 'rxjs';
import { bootstrapDefaultSubapps } from './bootstrap/default-subapps-bootstrap';

function catalogEntry(installed: boolean) {
  return {
    id: 'aily-coder-editor',
    installed,
    config: installed ? { id: 'aily-coder-editor' } : null,
  };
}

describe('RequiredSubappService', () => {
  it('shares one installation between the Coder startup notice and catalog bootstrap', async () => {
    let finishInstall!: () => void;
    let bootstrapJoined!: () => void;
    const installResult = new Promise<void>(resolve => { finishInstall = resolve; });
    const joined = new Promise<void>(resolve => { bootstrapJoined = resolve; });
    const item = {
      ...catalogEntry(false), toolId: 'aily-coder-editor', only: 'aily coder',
      app: { autoInstall: true, defaultToolbar: false },
    };
    const manager: any = {
      state: { apps: [item] },
      initialize: jasmine.createSpy('initialize').and.resolveTo(),
      install: jasmine.createSpy('install').and.callFake(async () => {
        await installResult;
        manager.state.apps = [{ ...item, ...catalogEntry(true) }];
      }),
    };
    const required = new RequiredSubappService(manager);
    const fromNotice = required.ensureInstalled('aily-coder-editor');
    const fromCatalog = bootstrapDefaultSubapps({
      initialize: () => manager.initialize(),
      readCatalog: () => manager.state.apps,
      isAvailable: entry => entry.only === 'aily coder',
      install: async id => {
        const pending = required.ensureInstalled(id);
        bootstrapJoined();
        await pending;
      },
      onError: (_id, error) => { throw error; },
    });
    await joined;
    expect(manager.install).toHaveBeenCalledOnceWith('aily-coder-editor');
    finishInstall();
    await Promise.all([fromNotice, fromCatalog]);
    expect(manager.install).toHaveBeenCalledTimes(1);
    expect(manager.state.apps[0].installed).toBeTrue();
  });

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

  it('does not reinstall a required subapp while its uninstall cleanup is incomplete', async () => {
    const manager: any = {
      state: { apps: [{ ...catalogEntry(false), uninstalling: true }] },
      state$: { pipe: () => undefined },
      progress$: { pipe: () => undefined },
      initialize: jasmine.createSpy('initialize').and.resolveTo(),
      refresh: jasmine.createSpy('refresh').and.resolveTo(),
      install: jasmine.createSpy('install').and.resolveTo(),
      reinstall: jasmine.createSpy('reinstall').and.resolveTo(),
    };
    const service = new RequiredSubappService(manager);

    await expectAsync(service.ensureInstalled('aily-coder-editor'))
      .toBeRejectedWithError(/uninstall must be completed/);

    expect(manager.install).not.toHaveBeenCalled();
    expect(manager.reinstall).not.toHaveBeenCalled();
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
