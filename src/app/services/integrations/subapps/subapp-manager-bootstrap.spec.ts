import { Subject } from 'rxjs';
import { getChildToolConfig, getChildToolAppItems, replaceChildToolConfigs } from '../../../configs/tool.config';
import { SubappManagerService } from './subapp-manager.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('SubappManagerService bootstrap catalog readiness', () => {
  let previousApi: unknown;
  let service: SubappManagerService;
  let list: jasmine.Spy;

  beforeEach(() => {
    previousApi = (window as any).electronAPI;
    list = jasmine.createSpy('list');
    (window as any).electronAPI = { subapps: { list } };
    service = new SubappManagerService({
      onLangChange: new Subject(), currentLang: 'en',
    } as any, {
      configReloaded$: new Subject(), getSubappIndexUrl: () => 'https://example.test/subapp-index.json',
    } as any);
  });

  afterEach(() => {
    service.ngOnDestroy();
    (window as any).electronAPI = previousApi;
    replaceChildToolConfigs([]);
  });

  it('shares the existing background refresh and waits for newly declared policies', async () => {
    const refresh = deferred<any>();
    list.and.callFake(({ strategy }: { strategy: string }) => strategy === 'cache-first'
      ? Promise.resolve({ source: 'cache', apps: [] }) : refresh.promise);
    let ready = false;
    const bootstrap = service.initializeForBootstrap().then(() => { ready = true; });
    await service.initialize();
    expect(ready).toBeFalse();
    expect(list).toHaveBeenCalledTimes(2);
    refresh.resolve({ source: 'network', apps: [{
      id: 'new-app', toolId: 'new-app', installed: false, app: { autoInstall: true, defaultToolbar: true },
    }] });
    await bootstrap;
    expect(service.state.apps[0].app?.autoInstall).toBeTrue();
    expect(service.getCatalogApps()[0].id).toBe('new-app');
    await service.initializeForBootstrap();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('keeps cached policies usable when the shared refresh fails', async () => {
    list.and.callFake(({ strategy }: { strategy: string }) => strategy === 'cache-first'
      ? Promise.resolve({ source: 'cache', apps: [{ id: 'cached', app: { autoInstall: true } }] })
      : Promise.reject(new Error('offline')));
    await service.initializeForBootstrap();
    expect(service.state.apps[0].app?.autoInstall).toBeTrue();
    expect(service.state.warning).toBe('offline');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not fetch twice when the first catalog already came from the network', async () => {
    list.and.resolveTo({ source: 'network', apps: [] });
    await service.initializeForBootstrap();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('registers installed headless Agent tools without exposing an iframe launcher', async () => {
    list.and.resolveTo({ source: 'network', apps: [{ id: 'native-tool', toolId: 'native-tool',
      installed: true, enabled: true, app: { enabled: true, ai: true }, config: {
        id: 'native-tool', runtime: { headless: true }, app: { enabled: false, available: false },
        agent: { tools: [{ name: 'native_run' }] },
      } }] });
    await service.initializeForBootstrap();
    expect(getChildToolConfig('native-tool')?.agent?.tools[0].name).toBe('native_run');
    expect(service.state.apps.length).toBe(1);
    expect(service.getCatalogApps()).toEqual([]);
    expect(getChildToolAppItems()).toEqual([]);
  });

  it('exposes an explicitly declared native observer without requiring a UI Runtime', async () => {
    list.and.resolveTo({ source: 'network', apps: [{ id: 'native-tool', toolId: 'native-tool',
      installed: true, enabled: true, config: { id: 'native-tool', runtime: { headless: true, observer: true },
        app: { enabled: true }, routePath: '/child-tool/native-tool' } }] });
    await service.initializeForBootstrap();
    expect(service.getCatalogApps().map(app => app.id)).toEqual(['native-tool']);
    expect(getChildToolAppItems().map(app => app.id)).toEqual(['native-tool']);
    expect(getChildToolConfig('native-tool')?.uiIndex).toBeUndefined();
  });
});
