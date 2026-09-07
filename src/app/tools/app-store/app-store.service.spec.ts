import { BehaviorSubject, Subject } from 'rxjs';
import { AppItem } from '../../configs/tool.config';
import { AppStoreService, isAppAvailableForApplication } from './app-store.service';

describe('AppStoreService saved toolbar compatibility', () => {
  it('drops the retired serial tool while retaining the AI serial subapp after the catalog loads', () => {
    const state$ = new BehaviorSubject({ loading: true });
    let catalogApps: AppItem[] = [];
    const config = {
      data: {
        toolbarAppIds: ['code-viewer', 'serial-monitor', 'serial-debugger', 'cloud-space', 'user-center'],
      },
      configReloaded$: new Subject<void>(),
    };
    const service = new AppStoreService(config as any, {
      get state() { return state$.value; },
      state$,
      getCatalogApps: () => catalogApps,
    } as any);

    expect(service.getAppsForZone('header').map(app => app.id)).not.toContain('serial-monitor');
    expect(service.getZoneIds('header')).toContain('serial-debugger');

    catalogApps = [{
      id: 'serial-debugger',
      name: 'AI Serial Debugger',
      action: 'tool-open',
      data: { type: 'tool', data: 'serial-debugger' },
      enabled: true,
    }];
    state$.next({ loading: false });

    expect(service.getApp('serial-monitor')).toBeUndefined();
    expect(service.getAppsForZone('header').map(app => app.id)).toEqual([
      'code-viewer', 'serial-debugger', 'cloud-space', 'user-center',
    ]);
    expect(service.getZoneIds('header')).not.toContain('serial-monitor');
  });
});

describe('isAppAvailableForApplication', () => {
  it('shows entries without only configuration in every application', () => {
    expect(isAppAvailableForApplication(undefined, 'aily blockly')).toBeTrue();
    expect(isAppAvailableForApplication('all', 'aily coder')).toBeTrue();
  });

  it('shows an application-specific entry only in the matching standalone product', () => {
    expect(isAppAvailableForApplication('aily coder', 'aily coder')).toBeTrue();
    expect(isAppAvailableForApplication('aily coder', 'aily blockly')).toBeFalse();
  });
});
