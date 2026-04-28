import { Injectable, ElementRef } from '@angular/core';

/**
 * 管理聊天窗口的滚动行为：
 * - 自动滚动到底部（新内容到达时）
 * - 检测用户手动上滚以禁用自动滚动
 * - 用户滚回底部时重新启用
 */
@Injectable()
export class ScrollManagerService {
  autoScrollEnabled = true;

  private _lastTop: number | null = null;
  private _lastHeight: number | null = null;
  private _lastAtBottom: boolean | null = null;

  private containerRef: ElementRef | null = null;

  /** 绑定聊天容器 DOM 引用（组件 ngAfterViewInit 时调用） */
  setContainer(ref: ElementRef): void {
    this.containerRef = ref;
  }

  /** 启用自动滚动 */
  enable(): void {
    this.autoScrollEnabled = true;
  }

  /** 重置所有追踪状态（新会话时调用） */
  reset(): void {
    this.autoScrollEnabled = true;
    this._lastTop = null;
    this._lastHeight = null;
    this._lastAtBottom = null;
  }

  scrollToBottom(behavior: string = 'smooth'): void {
    if (!this.autoScrollEnabled) {
      return;
    }

    const element = this.containerRef?.nativeElement;
    if (!element) {
      return;
    }

    let lastScrollHeight = 0;
    let stableCount = 0;
    const maxAttempts = 20;
    const stableThreshold = 2;

    const attemptScroll = () => {
      try {
        const currentScrollTop = element.scrollTop;
        const scrollHeight = element.scrollHeight;
        const clientHeight = element.clientHeight;
        const maxScrollTop = scrollHeight - clientHeight;

        if (scrollHeight === lastScrollHeight) {
          stableCount++;
        } else {
          stableCount = 0;
          lastScrollHeight = scrollHeight;
        }

        if (stableCount >= stableThreshold || stableCount >= maxAttempts) {
          if (currentScrollTop < maxScrollTop - 2) {
            element.scrollTo({ top: scrollHeight, behavior });
          }
          return;
        }

        if (stableCount < maxAttempts) {
          setTimeout(attemptScroll, 100);
        }
      } catch (error) {
        console.warn('滚动到底部失败:', error);
      }
    };

    setTimeout(attemptScroll, 100);
  }

  /**
   * 检查用户是否手动向上滚动，是则禁用自动滚动；
   * 回到底部时自动重新启用。
   */
  checkUserScroll(): void {
    const element = this.containerRef?.nativeElement;
    if (!element) {
      return;
    }

    const threshold = 30;
    const isAtBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;

    const prevTop = this._lastTop;
    const prevHeight = this._lastHeight;
    const deltaTop = (prevTop == null) ? 0 : (element.scrollTop - prevTop);
    const deltaHeight = (prevHeight == null) ? 0 : (element.scrollHeight - prevHeight);

    const contentGrew = prevHeight != null && deltaHeight > 0;
    const likelyReflowNudge = contentGrew && Math.abs(deltaTop) <= 10;
    const userScrolledUp = deltaTop < -30 && !likelyReflowNudge;

    if (!isAtBottom && this.autoScrollEnabled) {
      const shouldDisable = userScrolledUp || (!contentGrew && (this._lastAtBottom === true));
      if (shouldDisable) {
        this.autoScrollEnabled = false;
      }
    } else if (isAtBottom && !this.autoScrollEnabled) {
      this.autoScrollEnabled = true;
    }

    this._lastTop = element.scrollTop;
    this._lastHeight = element.scrollHeight;
    this._lastAtBottom = isAtBottom;
  }
}
