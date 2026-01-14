/**
 * WebContentsView 子应用管理服务
 * 用于在 Angular 中管理 Electron WebContentsView 子应用
 */
import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { ElectronService } from './electron.service';

export interface SubAppInfo {
  id: string;
  name: string;
  route: string;
  preload: boolean;
  loaded: boolean;
  visible: boolean;
}

export interface SubAppBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

@Injectable({
  providedIn: 'root'
})
export class WebContentsViewService {
  // 当前打开的子应用列表
  private openSubApps$ = new BehaviorSubject<string[]>([]);
  
  // 当前顶层子应用
  private topSubApp$ = new BehaviorSubject<string | null>(null);
  
  // 子应用消息事件
  private messageSubject = new Subject<{ appId: string; channel: string; data: any }>();
  
  // 子应用列表缓存
  private subAppListCache: SubAppInfo[] = [];

  constructor(
    private electronService: ElectronService,
    private ngZone: NgZone
  ) {
    this.init();
  }

  private async init() {
    if (!this.electronService.isElectron) {
      console.warn('WebContentsViewService: Not running in Electron environment');
      return;
    }

    // 获取子应用列表
    await this.refreshSubAppList();
  }

  /**
   * 获取打开的子应用列表 Observable
   */
  get openSubApps() {
    return this.openSubApps$.asObservable();
  }

  /**
   * 获取顶层子应用 Observable
   */
  get topSubApp() {
    return this.topSubApp$.asObservable();
  }

  /**
   * 获取消息事件 Observable
   */
  get messages() {
    return this.messageSubject.asObservable();
  }

  /**
   * 刷新子应用列表
   */
  async refreshSubAppList(): Promise<SubAppInfo[]> {
    if (!this.electronService.isElectron) {
      return [];
    }

    try {
      const list = await (window as any).electronAPI.webContentsView.list();
      this.subAppListCache = list;
      return list;
    } catch (error) {
      console.error('Failed to get sub app list:', error);
      return [];
    }
  }

  /**
   * 获取子应用列表（缓存）
   */
  getSubAppList(): SubAppInfo[] {
    return this.subAppListCache;
  }

  /**
   * 创建子应用
   * @param appId 子应用 ID
   * @param options 配置选项
   */
  async createSubApp(appId: string, options: { devTools?: boolean } = {}): Promise<boolean> {
    if (!this.electronService.isElectron) {
      return false;
    }

    try {
      const result = await (window as any).electronAPI.webContentsView.create(appId, options);
      if (result.success) {
        await this.refreshSubAppList();
      }
      return result.success;
    } catch (error) {
      console.error(`Failed to create sub app ${appId}:`, error);
      return false;
    }
  }

  /**
   * 显示子应用
   * @param appId 子应用 ID
   * @param bounds 位置和大小
   */
  async showSubApp(appId: string, bounds: SubAppBounds): Promise<boolean> {
    if (!this.electronService.isElectron) {
      return false;
    }

    try {
      // 先确保子应用已创建
      await this.createSubApp(appId);

      const result = await (window as any).electronAPI.webContentsView.show(appId, bounds);
      if (result.success) {
        // 更新打开列表
        const currentList = this.openSubApps$.value.filter(id => id !== appId);
        currentList.push(appId);
        this.openSubApps$.next(currentList);
        this.topSubApp$.next(appId);
        await this.refreshSubAppList();
      }
      return result.success;
    } catch (error) {
      console.error(`Failed to show sub app ${appId}:`, error);
      return false;
    }
  }

  /**
   * 隐藏子应用
   * @param appId 子应用 ID
   */
  async hideSubApp(appId: string): Promise<boolean> {
    if (!this.electronService.isElectron) {
      return false;
    }

    try {
      const result = await (window as any).electronAPI.webContentsView.hide(appId);
      if (result.success) {
        // 更新打开列表
        const currentList = this.openSubApps$.value.filter(id => id !== appId);
        this.openSubApps$.next(currentList);
        
        // 更新顶层子应用
        if (this.topSubApp$.value === appId) {
          this.topSubApp$.next(currentList.length > 0 ? currentList[currentList.length - 1] : null);
        }
        await this.refreshSubAppList();
      }
      return result.success;
    } catch (error) {
      console.error(`Failed to hide sub app ${appId}:`, error);
      return false;
    }
  }

