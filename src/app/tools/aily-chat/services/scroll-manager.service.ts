import { Injectable, ElementRef, NgZone, Optional } from '@angular/core';

import { ChatPerformanceTracer } from './chat-perf-tracer';

export type ChatRevealTarget =
  | 'current-response'
  | 'pending-confirmation'
  | 'pending-question'
  | 'pending-plan-review'
  | 'checkpoint-anchor';

export interface ChatRevealOptions {
  readonly behavior?: ScrollBehavior;
  readonly relativeTop?: number;
  readonly followBottom?: boolean;
  readonly maxAttempts?: number;
}

export interface ChatRevealHostDelegate {
  prepareRevealTarget?(target: ChatRevealTarget, options: ChatRevealOptions): boolean;
}

/**
 * 管理聊天窗口的滚动行为：
 * - 维护接近 VS Code ChatListWidget 的 scrollLock 语义
 * - scrollLock=true 表示保持贴底跟随；false 表示用户已脱离底部
 */
@Injectable()
export class ScrollManagerService {
  private _scrollLock = true;
  private _showFollowBottomButton = false;

  private _lastTop: number | null = null;
  private _lastHeight: number | null = null;
  private _lastAtBottom: boolean | null = null;
  private _scrollRequestId = 0;
  private _exchangeRevealRequestId = 0;
  private _targetRevealRequestId = 0;
  private _programmaticScrollRequestId = 0;
  private _ignoreNextScrollEvent = false;
  private _followBottomAfterExchangeReveal = false;
  private readonly _pendingExchangeTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private readonly _pendingScrollTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private readonly _pendingTargetRevealTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private _followBottomFrameHandle: ReturnType<typeof setTimeout> | number | null = null;
  private _followBottomFrameUsesRaf = false;
  private _followBottomFrameRequestId = 0;
  private _followBottomLastHeight = 0;
  private _followBottomStableFrames = 0;

  private containerRef: ElementRef | null = null;
  private revealHostDelegate: ChatRevealHostDelegate | null = null;

  constructor(@Optional() private readonly ngZone: NgZone | null = null) {}

  /**
   * Canonical follow-bottom state, aligned with VS Code chat list terminology.
   * true = keep following the bottom, false = user has broken away from the bottom.
   */
  get scrollLock(): boolean {
    return this._scrollLock;
  }

  get showFollowBottomButton(): boolean {
    return this._showFollowBottomButton;
  }

  setScrollLock(value: boolean): void {
    this._scrollLock = value;
    this.updateFollowBottomAffordance();
  }

  setRevealHostDelegate(delegate: ChatRevealHostDelegate | null): void {
    this.revealHostDelegate = delegate;
  }

  /** 绑定聊天容器 DOM 引用（组件 ngAfterViewInit 时调用） */
  setContainer(ref: ElementRef): void {
    this.cancelPendingExchangeReveal();
    this.cancelPendingBottomScroll();
    this.cancelPendingTargetReveal();
    this.containerRef = ref;
    this.syncCurrentResponseMinHeight();
    const element = this.containerRef?.nativeElement as HTMLElement | undefined;
    if (element) {
      this._lastTop = element.scrollTop;
      this._lastHeight = element.scrollHeight;
      this._lastAtBottom = this.isAtBottom(element);
    }
    this.updateFollowBottomAffordance(element);
  }

  /** 启用自动滚动 */
  enable(): void {
    this.setScrollLock(true);
  }

  captureAutoScrollState(): boolean {
    const element = this.containerRef?.nativeElement as HTMLElement | undefined;
    if (!element || !this.scrollLock) {
      return false;
    }

    if (this._pendingExchangeTimeouts.size > 0) {
      return false;
    }

    return this.isAtBottom(element);
  }

  scrollToBottomIfNeeded(shouldFollow: boolean, behavior: string = 'auto'): void {
    if (!shouldFollow) {
      return;
    }

    if (behavior === 'auto') {
      this.ensureFollowBottomLoop('auto');
      return;
    }

    this.scrollToBottom(behavior);
  }

