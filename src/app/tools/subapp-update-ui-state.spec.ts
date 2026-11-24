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
    service.requireConfig = jasmine.createSpy('requireConfig').and.returnValue(config);
    service.ensureSession = jasmine.createSpy('ensureSession').and.returnValue(session);
    service.cancelReleaseTimer = jasmine.createSpy('cancelReleaseTimer');
    service.publishRuntimeState = jasmine.createSpy('publishRuntimeState');
    service.startSession = jasmine.createSpy('startSession').and.resolveTo({
      url: 'http://127.0.0.1:3000',
      runtimeConfig: config,
    });

    await service.acquire('aily-chat', { deferPreparedUpdate: true });

    expect(service.startSession).toHaveBeenCalledWith(
      config,
      session,
      { deferPreparedUpdate: true },
      true,
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

  it('selects the current installation again when files changed before dispatch', async () => {
    const service = Object.create(ChildToolProcessService.prototype) as any;
    const before = { id: 'serial-debugger', catalogId: 'serial-debugger', version: '0.1.32' };
    const after = { ...before, version: '0.1.33' };
    const runtime = { url: 'http://127.0.0.1:3000', runtimeConfig: after };
    const session = { version: '' };
    const prepareLaunch = jasmine.createSpy('prepareLaunch').and.returnValues(
      Promise.resolve({ config: before, token: 'before' }),
      Promise.resolve({ config: after, token: 'after' }),
    );
    const finishLaunch = jasmine.createSpy('finishLaunch').and.resolveTo(undefined);
    const previousElectronApi = (window as any).electronAPI;
    (window as any).electronAPI = { subapps: { prepareLaunch, finishLaunch } };
    service.acquireSharedSession = jasmine.createSpy('acquireSharedSession').and.resolveTo(null);
    service.startServer = jasmine.createSpy('startServer').and.callFake(async (_config, _session, token) => {
      if (token === 'before') throw new Error('SUBAPP_LAUNCH_CHANGED: installation replaced');
      return runtime;
    });

    try {
      await expectAsync(service.startOrAcquireSession(before, session)).toBeResolvedTo(runtime);
    } finally {
      (window as any).electronAPI = previousElectronApi;
    }

    expect(prepareLaunch.calls.count()).toBe(2);
    expect(finishLaunch.calls.allArgs()).toEqual([['before'], ['after']]);
    expect(session.version).toBe(after.version);
  });

  it('replaces only the verified stale Blockly Chat stream, even when the version is the same', async () => {
    const service = Object.create(ChildToolProcessService.prototype) as any;
    const oldConfig = { id: 'aily-chat', catalogId: 'aily-chat', version: '0.1.53' };
    const fingerprint = { inputHash: '1'.repeat(64), outputHash: '2'.repeat(64) };
    const config = { ...oldConfig, blocklyChatFingerprint: fingerprint };
    const oldHost = { url: 'http://127.0.0.1:3000', runtimeConfig: oldConfig };
    const newHost = { url: 'http://127.0.0.1:3001', runtimeConfig: config };
    const prepareLaunch = jasmine.createSpy('prepareLaunch').and.resolveTo({ config, token: 'token' });
    const finishLaunch = jasmine.createSpy('finishLaunch').and.resolveTo(undefined);
    const verifyBlocklyChat = jasmine.createSpy('verifyBlocklyChat').and.resolveTo('incompatible');
    const oldStream = 'old-chat-stream';
    const acquire = jasmine.createSpy('acquire').and.resolveTo({ hostInfo: oldHost, streamId: oldStream, refCount: 2 });
    const restart = jasmine.createSpy('restart').and.resolveTo({ success: true });
    const previousElectronApi = (window as any).electronAPI;
    const previousSessions = (window as any).childToolSession;
    (window as any).electronAPI = { subapps: { prepareLaunch, finishLaunch, verifyBlocklyChat } };
    (window as any).childToolSession = { acquire, restart };
    service.configService = { isCoderProduct: () => false };
    service.startServer = jasmine.createSpy('startServer').and.resolveTo(newHost);
    service.log = jasmine.createSpy('log');

    const session = { version: '', leaseId: 'original-renderer' };
    try {
      await expectAsync(service.startOrAcquireSession(oldConfig, session)).toBeResolvedTo(newHost);
    } finally {
      (window as any).electronAPI = previousElectronApi;
      (window as any).childToolSession = previousSessions;
    }

    expect(prepareLaunch).toHaveBeenCalledBefore(acquire);
    expect(verifyBlocklyChat).toHaveBeenCalledOnceWith({ url: oldHost.url, fingerprint, retryUnavailable: true });
    expect(restart).toHaveBeenCalledOnceWith({
      toolId: 'aily-chat', streamId: oldStream, leaseId: session.leaseId, restartShared: true,
    });
    expect(service.startServer).toHaveBeenCalledOnceWith(config, session, 'token');
    expect(finishLaunch).toHaveBeenCalledWith('token');
  });

  it('releases only the new Chat lease if live evidence remains unavailable, then attaches once verified', async () => {
    const service = Object.create(ChildToolProcessService.prototype) as any;
    const fingerprint = { inputHash: '1'.repeat(64), outputHash: '2'.repeat(64) };
    const config = { id: 'aily-chat', catalogId: 'aily-chat', version: '0.1.53', blocklyChatFingerprint: fingerprint };
    const hostInfo = { url: 'http://127.0.0.1:3000', runtimeConfig: config };
    const streamId = 'verified-shared-chat';
    const session = { version: '', leaseId: 'new-renderer', running: false, hostInfo: null };
    const prepareLaunch = jasmine.createSpy('prepareLaunch').and.resolveTo({ config, token: 'token' });
    const finishLaunch = jasmine.createSpy('finishLaunch').and.resolveTo(undefined);
    const verifyBlocklyChat = jasmine.createSpy('verifyBlocklyChat').and.resolveTo('unavailable');
    const acquire = jasmine.createSpy('acquire').and.resolveTo({ hostInfo, streamId, refCount: 2 });
    const release = jasmine.createSpy('release').and.resolveTo({ success: true });
    const restart = jasmine.createSpy('restart');
    const previousElectronApi = (window as any).electronAPI;
    const previousSessions = (window as any).childToolSession;
    (window as any).electronAPI = { subapps: { prepareLaunch, finishLaunch, verifyBlocklyChat } };
    (window as any).childToolSession = { acquire, release, restart };
    service.configService = { isCoderProduct: () => false, getCurrentApiServer: () => '' };
    service.startServer = jasmine.createSpy('startServer');
    service.publishRuntimeState = jasmine.createSpy('publishRuntimeState');
    service.log = jasmine.createSpy('log');

    try {
      await expectAsync(service.startOrAcquireSession(config, session)).toBeRejectedWithError(/could not confirm/);
      expect(release).toHaveBeenCalledOnceWith({ toolId: config.id, streamId, leaseId: session.leaseId });
      expect(session.running).toBeFalse();
      expect(session.hostInfo).toBeNull();
      verifyBlocklyChat.and.resolveTo('verified');
      await expectAsync(service.startOrAcquireSession(config, session)).toBeResolvedTo(hostInfo);
    } finally {
      (window as any).electronAPI = previousElectronApi;
      (window as any).childToolSession = previousSessions;
    }

    expect(session.running).toBeTrue();
    expect(restart).not.toHaveBeenCalled();
    expect(service.startServer).not.toHaveBeenCalled();
    expect(finishLaunch.calls.count()).toBe(2);
  });

  it('keeps the verified Chat endpoint private until the startup handshake completes', () => {
    const service = Object.create(ChildToolProcessService.prototype) as any;
    const config = { id: 'aily-chat', blocklyChatFingerprint: { inputHash: '1'.repeat(64), outputHash: '2'.repeat(64) } };
    const readyResolve = jasmine.createSpy('readyResolve');
    const session = { hostInfo: null, running: false, readyResolve };
    const hostInfo = { url: 'http://127.0.0.1:3001' };
    service.publishRuntimeState = jasmine.createSpy('publishRuntimeState');

    service.handleBackendMessage(config, session, { event: 'ready', data: hostInfo });

    expect(readyResolve).toHaveBeenCalledOnceWith(hostInfo);
    expect(session.readyResolve).toBeNull();
    expect(session.hostInfo).toBeNull();
    expect(session.running).toBeFalse();
    expect(service.publishRuntimeState).not.toHaveBeenCalled();
  });

  it('continues an interrupted uninstall instead of invoking install from the app card', () => {
    const store = Object.create(AppStoreComponent.prototype) as any;
    store.runSubappAction = jasmine.createSpy('runSubappAction');
    const app = {
      id: 'aily-chat',
      subapp: {
        catalogId: 'aily-chat',
        installed: false,
        uninstalling: true,
      },
    };

    store.openApp(app);

    expect(store.runSubappAction).toHaveBeenCalledWith('uninstall', app);
  });
});
