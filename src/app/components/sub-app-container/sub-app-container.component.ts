/**
 * 子应用容器组件
 * 用于在 Angular 中显示和管理 WebContentsView 子应用
 * 这个组件作为占位符，实际的子应用内容由 WebContentsView 渲染
 */
import { Component, Input, Output, EventEmitter, ElementRef, OnInit, OnDestroy, AfterViewInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WebContentsViewService, SubAppBounds } from '../../services/web-contents-view.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-sub-app-container',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="sub-app-container" [class.active]="isActive" [class.loading]="isLoading">
      <!-- 加载状态 -->
      @if (isLoading) {
        <div class="loading-overlay">
          <div class="loading-spinner"></div>
          <span class="loading-text">{{ loadingText }}</span>
        </div>
      }
      
      <!-- 占位内容（WebContentsView 实际渲染在原生层） -->
      <div class="placeholder" #placeholder>
        @if (!useWebContentsView) {
          <ng-content></ng-content>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
    }

    .sub-app-container {
      width: 100%;
      height: 100%;
      position: relative;
      background: var(--bg-color, #1e1e1e);
      border-radius: 4px;
      overflow: hidden;
    }

    .sub-app-container.active {
      box-shadow: 0 0 0 1px var(--primary-color, #007acc);
    }

    .loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: var(--bg-color, #1e1e1e);
      z-index: 100;
    }

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-color, #333);
      border-top-color: var(--primary-color, #007acc);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    .loading-text {
      margin-top: 12px;
      color: var(--text-color, #ccc);
      font-size: 12px;
    }

    .placeholder {
      width: 100%;
      height: 100%;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  `]
})
export class SubAppContainerComponent implements OnInit, AfterViewInit, OnDestroy {
  /** 子应用 ID */
  @Input() appId!: string;
  
  /** 是否使用 WebContentsView（设为 false 则使用传统方式） */
  @Input() useWebContentsView = true;
  
  /** 是否显示 */
  @Input() 
  set visible(value: boolean) {
    this._visible = value;
    this.updateVisibility();
  }
  get visible() {
    return this._visible;
  }
  private _visible = true;

  /** 加载文本 */
  @Input() loadingText = '正在加载...';

  /** 加载完成事件 */
  @Output() loaded = new EventEmitter<void>();
  
  /** 错误事件 */
  @Output() error = new EventEmitter<Error>();
  
  /** 激活状态变化事件 */
  @Output() activeChange = new EventEmitter<boolean>();

  isLoading = true;
  isActive = false;

  private subscriptions: Subscription[] = [];
  private resizeObserver?: ResizeObserver;
  private currentBounds: SubAppBounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private elementRef: ElementRef<HTMLElement>,
    private wcvService: WebContentsViewService
  ) {}

  ngOnInit() {
    if (this.useWebContentsView) {
      // 订阅顶层子应用变化
      this.subscriptions.push(
        this.wcvService.topSubApp.subscribe(topApp => {
          const wasActive = this.isActive;
          this.isActive = topApp === this.appId;
          if (wasActive !== this.isActive) {
            this.activeChange.emit(this.isActive);
          }
        })
      );
    }
  }

  ngAfterViewInit() {
    if (this.useWebContentsView && this._visible) {
      this.initWebContentsView();
    }

    // 监听容器大小变化
    this.resizeObserver = new ResizeObserver(() => {
      this.updateBounds();
    });
    this.resizeObserver.observe(this.elementRef.nativeElement);
  }

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }

    // 隐藏子应用（不销毁，以便后续复用）
    if (this.useWebContentsView) {
      this.wcvService.hideSubApp(this.appId);
    }
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.updateBounds();
  }

  private async initWebContentsView() {
    if (!this.appId) {
      console.error('SubAppContainerComponent: appId is required');
      return;
    }

    try {
      const bounds = this.calculateBounds();
      const success = await this.wcvService.showSubApp(this.appId, bounds);
      
      if (success) {
        this.isLoading = false;
        this.loaded.emit();
      } else {
        throw new Error(`Failed to show sub app: ${this.appId}`);
      }
    } catch (err) {
      console.error('Failed to init WebContentsView:', err);
      this.isLoading = false;
      this.error.emit(err as Error);
    }
  }

  private async updateVisibility() {
    if (!this.useWebContentsView) {
      return;
    }

    if (this._visible) {
      const bounds = this.calculateBounds();
      await this.wcvService.showSubApp(this.appId, bounds);
    } else {
      await this.wcvService.hideSubApp(this.appId);
    }
  }

  private calculateBounds(): SubAppBounds {
    const element = this.elementRef.nativeElement;
    const rect = element.getBoundingClientRect();

    // 获取窗口的标题栏高度（macOS 的 hiddenInset 样式）
    // 这个值可能需要根据实际情况调整
    const titleBarHeight = (window as any).electronAPI?.platform?.isMacOS ? 28 : 0;

    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top + titleBarHeight),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  private async updateBounds() {
    if (!this.useWebContentsView || !this._visible) {
      return;
    }

    const bounds = this.calculateBounds();
    
    // 检查边界是否真的改变了
    if (
      bounds.x === this.currentBounds.x &&
      bounds.y === this.currentBounds.y &&
      bounds.width === this.currentBounds.width &&
      bounds.height === this.currentBounds.height
    ) {
      return;
    }

    this.currentBounds = bounds;
    await this.wcvService.updateBounds(this.appId, bounds);
  }

  /**
   * 将此子应用置于最前
   */
  async bringToFront() {
    if (this.useWebContentsView) {
      await this.wcvService.bringToFront(this.appId);
    }
  }

  /**
   * 向子应用发送消息
   */
  async sendMessage(channel: string, data: any) {
    if (this.useWebContentsView) {
      await this.wcvService.sendToSubApp(this.appId, channel, data);
    }
  }
}