  resumeFollowBottom(behavior: string = 'auto'): void {
    this.setScrollLock(true);
    this._programmaticScrollRequestId = 0;
    this.cancelPendingExchangeReveal();
    this.cancelPendingBottomScroll();

    const element = this.containerRef?.nativeElement;
    if (!element) {
      return;
    }

    this.syncCurrentResponseMinHeight();
    const requestId = ++this._scrollRequestId;
    this.performBottomScroll(element, behavior, requestId);
    this.scheduleBottomScrollAttempt(() => this.performBottomScroll(element, 'auto', requestId), 16);
    this.scheduleBottomScrollAttempt(() => this.performBottomScroll(element, 'auto', requestId), 64);
  }

  handleContentHeightChange(): void {
    const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    const element = this.containerRef?.nativeElement as HTMLElement | undefined;
    if (!element) {
      return;
    }

    this.syncCurrentResponseMinHeight();

    const previousHeight = this._lastHeight;
    const currentHeight = element.scrollHeight;
    const hasHeightChanged = previousHeight == null || currentHeight !== previousHeight;
    const shouldFollow = hasHeightChanged && this.scrollLock;

    if (shouldFollow) {
      if (this._pendingExchangeTimeouts.size > 0) {
        this._followBottomAfterExchangeReveal = true;
        this._lastTop = element.scrollTop;
        this._lastHeight = currentHeight;
        this._lastAtBottom = this._lastAtBottom ?? this.isAtBottom(element);
        this.updateFollowBottomAffordance(element);
        this.recordScrollHeightUpdateDuration(startedAt, currentHeight, shouldFollow);
        return;
      }

      this.ensureFollowBottomLoop('auto');
      this.recordScrollHeightUpdateDuration(startedAt, currentHeight, shouldFollow);
      return;
    }

    this._lastTop = element.scrollTop;
    this._lastHeight = currentHeight;
    this._lastAtBottom = this.isAtBottom(element);
    this.updateFollowBottomAffordance(element);
    this.recordScrollHeightUpdateDuration(startedAt, currentHeight, shouldFollow);
  }

  /**
   * Item-local height notification from the mounted chat row renderer.
   * Equivalent to VS Code ChatListWidget.updateElementHeight(element): the
   * row has already been measured, so this path only preserves bottom-follow
   * and never re-queries response rows or recalculates their min height.
   */
  handleItemHeightChange(_itemId: string, _height: number): void {
    const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    const element = this.containerRef?.nativeElement as HTMLElement | undefined;
    if (!element) {
      return;
    }

    const shouldFollow = this.scrollLock && this._pendingExchangeTimeouts.size === 0;
    if (shouldFollow) {
      // Keep the ResizeObserver/list-item update callback measurement-only.
      // Bottom reveal is performed by the existing coalesced list-layout loop,
      // avoiding a scrollHeight read followed by scrollTo in the same frame.
      this.ensureFollowBottomLoop('auto');
    } else if (this.scrollLock) {
      this._followBottomAfterExchangeReveal = true;
    }

    this.recordScrollHeightUpdateDuration(startedAt, this._lastHeight ?? 0, shouldFollow);
  }

  private recordScrollHeightUpdateDuration(startedAt: number, currentHeight: number, shouldFollow: boolean): void {
    const durationMs = Math.max(0, (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()) - startedAt);
    ChatPerformanceTracer.recordDuration(
      'scroll_height_update',
      durationMs,
      `height=${currentHeight},follow=${shouldFollow},lock=${this.scrollLock}`,
      { slowThresholdMs: 16 },
    );
    if (durationMs >= 50) {
      ChatPerformanceTracer.increment('scroll_height_update.hard_regression');
      ChatPerformanceTracer.mark('scroll_height_update_hard_regression', `${durationMs.toFixed(1)}ms height=${currentHeight}`);
    }
  }

