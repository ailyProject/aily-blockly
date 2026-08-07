import { BehaviorSubject, Subject } from 'rxjs';
import { AppStoreService } from './app-store.service';
import type { AppItem } from './app-store.config';

describe('AppStoreService subapp layout restoration', () => {
  it('preserves a pinned subapp while the catalog loads and restores it when ready', () => {
    const configService = {
      data: {
        toolbarAppIds: [
          'serial-monitor',
          'aily-chat',
          'cloud-space',
          'ble-debugger',
          'user-center',
          'code-viewer',
        ],
      },
      configReloaded$: new Subject<void>(),
      save: jasmine.createSpy('save').and.resolveTo(),
    };
    const catalogState = new BehaviorSubject({ loading: true });
    let catalogApps: AppItem[] = [];
    const subappManager = {
      state$: catalogState.asObservable(),
      get state() {
        return catalogState.value;
      },
      getCatalogApps: () => catalogApps,
    };

    const service = new AppStoreService(configService as any, subappManager as any);
    expect(service.getZoneIds('header')).toContain('ble-debugger');
    expect(service.getAppsForZone('header').map((app) => app.id)).not.toContain('aily-chat');

    catalogApps = [{
      id: 'ble-debugger',
      name: 'BLE Debugger',
      icon: 'fa-light fa-puzzle-piece',
      enabled: true,
      subapp: {
        catalogId: 'ble-debugger',
        packageName: '@aily-project/subapp-ble-debugger',
        availableVersion: '0.1.0',
        installedVersion: '0.1.0',
        installed: true,
        updateAvailable: false,
      },
    }];
    catalogState.next({ loading: false });

    expect(service.getZoneIds('header')).toContain('ble-debugger');
    expect(service.getZoneIds('header')).not.toContain('aily-chat');
    expect(service.getAppsForZone('header').map((app) => app.id)).toContain('ble-debugger');
  });

  it('drops an unknown stored id after the catalog finishes loading', () => {
    const configService = {
      data: { toolbarAppIds: ['missing-subapp'] },
      configReloaded$: new Subject<void>(),
      save: jasmine.createSpy('save').and.resolveTo(),
    };
    const catalogState = new BehaviorSubject({ loading: true });
    const subappManager = {
      state$: catalogState.asObservable(),
      get state() {
        return catalogState.value;
      },
      getCatalogApps: () => [],
    };

    const service = new AppStoreService(configService as any, subappManager as any);
    expect(service.getZoneIds('header')).toContain('missing-subapp');

    catalogState.next({ loading: false });
    expect(service.getZoneIds('header')).not.toContain('missing-subapp');
  });

  it('hides the legacy Angular Aily Chat entry from the registry and defaults', () => {
    const configService = {
      data: {},
      configReloaded$: new Subject<void>(),
      save: jasmine.createSpy('save').and.resolveTo(),
    };
    const catalogState = new BehaviorSubject({ loading: false });
    const subappManager = {
      state$: catalogState.asObservable(),
      get state() {
        return catalogState.value;
      },
      getCatalogApps: () => [],
    };

    const service = new AppStoreService(configService as any, subappManager as any);

    expect(service.getApp('aily-chat')).toBeUndefined();
    expect(service.getZoneIds('header')).not.toContain('aily-chat');
  });
});
