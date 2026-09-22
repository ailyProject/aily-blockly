import { Subject } from 'rxjs';
import { replaceChildToolConfigs } from '../../configs/tool.config';
import { SubappManagerService, bootstrapDefaultSubapps } from '@integration/subapps/public-api';
import { AppStoreService } from './app-store.service';

function entry(id = 'new-app', extra: any = {}) {
  return {
    id, toolId: id, installed: true, config: { id }, enabled: true, only: 'all',
    app: { defaultToolbar: true }, ...extra,
  };
}

describe('first-install subapp toolbar defaults', () => {
  let previousApi: unknown;
  const managers: SubappManagerService[] = [];

  beforeEach(() => { previousApi = (window as any).electronAPI; });
  afterEach(() => {
    managers.splice(0).forEach(manager => manager.ngOnDestroy());
    (window as any).electronAPI = previousApi;
    replaceChildToolConfigs([]);
  });

  async function createHarness(data: any = {}, initial = [entry()], product = 'aily coder') {
    let catalog = initial;
    let saved = structuredClone(data);
    const config = {
      data: structuredClone(data),
      configReloaded$: new Subject<void>(),
      getApplicationName: () => product,
      getSubappIndexUrl: () => 'https://example.test/subapp-index.json',
      save: jasmine.createSpy('save').and.callFake(async () => { saved = structuredClone(config.data); }),
    };
    const result = () => ({ source: 'network', apps: catalog });
    (window as any).electronAPI = { subapps: {
      list: async () => result(),
      install: async ({ id }: { id: string }) => {
        catalog = catalog.map(item => item.id === id ? { ...item, installed: true, config: { id } } : item);
        return result();
      },
    } };
    const manager = new SubappManagerService({ onLangChange: new Subject(), currentLang: 'en' } as any, config as any);
    managers.push(manager);
    const store = new AppStoreService(config as any, manager);
    await manager.initializeForBootstrap();
    return { config, manager, store, saved: () => structuredClone(saved),
      replace: async (items: any[]) => { catalog = items; await manager.refresh(false); },
    };
  }

  it('applies once on fresh startup and persists the decision together with the layout', async () => {
    const h = await createHarness();
    expect(h.store.isAppInZone('header', 'new-app')).toBeFalse();
    await h.store.initializeSubappToolbarDefaults();
    expect(h.saved().toolbarAppIds).toEqual(['code-viewer', 'cloud-space', 'user-center', 'new-app']);
    expect(h.saved().subappToolbarDefaults['new-app']).toBe('applied');
    await h.store.initializeSubappToolbarDefaults();
    await h.replace([entry()]);
    expect(h.config.save).toHaveBeenCalledTimes(1);
  });

  it('preserves manual unpinning after restart, update and reinstall', async () => {
    const h = await createHarness();
    await h.store.initializeSubappToolbarDefaults();
    h.store.removeAppFromZone('header', 'new-app');
    expect(h.saved().subappToolbarDefaults['new-app']).toBe('manual');
    const next = await createHarness(h.saved());
    await next.store.initializeSubappToolbarDefaults();
    await next.replace([entry('new-app', { installed: false, config: null })]);
    await next.replace([entry('new-app', { installedVersion: '2.0.0' })]);
    expect(next.store.isAppInZone('header', 'new-app')).toBeFalse();
    expect(next.config.save).not.toHaveBeenCalled();
  });

  it('preserves a manually reordered toolbar after restart', async () => {
    const h = await createHarness();
    await h.store.initializeSubappToolbarDefaults();
    h.store.setZoneApps('header', ['new-app', 'user-center', 'cloud-space']);
    const next = await createHarness(h.saved());
    await next.store.initializeSubappToolbarDefaults();
    expect(next.store.getZoneIds('header')).toEqual(['new-app', 'user-center', 'cloud-space']);
  });

  it('preserves existing saved layouts on upgrade, including an explicitly empty layout', async () => {
    for (const toolbarAppIds of [[], ['cloud-space', 'user-center']]) {
      const h = await createHarness({ toolbarAppIds });
      await h.store.initializeSubappToolbarDefaults();
      expect(h.store.isAppInZone('header', 'new-app')).toBeFalse();
      expect(h.saved().subappToolbarDefaults['new-app']).toBe('preserved');
    }
  });

  it('applies to a newly auto-installed app even with an existing saved layout', async () => {
    const h = await createHarness({ toolbarAppIds: ['user-center'] }, [entry('new-app', {
      installed: false, config: null, app: { autoInstall: true, defaultToolbar: true },
    })]);
    await bootstrapDefaultSubapps({
      initialize: () => h.store.initializeSubappToolbarDefaults(),
      readCatalog: () => h.manager.state.apps,
      isAvailable: () => true,
      install: id => h.manager.install(id),
      onError: (_id, error) => { throw error; },
    });
    expect(h.saved().toolbarAppIds).toEqual(['user-center', 'new-app']);
    expect(h.saved().subappToolbarDefaults['new-app']).toBe('applied');
  });

  it('also applies when installation completes later from the app store', async () => {
    const h = await createHarness({ toolbarAppIds: ['user-center'] }, [entry('new-app', { installed: false, config: null })]);
    await h.store.initializeSubappToolbarDefaults();
    expect(h.saved().subappToolbarDefaults['new-app']).toBeUndefined();
    await h.manager.install('new-app');
    expect(h.store.isAppInZone('header', 'new-app')).toBeTrue();
  });

  it('does not evict entries or retry a full toolbar after the user frees space', async () => {
    const others = Array.from({ length: 7 }, (_, i) => entry(`existing-${i}`, { app: {} }));
    const toolbarAppIds = ['user-center', ...others.map(item => item.toolId)];
    const h = await createHarness({ toolbarAppIds, subappToolbarDefaults: {} }, [...others, entry()]);
    await h.store.initializeSubappToolbarDefaults();
    expect(h.store.getZoneIds('header')).toEqual(toolbarAppIds);
    expect(h.saved().subappToolbarDefaults['new-app']).toBe('skipped-full');
    expect(h.store.addAppToZone('header', 'new-app')).toBeFalse();
    h.store.removeAppFromZone('header', 'existing-0');
    const next = await createHarness(h.saved(), [...others, entry()]);
    await next.store.initializeSubappToolbarDefaults();
    expect(next.store.isAppInZone('header', 'new-app')).toBeFalse();
    expect(next.store.getZoneIds('header').length).toBe(7);
    expect(next.store.addAppToZone('header', 'new-app')).toBeTrue();
  });

  it('handles multiple default apps competing for the last free slot without duplicates', async () => {
    const others = Array.from({ length: 6 }, (_, i) => entry(`existing-${i}`, { app: {} }));
    const toolbarAppIds = ['user-center', ...others.map(item => item.toolId)];
    const apps = [...others, entry('first'), entry('second')];
    const h = await createHarness({ toolbarAppIds, subappToolbarDefaults: {} }, apps);
    await h.store.initializeSubappToolbarDefaults();
    await h.replace(apps);
    expect(h.store.getZoneIds('header')).toEqual([...toolbarAppIds, 'first']);
    expect(h.saved().subappToolbarDefaults['second']).toBe('skipped-full');
    expect(h.config.save).toHaveBeenCalledTimes(1);
  });

  it('uses catalog ids for decisions and tool aliases for placement', async () => {
    const h = await createHarness({}, [entry('catalog-id', { toolId: 'alias' })]);
    await h.store.initializeSubappToolbarDefaults();
    expect(h.saved().subappToolbarDefaults['catalog-id']).toBe('applied');
    expect(h.store.isAppInZone('header', 'alias')).toBeTrue();
    h.store.removeAppFromZone('header', 'alias');
    expect(h.saved().subappToolbarDefaults['catalog-id']).toBe('manual');
  });

  it('skips other products, disabled, uninstalling and incomplete apps', async () => {
    const h = await createHarness({}, [
      entry('blockly-only', { only: 'aily blockly' }),
      entry('disabled', { enabled: false }),
      entry('app-disabled', { app: { enabled: false, defaultToolbar: true } }),
      entry('uninstalling', { uninstalling: true }),
      entry('incomplete', { config: null }),
    ]);
    await h.store.initializeSubappToolbarDefaults();
    expect(h.saved().subappToolbarDefaults).toEqual({});
    expect(h.store.getZoneIds('header')).toEqual(['code-viewer', 'cloud-space', 'user-center']);
  });

  it('does not consume a different-product app until the matching product starts', async () => {
    const apps = [entry('coder-only', { only: 'aily coder' })];
    const h = await createHarness({}, apps, 'aily blockly');
    await h.store.initializeSubappToolbarDefaults();
    expect(h.saved().subappToolbarDefaults).toEqual({});
    const next = await createHarness(h.saved(), apps, 'aily coder');
    await next.store.initializeSubappToolbarDefaults();
    expect(next.store.isAppInZone('header', 'coder-only')).toBeTrue();
  });

  it('does not apply newly enabled defaults to an app already installed with defaults off', async () => {
    const h = await createHarness({}, [entry('new-app', { app: { defaultToolbar: false } })]);
    await h.store.initializeSubappToolbarDefaults();
    await h.replace([entry()]);
    expect(h.store.isAppInZone('header', 'new-app')).toBeFalse();
    expect(h.saved().subappToolbarDefaults['new-app']).toBe('disabled');
  });

  it('does not pin extension apps even if they declare defaultToolbar', async () => {
    const h = await createHarness({}, [entry('editor', { extension: true })]);
    await h.store.initializeSubappToolbarDefaults();
    expect(h.store.isAppInZone('header', 'editor')).toBeFalse();
    expect(h.saved().subappToolbarDefaults['editor']).toBe('disabled');
  });

  it('preserves a manual unpin made before startup initialization has completed', async () => {
    const h = await createHarness({ toolbarAppIds: ['new-app', 'user-center'] });
    h.store.removeAppFromZone('header', 'new-app');
    await h.store.initializeSubappToolbarDefaults();
    expect(h.saved().subappToolbarDefaults['new-app']).toBe('manual');
    expect(h.store.isAppInZone('header', 'new-app')).toBeFalse();
  });

  it('does not let default-layout fallback reapply a processed app', async () => {
    const h = await createHarness({ subappToolbarDefaults: { 'new-app': 'manual' } });
    await h.store.initializeSubappToolbarDefaults();
    await h.replace([entry()]);
    expect(h.store.isAppInZone('header', 'new-app')).toBeFalse();
  });

  it('retries failed persistence without adding duplicate toolbar entries', async () => {
    const h = await createHarness();
    spyOn(console, 'error');
    h.config.save.and.rejectWith(new Error('disk full'));
    await h.store.initializeSubappToolbarDefaults();
    expect(h.config.data.subappToolbarDefaults).toBeUndefined();
    h.config.save.and.resolveTo();
    await h.store.initializeSubappToolbarDefaults();
    expect(h.config.data.subappToolbarDefaults['new-app']).toBe('applied');
    expect(h.store.getZoneIds('header').filter(id => id === 'new-app').length).toBe(1);
  });

  it('does not roll back a newer manual choice when an earlier default save fails', async () => {
    const h = await createHarness();
    spyOn(console, 'error');
    let reject!: (error: Error) => void;
    h.config.save.and.returnValue(new Promise<void>((_resolve, fail) => { reject = fail; }));
    const pending = h.store.initializeSubappToolbarDefaults();
    h.config.save.and.resolveTo();
    h.store.removeAppFromZone('header', 'new-app');
    reject(new Error('disk full'));
    await pending;
    expect(h.config.data.subappToolbarDefaults['new-app']).toBe('manual');
    expect(h.store.isAppInZone('header', 'new-app')).toBeFalse();
  });
});
