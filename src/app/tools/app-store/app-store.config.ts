export { APP_LIST, AVAILABLE_APP_IDS, DEFAULT_TOOLBAR_APP_IDS } from '../../configs/tool.config';
export type { AppItem } from '../../configs/tool.config';

export type AppPlacementZone = 'header';

export interface AppStoreZone {
  id: AppPlacementZone;
  name: string;
  icon: string;
  limit: number;
}

export interface AppStoreLayout {
  version: 2;
  zones: Record<AppPlacementZone, string[]>;
}

// Header 上显示的 app 数量上限
export const HEADER_APP_LIMIT = 8;

export const APP_STORE_STORAGE_KEY = 'app-store-zones-config';
export const TOOLBAR_APP_IDS_CONFIG_KEY = 'toolbarAppIds';

export const APP_STORE_ZONES: AppStoreZone[] = [
  {
    id: 'header',
    name: 'APP_STORE.TOOLBAR_APPS',
    icon: 'fa-light fa-window-flip',
    limit: HEADER_APP_LIMIT
  },
];