  /**
   * 新一轮用户消息开始时，将最新 user 消息锚定到视口顶部附近，
   * 后续再由流式增量的 scrollToBottom 负责跟随到底部。
   */
  startNewExchange(): void {
    const element = this.containerRef?.nativeElement as HTMLElement | undefined;

    this.cancelPendingExchangeReveal();
    this.setScrollLock(true);
    this._programmaticScrollRequestId = 0;
    this._followBottomAfterExchangeReveal = false;

    if (!element) {
      return;
    }

    const requestId = ++this._exchangeRevealRequestId;
    let attempts = 0;
    const maxAttempts = 20;

    const attemptReveal = () => {
      if (!this.scrollLock || requestId !== this._exchangeRevealRequestId) {
        return;
      }

      this.syncCurrentResponseMinHeight();

      const latestUserDialog = this.findLatestUserDialog(element);
      if (!latestUserDialog) {
        if (attempts >= maxAttempts) {
          this.flushQueuedFollowAfterExchangeReveal();
          return;
        }

        attempts++;
        this.scheduleExchangeAttempt(attemptReveal, 16);
        return;
      }

      const targetTop = this.computeDialogTop(element, latestUserDialog);
      this._ignoreNextScrollEvent = true;
      element.scrollTo({ top: targetTop, behavior: 'auto' });
      this._lastTop = targetTop;
      this._lastHeight = element.scrollHeight;
      this._lastAtBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 30;
      this.flushQueuedFollowAfterExchangeReveal();
    };

    this.scheduleExchangeAttempt(attemptReveal, 0);
  }

  /**
   * 显式 reveal 某个聊天语义目标。
   *
   * VS Code ChatListWidget 暴露 reveal(element, relativeTop)，调用方按元素而不是按
   * “整段会话滚到底部”来定位。这里保留相同边界：目标未挂载时只做有界重试，
   * 不触发全量会话重建，也不把后台 session 的 UI 状态投影到当前会话。
   */
  revealTarget(target: ChatRevealTarget, options: ChatRevealOptions = {}): boolean {
    const container = this.containerRef?.nativeElement as HTMLElement | undefined;
    if (!container) {
      return false;
    }

    this.cancelPendingTargetReveal();
    this.revealHostDelegate?.prepareRevealTarget?.(target, options);

    const requestId = ++this._targetRevealRequestId;
    const maxAttempts = Math.max(0, options.maxAttempts ?? 20);
    let attempts = 0;

    const attemptReveal = () => {
      if (requestId !== this._targetRevealRequestId) {
        return;
      }

      const element = this.findRevealTargetElement(container, target);
      if (!element) {
        if (attempts >= maxAttempts) {
          return;
        }

        attempts++;
        this.scheduleTargetRevealAttempt(attemptReveal, 16);
        return;
      }

      this.revealElement(element, options);
    };

    this.scheduleTargetRevealAttempt(attemptReveal, 0);
    return true;
  }

  revealElement(target: HTMLElement | null | undefined, options: ChatRevealOptions = {}): boolean {
    const container = this.containerRef?.nativeElement as HTMLElement | undefined;
    if (!container || !target) {
      return false;
    }

    const behavior = options.behavior ?? 'auto';
    const relativeTop = options.relativeTop ?? 0;
    const targetInContainer = this.isTargetInsideContainer(container, target);

    if (!targetInContainer) {
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
      }
      if (options.followBottom === true) {
        this.setScrollLock(true);
      }
      return true;
    }