  /**
   * 切换子应用显示状态
   * @param appId 子应用 ID
   * @param bounds 位置和大小
   */
  async toggleSubApp(appId: string, bounds: SubAppBounds): Promise<boolean> {
    const isOpen = this.openSubApps$.value.includes(appId);
    if (isOpen && this.topSubApp$.value === appId) {
      return this.hideSubApp(appId);
    } else if (isOpen) {
      return this.bringToFront(appId);
    } else {
      return this.showSubApp(appId, bounds);
    }
  }

  /**
   * 更新子应用边界
   * @param appId 子应用 ID
   * @param bounds 新的位置和大小
   */
  async updateBounds(appId: string, bounds: SubAppBounds): Promise<boolean> {
    if (!this.electronService.isElectron) {
      return false;
    }

    try {
      const result = await (window as any).electronAPI.webContentsView.updateBounds(appId, bounds);
      return result.success;
    } catch (error) {
      console.error(`Failed to update bounds for sub app ${appId}:`, error);
      return false;
    }
  }

  /**
   * 批量更新子应用边界（用于窗口 resize 时）
   * @param updates 更新列表
   */
  async batchUpdateBounds(updates: { appId: string; bounds: SubAppBounds }[]): Promise<boolean> {
    if (!this.electronService.isElectron) {
      return false;
    }

    try {
      const result = await (window as any).electronAPI.webContentsView.batchUpdateBounds(updates);
      return result.success;
    } catch (error) {
      console.error('Failed to batch update bounds:', error);
      return false;
    }
  }

  /**
   * 销毁子应用
   * @param appId 子应用 ID
   */
  async destroySubApp(appId: string): Promise<boolean> {
    if (!this.electronService.isElectron) {
      return false;
    }

    try {
      const result = await (window as any).electronAPI.webContentsView.destroy(appId);
      if (result.success) {
        // 更新打开列表
        const currentList = this.openSubApps$.value.filter(id => id !== appId);
        this.openSubApps$.next(currentList);
        
        if (this.topSubApp$.value === appId) {
          this.topSubApp$.next(currentList.length > 0 ? currentList[currentList.length - 1] : null);
        }
        await this.refreshSubAppList();
      }
      return result.success;
    } catch (error) {
      console.error(`Failed to destroy sub app ${appId}:`, error);
      return false;
    }
  }

  /**
   * 将子应用置于最前
   * @param appId 子应用 ID
   */
  async bringToFront(appId: string): Promise<boolean> {
    if (!this.electronService.isElectron) {
      return false;
    }

    try {
      const result = await (window as any).electronAPI.webContentsView.bringToFront(appId);
      if (result.success) {
        // 更新打开列表顺序
        const currentList = this.openSubApps$.value.filter(id => id !== appId);
        currentList.push(appId);
        this.openSubApps$.next(currentList);
        this.topSubApp$.next(appId);
      }
      return result.success;
    } catch (error) {
      console.error(`Failed to bring sub app ${appId} to front:`, error);
      return false;
    }
  }

  /**
   * 向子应用发送消息
   * @param appId 子应用 ID
   * @param channel 通道名
   * @param data 数据
   */
  async sendToSubApp(appId: string, channel: string, data: any): Promise<boolean> {
    if (!this.electronService.isElectron) {
      return false;
    }

    try {
      const result = await (window as any).electronAPI.webContentsView.send(appId, channel, data);
      return result.success;
    } catch (error) {
      console.error(`Failed to send message to sub app ${appId}:`, error);
      return false;
    }
  }

  /**
   * 监听来自子应用的消息
   * @param channel 通道名
   * @param callback 回调函数
   * @returns 取消监听的函数
   */
  onMessage(channel: string, callback: (data: any) => void): () => void {
    if (!this.electronService.isElectron) {
      return () => {};
    }

    return (window as any).electronAPI.webContentsView.onMessage(channel, (data: any) => {
      this.ngZone.run(() => {
        callback(data);
        this.messageSubject.next({ appId: '', channel, data });
      });
    });
  }

  /**
   * 关闭当前顶层子应用
   */
  async closeTopSubApp(): Promise<boolean> {
    const topApp = this.topSubApp$.value;
    if (topApp) {
      return this.hideSubApp(topApp);
    }
    return false;
  }

  /**
   * 检查子应用是否已打开
   * @param appId 子应用 ID
   */
  isSubAppOpen(appId: string): boolean {
    return this.openSubApps$.value.includes(appId);
  }

  /**
   * 检查子应用是否为顶层
   * @param appId 子应用 ID
   */
  isSubAppTop(appId: string): boolean {
    return this.topSubApp$.value === appId;
  }
}
