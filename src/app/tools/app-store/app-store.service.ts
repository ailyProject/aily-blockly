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
  TOOLBAR_APP_IDS_CONFIG_KEY,
  SUBAPP_TOOLBAR_DEFAULTS_CONFIG_KEY,
  SubappToolbarDefaults,
} from './app-store.config';
import { isAppAvailableForApplication } from '../../configs/tool.config';
import { ConfigService } from '@core/preferences/public-api';
import { SubappManagerService } from '@integration/subapps/public-api';

export interface AppVisibilityContext {
  routeUrl?: string;
  boardCore?: string;
  isDevMode?: boolean;
}

export { isAppAvailableForApplication } from '../../configs/tool.config';

@Injectable({
  providedIn: 'root'
})
export class AppStoreService {
  private subappToolbarDefaultsReady = false;
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

  constructor(
    private configService: ConfigService,
    private subappManager: SubappManagerService,
  ) {
    this.refreshAppRegistry();
    this.layoutSubject.next(this.loadLayout());

    this.configService.configReloaded$.subscribe(() => {
      this.refreshAppRegistry();
      this.layoutSubject.next(this.loadLayout());
      if (this.subappToolbarDefaultsReady) void this.applySubappToolbarDefaults();
    });

    this.subappManager.state$.subscribe((state) => {
      this.refreshAppRegistry();
      this.layoutSubject.next(
        state.loading
          ? this.normalizeLayout(this.layoutSubject.value, true)
          : this.loadLayout()
      );
      if (this.subappToolbarDefaultsReady && !state.loading) void this.applySubappToolbarDefaults();
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
      .filter((app): app is AppItem => !!app && this.canRegisterApp(app.id))
      .map(app => ({ ...app }));
  }

  getZoneIds(zone: AppPlacementZone): string[] {
    return [...this.layoutSubject.value.zones[zone]];
  }

  setZoneApps(zone: AppPlacementZone, appIds: string[]): void {
    const nextLayout = this.cloneLayout(this.layoutSubject.value);
    nextLayout.zones[zone] = this.sanitizeZoneIds(zone, appIds);
    this.recordManualSubappPlacement([...this.getZoneIds(zone), ...nextLayout.zones[zone]]);
    this.commitLayout(nextLayout);
  }

  /** Called after product settings and the startup catalog refresh are ready.
   * Subsequent catalog events cover both automatic and manual installations.
   */
  async initializeSubappToolbarDefaults(): Promise<void> {
    const preserveExisting = !this.subappToolbarDefaultsReady
      && this.readSubappToolbarDefaults() === null
      && this.readConfigToolbarAppIds() !== null;
    this.subappToolbarDefaultsReady = true;
    await this.applySubappToolbarDefaults(preserveExisting);
  }

  private readSubappToolbarDefaults(): SubappToolbarDefaults | null {
    const value = this.configService.data?.[SUBAPP_TOOLBAR_DEFAULTS_CONFIG_KEY];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  private recordManualSubappPlacement(toolIds: string[]): void {
    const previous = this.readSubappToolbarDefaults();
    const next: SubappToolbarDefaults = { ...previous };
    const ids = new Set(toolIds);
    for (const item of this.subappManager.state.apps || []) {
      // On upgrade, an existing saved layout is authoritative for installed apps.
      if (!previous && item.installed) next[item.id] = 'preserved';
      if (ids.has(item.toolId)) next[item.id] = 'manual';
    }
    this.configService.data[SUBAPP_TOOLBAR_DEFAULTS_CONFIG_KEY] = next;
  }

  private async applySubappToolbarDefaults(preserveExisting = false): Promise<void> {
    const previous = this.readSubappToolbarDefaults();
    const next: SubappToolbarDefaults = { ...previous };
    const layout = this.cloneLayout(this.layoutSubject.value);
    let changed = previous === null;
    let layoutChanged = false;
    for (const item of this.subappManager.state.apps || []) {
      if (Object.prototype.hasOwnProperty.call(next, item.id)
        || !item.installed || !item.config || item.uninstalling
        || item.enabled === false || item.app?.enabled === false
        || !isAppAvailableForApplication(item.only, this.configService.getApplicationName())) continue;

      changed = true;
      if (preserveExisting) {
        next[item.id] = 'preserved';
      } else if (item.app?.defaultToolbar !== true || !this.canRegisterApp(item.toolId)) {
        next[item.id] = 'disabled';
      } else if (layout.zones.header.includes(item.toolId)) {
        next[item.id] = 'applied';
      } else if (layout.zones.header.length >= this.getZoneLimit('header')) {
        // The first-install suggestion is consumed even when the toolbar is full.
        next[item.id] = 'skipped-full';
      } else {
        layout.zones.header.push(item.toolId);
        next[item.id] = 'applied';
        layoutChanged = true;
      }
    }
    if (!changed) return;

    // Update synchronously before awaiting persistence so concurrent catalog
    // events cannot repeat an automatic placement. Save the decision and layout together.
    this.configService.data[SUBAPP_TOOLBAR_DEFAULTS_CONFIG_KEY] = next;
    if (layoutChanged) {
      this.configService.data[TOOLBAR_APP_IDS_CONFIG_KEY] = [...layout.zones.header];
      this.commitLayout(layout, false);
    }
    try {
      await this.configService.save();
    } catch (error) {
      // A later manual edit owns its newer decisions; never roll those back.
      if (this.configService.data[SUBAPP_TOOLBAR_DEFAULTS_CONFIG_KEY] === next) {
        if (previous) this.configService.data[SUBAPP_TOOLBAR_DEFAULTS_CONFIG_KEY] = previous;
        else delete this.configService.data[SUBAPP_TOOLBAR_DEFAULTS_CONFIG_KEY];
      }
      console.error('Failed to save initial subapp toolbar placement:', error);
    }
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

    if (!isAppAvailableForApplication(app.only, this.configService.getApplicationName())) {
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
    return this.normalizeLayout(
      storedLayout || this.createDefaultLayout(),
      this.subappManager.state.loading
    );
  }

  private refreshAppRegistry(): void {
    this.appMap.clear();

    const availableAppIds = new Set([
      ...AVAILABLE_APP_IDS,
      ...this.subappManager.getCatalogApps().map(app => app.id)
    ]);

    for (const app of [...APP_LIST, ...this.subappManager.getCatalogApps()]) {
      if (availableAppIds.has(app.id)) {
        this.appMap.set(app.id, { ...app });
      }
    }
  }

  private createDefaultLayout(): AppStoreLayout {
    return {
      version: 2,
      zones: {
        header: [...DEFAULT_TOOLBAR_APP_IDS]
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

  private normalizeLayout(layout: AppStoreLayout, preserveUnknownApps = false): AppStoreLayout {
    return {
      version: 2,
      zones: {
        header: this.sanitizeZoneIds('header', layout.zones.header || [], preserveUnknownApps)
      }
    };
  }

  private sanitizeZoneIds(
    zone: AppPlacementZone,
    appIds: string[],
    preserveUnknownApps = false
  ): string[] {
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

      const canPreserveUnknownApp = preserveUnknownApps && !this.appMap.has(appId);
      if (seen.has(appId) || (!this.canRegisterApp(appId) && !canPreserveUnknownApp)) {
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
    return !!app
      && app.enabled !== false
      && app.extension !== true
      && (app.subapp?.installed !== false);
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
