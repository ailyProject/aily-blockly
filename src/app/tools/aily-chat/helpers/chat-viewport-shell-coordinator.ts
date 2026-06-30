import type { ElementRef } from '@angular/core';

interface ScrollManagerLike {
  setContainer(ref: ElementRef): void;
  scrollToBottom(behavior?: string): void;
}

interface ViewStateLike {
  setBottomHeight(height: number): void;
}

export class ChatViewportShellCoordinator {
  constructor(
    private readonly deps: {
      scrollManager: ScrollManagerLike;
      viewState: ViewStateLike;
      requestSessionListSummaryLoad: () => void;
    },
  ) {}

  initialize(container: ElementRef): void {
    this.deps.scrollManager.setContainer(container);
    this.deps.requestSessionListSummaryLoad();
    this.deps.scrollManager.scrollToBottom();
  }

  resizeContent(height: number | undefined): void {
    if (typeof height === 'number' && !Number.isNaN(height)) {
      this.deps.viewState.setBottomHeight(height);
    }
  }
}