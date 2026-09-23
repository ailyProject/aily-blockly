import { BehaviorSubject } from 'rxjs';

import {
  CoderEditorUpdateService,
  resolveCoderEditorUpdateState,
} from './coder-editor-update.service';
import type {
  SubappCatalogItem,
  SubappCatalogState,
  SubappInstallProgress,
} from './subapp-manager.service';

function catalogItem(overrides: Partial<SubappCatalogItem> = {}): SubappCatalogItem {
  return {
    id: 'aily-coder-editor',
    toolId: 'aily-coder-editor',
    only: 'aily coder',
    packageName: '@aily-project/subapp-aily-coder-editor',
    availableVersion: '0.1.14',
    installedVersion: '0.1.13',
    installed: true,
    updateAvailable: true,
    updateStatus: { state: 'ready', targetVersion: '0.1.14', ready: true },
    updatePolicy: { download: 'background', install: 'next-launch' },
    titleKey: 'AILY_CODER_EDITOR.TITLE',
    namespace: 'AILY_CODER_EDITOR',
    name: 'Aily Coder Editor',
    description: '',
    icon: 'fa-light fa-code',
    enabled: true,
    extension: true,
    config: {} as any,
    ...overrides,
  };
}

function createHarness(item = catalogItem()) {
  const stateSubject = new BehaviorSubject<SubappCatalogState>({
    loading: false,
    source: 'network',
    indexUrl: 'https://example.test/subapp-index.json',
    installRoot: '/app/store',
    apps: [item],
  });
  const progressSubject = new BehaviorSubject<SubappInstallProgress | null>(null);
  const runtimeSubject = new BehaviorSubject<readonly any[]>([]);
  const runtime = {
    toolId: 'aily-coder-editor',
    version: '0.1.13',
    state: 'ready',
    running: true,
    refCount: 2,
    hostInfo: { url: 'http://127.0.0.1:17171/' },
    updatedAt: 1,
  };
  const manager = {
    state$: stateSubject.asObservable(),
    progress$: progressSubject.asObservable(),
    get state() { return stateSubject.value; },
    initialize: jasmine.createSpy('initialize').and.resolveTo(),
    refresh: jasmine.createSpy('refresh').and.resolveTo(),
    downloadUpdate: jasmine.createSpy('downloadUpdate').and.callFake(async () => {
      const next = catalogItem({
        ...stateSubject.value.apps[0],
        updateStatus: { state: 'ready', targetVersion: '0.1.14', ready: true },
      });
      stateSubject.next({ ...stateSubject.value, apps: [next] });
    }),
    installUpdate: jasmine.createSpy('installUpdate').and.resolveTo(),
    update: jasmine.createSpy('update').and.resolveTo(),
  };
  const process = {
    runtimeStates$: runtimeSubject.asObservable(),
    getRuntimeSnapshot: jasmine.createSpy('getRuntimeSnapshot').and.callFake(() => runtime),
    forceStop: jasmine.createSpy('forceStop').and.resolveTo(),
  };
  const service = new CoderEditorUpdateService(manager as any, process as any);
  return { service, manager, process, stateSubject, progressSubject, runtime };
}

describe('CoderEditorUpdateService', () => {
  it('shows a restart update action when the installed package is newer than the running Runtime', () => {
    const item = catalogItem({
      installedVersion: '0.1.14',
      updateAvailable: false,
      updateStatus: { state: 'current', targetVersion: '0.1.14' },
    });
    const state = resolveCoderEditorUpdateState(item, {
      toolId: item.toolId,
      version: '0.1.13',
      state: 'ready',
      running: true,
      refCount: 1,
      hostInfo: null,
      updatedAt: 1,
    }, false, null);

    expect(state.state).toBe('restart-required');
    expect(state.visible).toBeTrue();
    expect(state.actionable).toBeTrue();
  });

  it('shows the Aily Chat-style restart action when a prepared update is newer than the running Runtime', () => {
    const item = catalogItem({
      installedVersion: '0.1.13',
      availableVersion: '0.1.14',
      updateAvailable: true,
      updateStatus: { state: 'ready', targetVersion: '0.1.14', ready: true },
    });
    const state = resolveCoderEditorUpdateState(item, {
      toolId: item.toolId,
      version: '0.1.13',
      state: 'ready',
      running: true,
      refCount: 1,
      hostInfo: null,
      updatedAt: 1,
    }, false, null);

    expect(state.state).toBe('restart-required');
    expect(state.visible).toBeTrue();
    expect(state.actionable).toBeTrue();
  });

  it('downloads and installs a discovered Coder Editor update before first launch', async () => {
    const item = catalogItem({
      updateStatus: { state: 'available', targetVersion: '0.1.14', ready: false },
    });
    const h = createHarness(item);
    h.runtime.running = false;

    expect(await h.service.ensureUpdatedBeforeLaunch()).toBeTrue();

    expect(h.manager.refresh).toHaveBeenCalledOnceWith(true);
    expect(h.manager.downloadUpdate).toHaveBeenCalledOnceWith('aily-coder-editor');
    expect(h.manager.installUpdate).toHaveBeenCalledOnceWith(
      'aily-coder-editor',
      { forceClose: true },
    );
    expect(h.process.forceStop).not.toHaveBeenCalled();
  });

  it('saves every retained Coder workspace, installs once, then reloads every surface', async () => {
    const h = createHarness();
    const order: string[] = [];
    h.process.forceStop.and.callFake(async () => { order.push('stop'); });
    h.manager.installUpdate.and.callFake(async () => {
      order.push('install');
      const installed = catalogItem({
        ...h.stateSubject.value.apps[0],
        installedVersion: '0.1.14',
        updateAvailable: false,
        updateStatus: { state: 'current', targetVersion: '0.1.14' },
      });
      h.stateSubject.next({ ...h.stateSubject.value, apps: [installed] });
    });
    h.service.registerClient({
      prepareForUpdate: async () => { order.push('save-a'); },
      reloadAfterUpdate: async () => {
        order.push('reload-a');
        h.runtime.version = '0.1.14';
      },
    });
    h.service.registerClient({
      prepareForUpdate: async () => { order.push('save-b'); },
      reloadAfterUpdate: async () => { order.push('reload-b'); },
    });

    expect(await h.service.updateAndRestart()).toBeTrue();

    expect(order.slice(0, 2).sort()).toEqual(['save-a', 'save-b']);
    expect(order[2]).toBe('stop');
    expect(order[3]).toBe('install');
    expect(order.slice(4).sort()).toEqual(['reload-a', 'reload-b']);
    expect(h.process.forceStop).toHaveBeenCalledOnceWith('aily-coder-editor');
    expect(h.manager.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not report success when the reloaded Runtime is still on the old version', async () => {
    const h = createHarness();
    h.manager.installUpdate.and.callFake(async () => {
      const installed = catalogItem({
        ...h.stateSubject.value.apps[0],
        installedVersion: '0.1.14',
        updateAvailable: false,
        updateStatus: { state: 'current', targetVersion: '0.1.14' },
      });
      h.stateSubject.next({ ...h.stateSubject.value, apps: [installed] });
    });
    h.service.registerClient({
      prepareForUpdate: async () => undefined,
      reloadAfterUpdate: async () => undefined,
    });

    await expectAsync(h.service.updateAndRestart()).toBeRejectedWithError(/运行版本校验失败/);
  });
});
