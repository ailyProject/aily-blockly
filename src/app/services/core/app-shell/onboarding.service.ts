import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * 新手引导步骤定义接口
 */
export interface OnboardingStep {
  /** 目标元素的 CSS 选择器 */
  target: string;
  /** 标题的国际化 key */
  titleKey: string;
  /** 描述的国际化 key */
  descKey: string;
  /** 提示框相对于高亮元素的位置: 'top' | 'bottom' | 'left' | 'right' */
  position: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * 新手引导配置接口
 */
export interface OnboardingConfig {
  /** 引导步骤列表 */
  steps: OnboardingStep[];
  /** 高亮区域的内边距，默认为 8 */
  padding?: number;
  /** 提示框与高亮区域的间距，默认为 20 */
  gap?: number;
  /** 提示框宽度，默认为 280 */
  tooltipWidth?: number;
  /** 提示框高度（用于计算位置），默认为 150 */
  tooltipHeight?: number;
  /** 是否启用动画，默认为 true */
  animated?: boolean;
}

/**
 * OnboardingService - 新手引导服务
 * 
 * 提供统一的新手引导管理，允许任何组件通过服务触发引导显示
 */
@Injectable({
  providedIn: 'root'
})
export class OnboardingService {
  /** 是否显示新手引导 */
  private showSubject = new BehaviorSubject<boolean>(false);
  public show$: Observable<boolean> = this.showSubject.asObservable();

  /** 当前引导配置 */
  private configSubject = new BehaviorSubject<OnboardingConfig | null>(null);
  public config$: Observable<OnboardingConfig | null> = this.configSubject.asObservable();

  /** 引导关闭回调 */
  private closedCallback: (() => void) | null = null;

  /** 引导完成回调 */
  private completedCallback: (() => void) | null = null;

  constructor() {}

  /**
   * 获取当前是否显示引导
   */
  get isShowing(): boolean {
    return this.showSubject.value;
  }

  /**
   * 获取当前引导配置
   */
  get currentConfig(): OnboardingConfig | null {
    return this.configSubject.value;
  }

  /**
   * 开始新手引导
   * @param config 引导配置
   * @param options 可选配置
   */
  start(
    config: OnboardingConfig,
    options?: {
      onClosed?: () => void;
      onCompleted?: () => void;
    }
  ): void {
    this.configSubject.next(config);
    this.closedCallback = options?.onClosed || null;
    this.completedCallback = options?.onCompleted || null;
    this.showSubject.next(true);
  }

  /**
   * 关闭新手引导（由 main-window 组件调用）
   */
  close(): void {
    this.showSubject.next(false);
    if (this.closedCallback) {
      this.closedCallback();
      this.closedCallback = null;
    }
    this.completedCallback = null;
  }

  /**
   * 完成新手引导（由 main-window 组件调用）
   */
  complete(): void {
    this.showSubject.next(false);
    if (this.completedCallback) {
      this.completedCallback();
      this.completedCallback = null;
    } else if (this.closedCallback) {
      // 如果没有设置完成回调，则调用关闭回调
      this.closedCallback();
      this.closedCallback = null;
    }
  }

  /**
   * 重置服务状态
   */
  reset(): void {
    this.showSubject.next(false);
    this.configSubject.next(null);
    this.closedCallback = null;
    this.completedCallback = null;
  }
}
