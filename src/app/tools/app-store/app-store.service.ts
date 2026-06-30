import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {
  APP_LIST,
  APP_STORE_STORAGE_KEY,
  APP_STORE_ZONES,
  AVAILABLE_APP_IDS,
  AppItem,
  AppPlacementZone,
  AppStoreLayout,
  DEFAULT_TOOLBAR_APP_IDS,
  HEADER_APP_LIMIT,
  TOOLBAR_APP_IDS_CONFIG_KEY
} from './app-store.config';
import {
  getChildToolAppItems,
  getChildToolAvailableAppIds,
  getChildToolDefaultToolbarAppIds
} from '../../configs/tool.config';
import { ConfigService } from '../../services/config.service';

export interface AppVisibilityContext {
  routeUrl?: string;
  boardCore?: string;
  isDevMode?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class AppStoreService {
  private readonly appMap = new Map<string, AppItem>();
  private readonly zoneLimits = new Map(APP_STORE_ZONES.map(zone => [zone.id, zone.limit]));
  private readonly layoutSubject = new BehaviorSubject<AppStoreLayout>({
    version: 2,
    zones: {
      header: []
    }
  });

  readonly layout$ = this.layoutSubject.asObservable();
  readonly HEADER_APP_LIMIT = HEADER_APP_LIMIT;

  constructor(private configService: ConfigService) {
    this.refreshAppRegistry();
    this.layoutSubject.next(this.loadLayout());

    this.configService.configReloaded$.subscribe(() => {
      this.refreshAppRegistry();
      this.layoutSubject.next(this.loadLayout());
    });
  }

  get layout(): AppStoreLayout {
    return this.cloneLayout(this.layoutSubject.value);
  }

  getAllApps(): AppItem[] {
    return [...this.appMap.values()].map(app => ({ ...app }));
  }

  getEnabledApps(): AppItem[] {
    return this.getAllApps().filter(app => app.enabled !== false);
  }

  getApp(appId: string): AppItem | undefined {
    const app = this.appMap.get(appId);
    return app ? { ...app } : undefined;
  }

  getAppsForZone(zone: AppPlacementZone): AppItem[] {
    return this.layoutSubject.value.zones[zone]
      .map(appId => this.appMap.get(appId))
      .filter((app): app is AppItem => !!app && app.enabled !== false)
      .map(app => ({ ...app }));
  }

  getZoneIds(zone: AppPlacementZone): string[] {
    return [...this.layoutSubject.value.zones[zone]];
  }

  setZoneApps(zone: AppPlacementZone, appIds: string[]): void {
    const nextLayout = this.cloneLayout(this.layoutSubject.value);
    nextLayout.zones[zone] = this.sanitizeZoneIds(zone, appIds);
    this.commitLayout(nextLayout);
  }

  setVisibleZoneOrder(zone: AppPlacementZone, visibleIds: string[], visibleCatalogIds: string[]): void {
    const visibleCatalogIdSet = new Set(visibleCatalogIds);
    const preservedHiddenIds = this.layoutSubject.value.zones[zone]
      .filter(appId => !visibleCatalogIdSet.has(appId));

    this.setZoneApps(zone, [...visibleIds, ...preservedHiddenIds]);
  }

  toggleAppInZone(zone: AppPlacementZone, appId: string): void {
    if (this.isAppInZone(zone, appId)) {
      if (this.isAppLocked(appId)) {
        return;
      }
      this.removeAppFromZone(zone, appId);
    } else {
      this.addAppToZone(zone, appId);
    }
  }

  addAppToZone(zone: AppPlacementZone, appId: string): boolean {
    if (!this.canRegisterApp(appId) || this.isAppInZone(zone, appId)) {
      return false;
    }

    const ids = this.getZoneIds(zone);
    const limit = this.getZoneLimit(zone);
    if (ids.length >= limit) {
      return false;
    }

    this.setZoneApps(zone, [...ids, appId]);
    return true;
  }

  removeAppFromZone(zone: AppPlacementZone, appId: string): void {
    if (this.isAppLocked(appId)) {
      return;
    }

    this.setZoneApps(zone, this.getZoneIds(zone).filter(id => id !== appId));
  }

  isAppInZone(zone: AppPlacementZone, appId: string): boolean {
    return this.layoutSubject.value.zones[zone].includes(appId);
  }

  isAppLocked(appId: string): boolean {
    return this.appMap.get(appId)?.lock === true;
  }

  getZoneLimit(zone: AppPlacementZone): number {
    return this.zoneLimits.get(zone) || Number.MAX_SAFE_INTEGER;
  }

  isAppVisible(app: AppItem, context: AppVisibilityContext = {}): boolean {
    if (app.enabled === false) {
      return false;
    }

    if (app.dev && !context.isDevMode) {
      return false;
    }

    if (app.router?.length && context.routeUrl) {
      const inRoute = app.router.some(route => context.routeUrl?.includes(route));
      if (!inRoute) {
        return false;
      }
    }

    if (app.core?.length) {
      const currentCore = String(context.boardCore || '').toLowerCase();
      return app.core.some(core => this.matchesAppCore(core, currentCore));
    }

    return true;
  }

  resetToDefault(): void {
    this.removeStoredLayout();
    this.commitLayout(this.normalizeLayout(this.createDefaultLayout()), false);
  }

  private loadLayout(): AppStoreLayout {
    const storedLayout = this.readStoredLayout();
    return this.normalizeLayout(storedLayout || this.createDefaultLayout());
  }

  private refreshAppRegistry(): void {
    this.appMap.clear();

    const availableAppIds = new Set([
      ...AVAILABLE_APP_IDS,
      ...getChildToolAvailableAppIds()
    ]);

    for (const app of [...APP_LIST, ...getChildToolAppItems()]) {
      if (availableAppIds.has(app.id)) {
        this.appMap.set(app.id, { ...app });
      }
    }
  }

  private createDefaultLayout(): AppStoreLayout {
    return {
      version: 2,
      zones: {
        header: [
          ...DEFAULT_TOOLBAR_APP_IDS,
          ...getChildToolDefaultToolbarAppIds()
        ]
      }
    };
  }

  private readStoredLayout(): AppStoreLayout | null {
    const toolbarAppIds = this.readConfigToolbarAppIds();
    if (!toolbarAppIds) {
      return null;
    }

    return {
      version: 2,
      zones: {
        header: toolbarAppIds
      }
    };
  }

  private readConfigToolbarAppIds(): string[] | null {
    const configData = this.configService.data;
    if (!configData || !Object.prototype.hasOwnProperty.call(configData, TOOLBAR_APP_IDS_CONFIG_KEY)) {
      return null;
    }

    const toolbarAppIds = configData[TOOLBAR_APP_IDS_CONFIG_KEY];
    if (!Array.isArray(toolbarAppIds)) {
      console.warn(`[AppStoreService] ${TOOLBAR_APP_IDS_CONFIG_KEY} in config.json must be an array.`);
      return null;
    }

    return toolbarAppIds.filter((appId): appId is string => typeof appId === 'string');
  }

  private commitLayout(layout: AppStoreLayout, persist = true): void {
    const normalizedLayout = this.normalizeLayout(layout);
    this.layoutSubject.next(normalizedLayout);

    if (persist) {
      this.saveLayout(normalizedLayout);
    }
  }

  private saveLayout(layout: AppStoreLayout): void {
    if (!this.configService.data) {
      this.configService.data = {};
    }

    this.configService.data[TOOLBAR_APP_IDS_CONFIG_KEY] = [...layout.zones.header];
    void this.configService.save().catch(error => {
      console.error('Failed to save app store layout:', error);
    });
  }

  private removeStoredLayout(): void {
    try {
      let shouldSave = false;
      if (this.configService.data && Object.prototype.hasOwnProperty.call(this.configService.data, TOOLBAR_APP_IDS_CONFIG_KEY)) {
        delete this.configService.data[TOOLBAR_APP_IDS_CONFIG_KEY];
        shouldSave = true;
      }

      if (shouldSave) {
        void this.configService.save().catch(error => {
          console.error('Failed to reset app store layout:', error);
        });
      }

      localStorage.removeItem(APP_STORE_STORAGE_KEY);
      localStorage.removeItem('app-store-config');
    } catch (error) {
      console.error('Failed to reset app store layout:', error);
    }
  }

  private normalizeLayout(layout: AppStoreLayout): AppStoreLayout {
    return {
      version: 2,
      zones: {
        header: this.sanitizeZoneIds('header', layout.zones.header || [])
      }
    };
  }

  private sanitizeZoneIds(zone: AppPlacementZone, appIds: string[]): string[] {
    const limit = this.getZoneLimit(zone);
    const lockedIds = this.getLockedZoneIds();
    const lockedIdSet = new Set(lockedIds);
    const maxNonLockedCount = Math.max(limit - lockedIds.length, 0);
    const seen = new Set<string>();
    const result: string[] = [];
    let nonLockedCount = 0;

    for (const appId of [...appIds, ...lockedIds]) {
      if (result.length >= limit) {
        break;
      }

      if (seen.has(appId) || !this.canRegisterApp(appId)) {
        continue;
      }

      const isLocked = lockedIdSet.has(appId);
      if (!isLocked && nonLockedCount >= maxNonLockedCount) {
        continue;
      }

      seen.add(appId);
      result.push(appId);
      if (!isLocked) {
        nonLockedCount++;
      }
    }

    return result;
  }

  private getLockedZoneIds(): string[] {
    return [...this.appMap.values()]
      .filter(app => app.lock === true && this.canRegisterApp(app.id))
      .map(app => app.id);
  }

  private canRegisterApp(appId: string): boolean {
    const app = this.appMap.get(appId);
    return !!app && app.enabled !== false;
  }

  private cloneLayout(layout: AppStoreLayout): AppStoreLayout {
    return {
      version: 2,
      zones: {
        header: [...layout.zones.header]
      }
    };
  }

  private matchesAppCore(appCore: string, currentCore: string): boolean {
    const normalizedAppCore = appCore.toLowerCase();
    return currentCore === normalizedAppCore || currentCore.split(':').includes(normalizedAppCore);
  }
}
