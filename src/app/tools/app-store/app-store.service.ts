import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { AppItem, APP_LIST, HEADER_APP_LIMIT, SIDEBAR_APP_LIMIT } from './app-store.config';

const STORAGE_KEY = 'app-store-zones-config';

@Injectable({
  providedIn: 'root'
})
export class AppStoreService {
  private apps: AppItem[] = [...APP_LIST];

  // Header 上显示的 app 列表（与 app-store 工具栏区域对应，可被 header 订阅）
  private headerAppsSubject = new BehaviorSubject<AppItem[]>(this.loadHeaderAppsFromStorage());
  headerApps$ = this.headerAppsSubject.asObservable();

  // Header 上显示的 app 数量上限
  readonly HEADER_APP_LIMIT = HEADER_APP_LIMIT;
  // Sidebar 上显示的 app 数量上限
  readonly SIDEBAR_APP_LIMIT = SIDEBAR_APP_LIMIT;

  constructor() {
    this.loadAppsFromStorage();
  }

  // 从 app-store-zones-config 读取 header 应用列表（与 app-store 组件逻辑一致）
  private loadHeaderAppsFromStorage(): AppItem[] {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const config = JSON.parse(stored);
        const ids: string[] = config.header || [];
        return ids.map((id: string) => APP_LIST.find(app => app.id === id)).filter(Boolean) as AppItem[];
      }
    } catch (e) {
      console.error('Failed to load header apps from storage:', e);
    }
    return APP_LIST.slice(0, this.HEADER_APP_LIMIT);
  }

  // 从本地存储加载 app 配置
  private loadAppsFromStorage(): void {
    // 不再使用旧的 app-store-config，始终使用默认应用列表
    // 用户的配置现在存储在 app-store-zones-config 中
    this.apps = [...APP_LIST];
  }

  // 保存 app 配置到本地存储（已废弃，配置现在由组件管理）
  private saveAppsToStorage(): void {
    // 不再需要保存，配置由 app-store.component 管理
  }

  // 获取所有 app
  getAllApps(): AppItem[] {
    return [...APP_LIST]; // 始终返回完整的默认应用列表
  }

  // 获取启用的 app
  getEnabledApps(): AppItem[] {
    return this.apps.filter(app => app.enabled);
  }

  // 获取显示在 header 上的 app（与 app-store 工具栏区域一致）
  getHeaderApps(): AppItem[] {
    return this.headerAppsSubject.getValue();
  }

  // app-store 保存后调用，同步 header 显示
  updateHeaderApps(apps: AppItem[]): void {
    this.headerAppsSubject.next(apps);
  }

  // 启用/禁用 app
  toggleApp(appId: string, enabled: boolean): void {
    const app = this.apps.find(a => a.id === appId);
    if (app) {
      app.enabled = enabled;
      this.saveAppsToStorage();
    }
  }

  // 移动 app 顺序
  moveApp(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return;
    const [removed] = this.apps.splice(fromIndex, 1);
    this.apps.splice(toIndex, 0, removed);
    this.saveAppsToStorage();
  }

  // 更新整个 apps 顺序
  updateAppsOrder(apps: AppItem[]): void {
    this.apps = apps;
    this.saveAppsToStorage();
  }

  // 重置为默认配置
  resetToDefault(): void {
    this.apps = [...APP_LIST];
    localStorage.removeItem('app-store-config');
  }
}
