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
        this.handleUpdate();
      },
      onRemove: (evt: SortableEvent) => {
        this.handleRemove(evt);
      }
    };

    // 初始化 header 区域的 sortable
    if (this.headerZone?.nativeElement) {
      console.log('Initializing header zone sortable');
      Sortable.create(this.headerZone.nativeElement, {
        ...zoneConfig
      });
    } else {
      console.warn('Header zone element not found');
    }

    // 初始化 sidebar 区域的 sortable
    if (this.sidebarZone?.nativeElement) {
      console.log('Initializing sidebar zone sortable');
      Sortable.create(this.sidebarZone.nativeElement, {
        ...zoneConfig
      });
    } else {
      console.warn('Sidebar zone element not found');
    }

    // 初始化 other 区域的 sortable（只能拖出复制，接收删除）
    if (this.otherZone?.nativeElement) {
      console.log('Initializing other zone sortable');
      Sortable.create(this.otherZone.nativeElement, {
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

  // 处理添加事件（从 other 区域拖入或从其他区域移动过来）
  private handleAdd(evt: SortableEvent) {
    const appId = evt.item.getAttribute('data-id');
    const targetZone = evt.to;
    
    // 检查目标区域是否已存在该 app（防止重复）
    const existingCards = Array.from(targetZone.querySelectorAll('.app-card'));
    const duplicates = existingCards.filter(card => card.getAttribute('data-id') === appId);
    
    // 如果存在重复（超过1个同样id的元素），移除刚添加的元素
    if (duplicates.length > 1) {
      evt.item.remove();
      return;
    }
    
    this.handleUpdate();
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
    
    cards.forEach((card) => {
      const appId = card.getAttribute('data-id');
      if (appId) {
        const app = APP_LIST.find(a => a.id === appId);
        if (app) {
          newArray.push(app);
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
    console.log('所有应用数据:', allApps);
    
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
    console.log('otherZoneApps:', this.otherZoneApps);
    console.log('headerZoneApps:', this.headerZoneApps);
    console.log('sidebarZoneApps:', this.sidebarZoneApps);
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
    this.appStoreService.resetToDefault();
    this.loadApps();
  }

  close() {
    this.uiService.closeTool('app-store');
  }
}