    this.cancelPendingExchangeReveal();
    if (options.followBottom === true) {
      this.setScrollLock(true);
    }

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(maxScrollTop, Math.max(0, this.computeDialogTop(container, target) + relativeTop));
    this._ignoreNextScrollEvent = true;
    container.scrollTo({ top: targetTop, behavior });
    this._lastTop = targetTop;
    this._lastHeight = container.scrollHeight;
    this._lastAtBottom = this.isAtBottom(container);
    return true;
  }

  /** 重置所有追踪状态（新会话时调用） */
  reset(): void {
    this.cancelPendingExchangeReveal();
    this.cancelPendingBottomScroll();
    this.cancelPendingTargetReveal();
    this._scrollRequestId++;
    this._programmaticScrollRequestId = 0;
    this._followBottomAfterExchangeReveal = false;
    this.setScrollLock(true);
    this._lastTop = null;
    this._lastHeight = null;
    this._lastAtBottom = null;
    this.syncCurrentResponseMinHeight();
  }

  scrollToBottom(behavior: string = 'smooth'): void {
    if (!this.scrollLock) {
      return;
    }

    if (this._pendingExchangeTimeouts.size > 0) {
      this._followBottomAfterExchangeReveal = true;
      return;
    }

    const element = this.containerRef?.nativeElement;
    if (!element) {
      return;
    }

    if (this._pendingScrollTimeouts.size > 0) {
      return;
    }

    this.syncCurrentResponseMinHeight();
    const requestId = ++this._scrollRequestId;
    this.scheduleBottomScrollAttempt(() => {
      this.performBottomScroll(element, behavior, requestId);
    }, 16);
  }

  private performBottomScroll(element: HTMLElement, behavior: string, requestId: number): void {
    if (!this.scrollLock || requestId !== this._scrollRequestId) {
      return;
    }

    try {
      const scrollHeight = element.scrollHeight;
      const clientHeight = element.clientHeight;
      const maxScrollTop = Math.max(0, scrollHeight - clientHeight);

      if (element.scrollTop < maxScrollTop - 2) {
        this._programmaticScrollRequestId = requestId;
        this._ignoreNextScrollEvent = true;
        element.scrollTo({ top: scrollHeight, behavior: behavior as ScrollBehavior });
      }

      this._lastTop = element.scrollTop;
      this._lastHeight = element.scrollHeight;
      this._lastAtBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 30;
      this.updateFollowBottomAffordance(element);
    } catch (error) {
      console.warn('滚动到底部失败:', error);
    }
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

    this.syncCurrentResponseMinHeight();

    if (this._ignoreNextScrollEvent) {
      this._ignoreNextScrollEvent = false;
      this._lastTop = element.scrollTop;
      this._lastHeight = element.scrollHeight;
      this._lastAtBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 30;
      this.updateFollowBottomAffordance(element);
      return;
    }

    const isAtBottom = this.isAtBottom(element);

    const prevTop = this._lastTop;
    const prevHeight = this._lastHeight;
    const deltaTop = (prevTop == null) ? 0 : (element.scrollTop - prevTop);
    const deltaHeight = (prevHeight == null) ? 0 : (element.scrollHeight - prevHeight);

    const contentGrew = prevHeight != null && deltaHeight > 0;
    const likelyReflowNudge = contentGrew && Math.abs(deltaTop) <= 10;
    const userScrolledUp = deltaTop < -30 && !likelyReflowNudge;
    const isProgrammaticFollow = this._programmaticScrollRequestId === this._scrollRequestId
      && this.scrollLock
      && isAtBottom
      && deltaTop >= 0;

    if (isProgrammaticFollow) {
      this._lastTop = element.scrollTop;
      this._lastHeight = element.scrollHeight;
      this._lastAtBottom = isAtBottom;
      this.updateFollowBottomAffordance(element);
      return;
    }

    if (!isAtBottom && this.scrollLock) {
      const shouldDisable = userScrolledUp || (!contentGrew && (this._lastAtBottom === true || this._lastAtBottom === false));
      if (shouldDisable) {
        this.setScrollLock(false);
        this._scrollRequestId++;
        this._programmaticScrollRequestId = 0;
        this.cancelPendingExchangeReveal();
        this.cancelPendingBottomScroll();
      }
    } else if (isAtBottom && !this.scrollLock) {
      this.setScrollLock(true);
      this._programmaticScrollRequestId = 0;
    }

    this._lastTop = element.scrollTop;
    this._lastHeight = element.scrollHeight;
    this._lastAtBottom = isAtBottom;
    this.updateFollowBottomAffordance(element);
  }

  private scheduleExchangeAttempt(callback: () => void, delayMs: number): void {
    const handle = this.runOutsideAngular(() => setTimeout(() => {
      this._pendingExchangeTimeouts.delete(handle);
      callback();
    }, delayMs));
    this._pendingExchangeTimeouts.add(handle);
  }

  private scheduleBottomScrollAttempt(callback: () => void, delayMs: number): void {
    const handle = this.runOutsideAngular(() => setTimeout(() => {
      this._pendingScrollTimeouts.delete(handle);
      callback();
    }, delayMs));
    this._pendingScrollTimeouts.add(handle);
  }

  private scheduleTargetRevealAttempt(callback: () => void, delayMs: number): void {
    const handle = this.runOutsideAngular(() => setTimeout(() => {
      this._pendingTargetRevealTimeouts.delete(handle);
      callback();
    }, delayMs));
    this._pendingTargetRevealTimeouts.add(handle);
  }

  private runOutsideAngular<T>(work: () => T): T {
    return this.ngZone ? this.ngZone.runOutsideAngular(work) : work();
  }

  private cancelPendingExchangeReveal(): void {
    this._pendingExchangeTimeouts.forEach((handle) => clearTimeout(handle));
    this._pendingExchangeTimeouts.clear();
    this._followBottomAfterExchangeReveal = false;
  }

  private flushQueuedFollowAfterExchangeReveal(): void {
    if (!this._followBottomAfterExchangeReveal || !this.scrollLock) {
      this._followBottomAfterExchangeReveal = false;
      return;
    }

    this._followBottomAfterExchangeReveal = false;
    this.scrollToBottom('auto');
  }

  private cancelPendingBottomScroll(): void {
    this._pendingScrollTimeouts.forEach((handle) => clearTimeout(handle));
    this._pendingScrollTimeouts.clear();
    this.cancelFollowBottomLoop();
  }

  private ensureFollowBottomLoop(behavior: string = 'auto'): void {
    const element = this.containerRef?.nativeElement;
    if (!element || !this.scrollLock) {
      return;
    }

    if (this._pendingExchangeTimeouts.size > 0) {
      this._followBottomAfterExchangeReveal = true;
      return;
    }

    if (this._followBottomFrameHandle !== null) {
      return;
    }

    this._followBottomFrameRequestId = ++this._scrollRequestId;
    // ResizeObserver already supplied the changed row height. Reading the
    // whole container here forces layout in the observer frame; defer that
    // read to the scheduled list-layout frame, as VS Code's list does.
    this._followBottomLastHeight = this._lastHeight ?? -1;
    this._followBottomStableFrames = 0;
    this.scheduleFollowBottomFrame(() => this.runFollowBottomFrame(element, behavior, this._followBottomFrameRequestId));
  }

  private runFollowBottomFrame(element: HTMLElement, behavior: string, requestId: number): void {
    this._followBottomFrameHandle = null;
    this._followBottomFrameUsesRaf = false;

    if (!this.scrollLock || requestId !== this._followBottomFrameRequestId || requestId !== this._scrollRequestId) {
      return;
    }

    this.performBottomScroll(element, behavior, requestId);

    const currentHeight = this._lastHeight ?? element.scrollHeight;
    const heightStable = currentHeight === this._followBottomLastHeight;
    const atBottom = this.isAtBottom(element, 4);
    this._followBottomStableFrames = heightStable && atBottom
      ? this._followBottomStableFrames + 1
      : 0;
    this._followBottomLastHeight = currentHeight;

    if (this._followBottomStableFrames >= 2) {
      return;
    }

    this.scheduleFollowBottomFrame(() => this.runFollowBottomFrame(element, behavior, requestId));
  }

  private scheduleFollowBottomFrame(callback: () => void): void {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      this._followBottomFrameUsesRaf = true;
      this._followBottomFrameHandle = this.runOutsideAngular(
        () => globalThis.requestAnimationFrame(callback),
      );
      return;
    }

    this._followBottomFrameUsesRaf = false;
    this._followBottomFrameHandle = this.runOutsideAngular(() => setTimeout(callback, 16));
  }

  private cancelFollowBottomLoop(): void {
    if (this._followBottomFrameHandle === null) {
      return;
    }

    if (this._followBottomFrameUsesRaf && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this._followBottomFrameHandle as number);
    } else {
      clearTimeout(this._followBottomFrameHandle as ReturnType<typeof setTimeout>);
    }
    this._followBottomFrameHandle = null;
    this._followBottomFrameUsesRaf = false;
    this._followBottomFrameRequestId++;
    this._followBottomStableFrames = 0;
  }

  private cancelPendingTargetReveal(): void {
    this._targetRevealRequestId++;
    this._pendingTargetRevealTimeouts.forEach((handle) => clearTimeout(handle));
    this._pendingTargetRevealTimeouts.clear();
  }

  private syncCurrentResponseMinHeight(): void {
    const element = this.containerRef?.nativeElement as HTMLElement | undefined;
    if (!element) {
      return;
    }

    const latestResponse = element.querySelector<HTMLElement>('.dialog-box.chat-most-recent-response');
    if (!latestResponse) {
      element.style.removeProperty('--chat-current-response-min-height');
      return;
    }

    let secondToLast = latestResponse.previousElementSibling as HTMLElement | null;
    while (secondToLast && !secondToLast.classList.contains('dialog-box')) {
      secondToLast = secondToLast.previousElementSibling as HTMLElement | null;
    }
    const secondToLastHeight = secondToLast ? Math.min(secondToLast.offsetHeight || 150, 200) : 150;
    const minHeight = Math.max(element.clientHeight - (secondToLastHeight + 10), 0);
    element.style.setProperty('--chat-current-response-min-height', `${minHeight}px`);
  }

  private isAtBottom(element: HTMLElement, threshold: number = 30): boolean {
    return element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;
  }

  private updateFollowBottomAffordance(element?: HTMLElement): void {
    const target = element ?? this.containerRef?.nativeElement as HTMLElement | undefined;
    if (!target) {
      this._showFollowBottomButton = false;
      return;
    }

    // Keep the affordance independent from scrollLock. scrollLock intentionally
    // resumes near the bottom, but the button should remain visible until the
    // list is actually at the latest item.
    this._showFollowBottomButton = !this._scrollLock || !this.isAtBottom(target, 4);
  }

  private findLatestUserDialog(container: HTMLElement): HTMLElement | null {
    const dialogs = container.querySelectorAll<HTMLElement>('.dialog-box.user');
    return dialogs.length ? dialogs[dialogs.length - 1] : null;
  }

  private findRevealTargetElement(container: HTMLElement, target: ChatRevealTarget): HTMLElement | null {
    switch (target) {
      case 'current-response':
        return container.querySelector<HTMLElement>('.dialog-box.chat-most-recent-response');
      case 'checkpoint-anchor':
        return this.normalizeRevealElement(container.querySelector<HTMLElement>(
          '.chat-checkpoint-restore-surface, .dialog-box.user.has-turn-actions, .user-turn-actions',
        ));
      case 'pending-confirmation':
        return this.normalizeRevealElement(container.querySelector<HTMLElement>(
          '.cag-item-pending-approval, .cag-item-confirmation-widget, .chat-confirmation-widget2, x-aily-confirmation-viewer',
        ))
          ?? this.findPageRevealElement(container, '.chat-tool-confirmation-carousel-container.has-confirmation');
      case 'pending-question':
        return this.normalizeRevealElement(container.querySelector<HTMLElement>('x-aily-question-viewer'))
          ?? this.findPageRevealElement(container, '.chat-question-carousel-widget-container.has-question');
      case 'pending-plan-review':
        return this.findPageRevealElement(container, '.chat-plan-review-widget-container.has-plan-review');
      default:
        return null;
    }
  }

  private findPageRevealElement(container: HTMLElement, selector: string): HTMLElement | null {
    const root = typeof container.closest === 'function'
      ? (container.closest<HTMLElement>('.chat-stage, .window-box') ?? container.ownerDocument?.body ?? null)
      : (container.ownerDocument?.body ?? null);
    return root?.querySelector<HTMLElement>(selector) ?? null;
  }

  private normalizeRevealElement(element: HTMLElement | null): HTMLElement | null {
    return element?.closest<HTMLElement>('.dialog-box') ?? element;
  }

  private isTargetInsideContainer(container: HTMLElement, target: HTMLElement): boolean {
    if (target === container) {
      return true;
    }

    if (typeof container.contains === 'function') {
      return container.contains(target);
    }

    return true;
  }

  private computeDialogTop(container: HTMLElement, dialog: HTMLElement): number {
    const containerRect = container.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const offsetTop = container.scrollTop + (dialogRect.top - containerRect.top);
    return Math.max(0, offsetTop);
  }
}
