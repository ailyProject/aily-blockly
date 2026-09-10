import { AppStoreComponent } from './app-store/app-store.component';
import { ChildToolHostComponent } from './child-tool-host/child-tool-host.component';
import { ChildToolProcessService } from '@integration/subapps/public-api';

describe('subapp prepared update UI state', () => {
  const preparedSubapp = {
    installed: true,
    installedVersion: '0.1.32',
    availableVersion: '0.1.33',
    updateStatus: {
      state: 'ready',
      targetVersion: '0.1.33',
      ready: true,
    },
  };

  it('shows restart in App Store only while an old version is open', () => {
    const store = Object.create(AppStoreComponent.prototype) as any;
    let runningVersion = '0.1.32';
    store.activeSubappVersions = new Map();
    store.childToolProcess = { getRuntimeSnapshot: () => ({ running: false }) };
    store.childHostRegistry = { getStatus: () => ({ version: runningVersion }) };
    store.uiService = { isToolOpen: () => true };

    expect(store.isSubappRestartRequired({ id: 'aily-chat', subapp: preparedSubapp })).toBeTrue();

    runningVersion = '0.1.33';
    expect(store.isSubappRestartRequired({ id: 'aily-chat', subapp: preparedSubapp })).toBeFalse();
  });

  it('shows restart in the title only for a running old process', () => {
    const host = Object.create(ChildToolHostComponent.prototype) as any;
    host.subappRestartRequired = false;
    host.hostStatus = 'ready';
    host.childVersion = '0.1.32';
    host.resolvedToolId = 'aily-chat';
    host.subappManager = {
      state: { apps: [{ toolId: 'aily-chat', ...preparedSubapp }] },
    };

    expect(host.isSubappRestartRequired).toBeTrue();

    host.childVersion = '0.1.33';
    expect(host.isSubappRestartRequired).toBeFalse();

    host.childVersion = '0.1.32';
    host.hostStatus = 'closed';
    expect(host.isSubappRestartRequired).toBeFalse();
  });

  it('does not activate a prepared update before an immediate old-version acquire', async () => {
    const service = Object.create(ChildToolProcessService.prototype) as any;
    const config = { id: 'aily-chat', catalogId: 'aily-chat', version: '0.1.32' };
    const session = { refCount: 0, running: false, hostInfo: null };
    service.installReadyUpdateBeforeLaunch = jasmine.createSpy('installReadyUpdateBeforeLaunch');
    service.requireConfig = jasmine.createSpy('requireConfig').and.returnValue(config);
    service.ensureSession = jasmine.createSpy('ensureSession').and.returnValue(session);
    service.cancelReleaseTimer = jasmine.createSpy('cancelReleaseTimer');
    service.publishRuntimeState = jasmine.createSpy('publishRuntimeState');
    service.startSession = jasmine.createSpy('startSession').and.resolveTo({
      url: 'http://127.0.0.1:3000',
      runtimeConfig: config,
    });

    await service.acquire('aily-chat', { deferPreparedUpdate: true });

    expect(service.installReadyUpdateBeforeLaunch).not.toHaveBeenCalled();
    expect(service.startSession).toHaveBeenCalledWith(
      config,
      session,
      { deferPreparedUpdate: true },
    );
  });

  it('passes the immediate-open decision into the main-process launch handshake', async () => {
    const service = Object.create(ChildToolProcessService.prototype) as any;
    const config = { id: 'aily-chat', catalogId: 'aily-chat', version: '0.1.32' };
    const session = { version: '' };
    const prepareLaunch = jasmine.createSpy('prepareLaunch').and.resolveTo({ config, token: 'token' });
    const finishLaunch = jasmine.createSpy('finishLaunch').and.resolveTo(undefined);
    const previousElectronApi = (window as any).electronAPI;
    (window as any).electronAPI = { subapps: { prepareLaunch, finishLaunch } };
    service.acquireSharedSession = jasmine.createSpy('acquireSharedSession').and.resolveTo(null);
    service.startServer = jasmine.createSpy('startServer').and.resolveTo({
      url: 'http://127.0.0.1:3000',
      runtimeConfig: config,
    });
    service.hostShuttingDown = false;

    try {
      await service.startOrAcquireSession(config, session, { deferPreparedUpdate: true });
    } finally {
      (window as any).electronAPI = previousElectronApi;
    }

    expect(prepareLaunch).toHaveBeenCalledWith({
      id: 'aily-chat',
      deferPreparedUpdate: true,
    });
    expect(finishLaunch).toHaveBeenCalledWith('token');
  });
});
