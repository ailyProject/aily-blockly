import { Component, OnInit, AfterViewInit, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { CommonModule } from '@angular/common';
import { UiService } from '../../services/ui.service';
import { Router } from '@angular/router';
import { AppStoreService } from './app-store.service';
import { AppItem, APP_LIST, HEADER_APP_LIMIT, SIDEBAR_APP_LIMIT } from './app-store.config';
import { TranslateModule } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import Sortable, { SortableEvent } from 'sortablejs';

@Component({
  selector: 'app-app-store',
  imports: [
    ToolContainerComponent,
    SubWindowComponent,
    CommonModule,
    TranslateModule,
    FormsModule,
    NzToolTipModule
  ],
  templateUrl: './app-store.component.html',
  styleUrl: './app-store.component.scss'
})
export class AppStoreComponent implements OnInit, AfterViewInit {
  currentUrl: string;
  windowInfo = 'MENU.APP_STORE';
  
  // 分成三个区域的 apps
  headerZoneApps: AppItem[] = [];
  sidebarZoneApps: AppItem[] = [];
  otherZoneApps: AppItem[] = [];

  @ViewChild('headerZone') headerZone!: ElementRef;
  @ViewChild('sidebarZone') sidebarZone!: ElementRef;
  @ViewChild('otherZone') otherZone!: ElementRef;

  // Sortable 实例引用
  private headerSortable?: Sortable;
  private sidebarSortable?: Sortable;
  private otherSortable?: Sortable;
  
  // 防止重复处理的标志
  private isHandlingAdd = false;

  constructor(
    private uiService: UiService,
    private router: Router,
    private appStoreService: AppStoreService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit() {
    this.currentUrl = this.router.url;
    this.loadApps();
  }

  ngAfterViewInit() {
    // 延迟初始化 Sortable，确保 DOM 已完全渲染
    setTimeout(() => {
      this.initSortable();
    }, 0);
  }

  initSortable() {
    // 先销毁旧的实例
    this.destroySortable();

    // 工具栏和侧边栏共用的配置
    const zoneConfig = {
      group: {
        name: 'apps',
        pull: true,
        put: true
      },
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',
      onAdd: (evt: SortableEvent) => {
        this.handleAdd(evt);
      },
      onUpdate: (evt: SortableEvent) => {
        // 如果正在处理 onAdd，跳过 onUpdate 避免重复处理
        if (!this.isHandlingAdd) {
          this.handleUpdate();
        }
      },
      onRemove: (evt: SortableEvent) => {
        this.handleRemove(evt);
      }
    };

    // 初始化 header 区域的 sortable
    if (this.headerZone?.nativeElement) {
      this.headerSortable = Sortable.create(this.headerZone.nativeElement, {
        ...zoneConfig
      });
    } else {
      console.warn('Header zone element not found');
    }

    // 初始化 sidebar 区域的 sortable
    if (this.sidebarZone?.nativeElement) {
      this.sidebarSortable = Sortable.create(this.sidebarZone.nativeElement, {
        ...zoneConfig
      });
    } else {
      console.warn('Sidebar zone element not found');
    }

    // 初始化 other 区域的 sortable（只能拖出复制，接收删除）
    if (this.otherZone?.nativeElement) {
      this.otherSortable = Sortable.create(this.otherZone.nativeElement, {
        group: {
          name: 'apps',
          pull: 'clone', // 使用克隆模式，拖拽时复制而不是移动
          put: true // 允许拖入（用于删除操作）
        },
        sort: false, // 禁止在 other 区域内部排序
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        onAdd: (evt: SortableEvent) => {
          // 拖入到 other 区域意味着删除，直接移除 DOM 元素
          evt.item.remove();
          this.handleUpdate();
        }
      });
    } else {
      console.warn('Other zone element not found');
    }
  }

  // 销毁 Sortable 实例
  private destroySortable() {
    if (this.headerSortable) {
      this.headerSortable.destroy();
      this.headerSortable = undefined;
    }
    if (this.sidebarSortable) {
      this.sidebarSortable.destroy();
      this.sidebarSortable = undefined;
    }
    if (this.otherSortable) {
      this.otherSortable.destroy();
      this.otherSortable = undefined;
    }
  }

  // 处理添加事件（从 other 区域拖入或从其他区域移动过来）
  private handleAdd(evt: SortableEvent) {
    // 设置标志，防止 onUpdate 重复处理
    this.isHandlingAdd = true;
    
    try {
      const appId = evt.item.getAttribute('data-id');
      const targetZone = evt.to;
      
      // 确定目标数组
      let targetArray: AppItem[];
      if (targetZone === this.headerZone?.nativeElement) {
        targetArray = this.headerZoneApps;
      } else if (targetZone === this.sidebarZone?.nativeElement) {
        targetArray = this.sidebarZoneApps;
      } else {
        // 未知区域，直接移除并返回
        evt.item.remove();
        return;
      }
      
      // 检查目标数组是否已存在该 app（防止重复）
      const alreadyExists = targetArray.some(app => app.id === appId);
      
      if (alreadyExists) {
        // 如果已存在，移除刚添加的 DOM 元素
        evt.item.remove();
        return;
      }
      
      // 先移除 Sortable 添加的临时 DOM 元素，避免与 Angular 渲染冲突
      evt.item.remove();
      
      // 找到对应的 app 对象并添加到数组
      const app = APP_LIST.find(a => a.id === appId);
      if (app) {
        targetArray.push(app);
        
        // 保存配置
        this.saveAppsOrder();
        
        // 使用 requestAnimationFrame 确保在下一帧更新，避免与当前拖拽操作冲突
        requestAnimationFrame(() => {
          // 触发变更检测，让 Angular 重新渲染
          this.cdr.detectChanges();
          
          // 重新初始化 Sortable（因为 DOM 已更新）
          setTimeout(() => {
            this.initSortable();
            // 重置标志
            this.isHandlingAdd = false;
          }, 0);
        });
      } else {
        this.isHandlingAdd = false;
      }
    } catch (error) {
      this.isHandlingAdd = false;
      console.error('Error in handleAdd:', error);
    }
  }

  // 处理移除事件
  private handleRemove(evt: SortableEvent) {
    // 如果是从 header 或 sidebar 移动到 other 区域，在 onAdd 中处理删除
    // 这里只需要更新数据
    this.handleUpdate();
  }

  // 更新所有区域数据并保存
  private handleUpdate() {
    // 从 DOM 更新各区域数据
    if (this.headerZone?.nativeElement) {
      this.updateArrayFromDOM(this.headerZone.nativeElement, this.headerZoneApps);
    }
    if (this.sidebarZone?.nativeElement) {
      this.updateArrayFromDOM(this.sidebarZone.nativeElement, this.sidebarZoneApps);
    }
    
    // 触发变更检测
    this.cdr.detectChanges();
    
    // 保存配置
    this.saveAppsOrder();
  }

  // 从 DOM 更新数组数据
  private updateArrayFromDOM(element: HTMLElement, targetArray: AppItem[]) {
    const cards = Array.from(element.querySelectorAll('.app-card'));
    const newArray: AppItem[] = [];
    const addedIds = new Set<string>(); // 用于跟踪已添加的 app id
    
    cards.forEach((card) => {
      const appId = card.getAttribute('data-id');
      if (appId && !addedIds.has(appId)) {
        const app = APP_LIST.find(a => a.id === appId);
        if (app) {
          newArray.push(app);
          addedIds.add(appId); // 标记为已添加
        }
      }
    });

    // 更新数组
    targetArray.length = 0;
    targetArray.push(...newArray);
  }

  loadApps() {
    // 直接使用配置文件中的默认应用列表
    const allApps = [...APP_LIST];
    
    // 从存储中加载用户配置的 header 和 sidebar 应用
    const storedConfig = this.loadStoredConfig(allApps);
    
    if (storedConfig) {
      this.headerZoneApps = storedConfig.header || [];
      this.sidebarZoneApps = storedConfig.sidebar || [];
    } else {
      // 默认配置：前6个在 header，接下来4个在 sidebar
      this.headerZoneApps = allApps.slice(0, HEADER_APP_LIMIT);
      this.sidebarZoneApps = allApps.slice(HEADER_APP_LIMIT, HEADER_APP_LIMIT + SIDEBAR_APP_LIMIT);
    }
    
    // 所有应用区域始终显示所有应用
    this.otherZoneApps = [...allApps];
  }

  // 从本地存储加载用户配置
  private loadStoredConfig(allApps: AppItem[]): { header: AppItem[], sidebar: AppItem[] } | null {
    try {
      const stored = localStorage.getItem('app-store-zones-config');
      if (stored) {
        const config = JSON.parse(stored);
        
        // 根据存储的 ID 恢复应用对象
        const header = config.header?.map((id: string) => allApps.find(app => app.id === id)).filter(Boolean) || [];
        const sidebar = config.sidebar?.map((id: string) => allApps.find(app => app.id === id)).filter(Boolean) || [];
        
        return { header, sidebar };
      }
    } catch (e) {
      console.error('Failed to load app store zones config:', e);
    }
    return null;
  }

  // 打开 app
  openApp(app: AppItem) {
    this.uiService.openTool(app.data.data);
  }

  // 保存排序
  saveAppsOrder() {
    // 保存 header 和 sidebar 的应用配置
    const config = {
      header: this.headerZoneApps.map(app => app.id),
      sidebar: this.sidebarZoneApps.map(app => app.id)
    };
    
    try {
      localStorage.setItem('app-store-zones-config', JSON.stringify(config));
      // 同步到 header 显示（与 app-store 工具栏区域对应）
      this.appStoreService.updateHeaderApps(this.headerZoneApps);
    } catch (e) {
      console.error('Failed to save app store zones config:', e);
    }
  }

  // 获取 header 上显示的 app 数量
  get headerAppLimit(): number {
    return this.appStoreService.HEADER_APP_LIMIT;
  }

  // 获取 sidebar 上显示的 app 数量
  get sidebarAppLimit(): number {
    return this.appStoreService.SIDEBAR_APP_LIMIT || 4;
  }

  // 计算空槽位
  get emptySlots(): number[] {
    const count = this.headerAppLimit - this.headerZoneApps.length;
    return count > 0 ? Array(count).fill(0).map((_, i) => i) : [];
  }

  // 计算侧边栏空槽位
  get emptySidebarSlots(): number[] {
    const count = this.sidebarAppLimit - this.sidebarZoneApps.length;
    return count > 0 ? Array(count).fill(0).map((_, i) => i) : [];
  }

  // 重置为默认配置
  resetToDefault() {
    // 清除存储的配置
    localStorage.removeItem('app-store-zones-config');
    
    // 重新加载应用
    this.loadApps();
    
    // 触发变更检测
    this.cdr.detectChanges();
    
    // 重新初始化 Sortable
    setTimeout(() => {
      this.initSortable();
    }, 0);
    
    // 保存默认配置并同步到 header
    this.saveAppsOrder();
  }

  close() {
    this.uiService.closeTool('app-store');
  }
}
