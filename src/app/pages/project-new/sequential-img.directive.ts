import { Directive, ElementRef, Input, OnDestroy, OnInit } from '@angular/core';

/**
 * 顺序加载图片指令
 * 用法: <img [sequentialSrc]="imageUrl" />
 * 图片会按 DOM 渲染顺序依次加载，前一张加载完成（或失败）后才加载下一张
 */
@Directive({
  selector: '[sequentialSrc]',
  standalone: true,
})
export class SequentialImgDirective implements OnInit, OnDestroy {
  @Input('sequentialSrc') src: string = '';

  /** 同时允许加载的最大并发数 */
  @Input() sequentialBatch: number = 1;

  private static queue: SequentialImgDirective[] = [];
  private static loading = 0;
  private static maxConcurrent = 1;

  private resolved = false;

  constructor(private el: ElementRef<HTMLImageElement>) {}

  ngOnInit() {
    // 初始隐藏图片，加载完成后渐出
    const img = this.el.nativeElement;
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.1s ease-in';

    SequentialImgDirective.maxConcurrent = this.sequentialBatch;
    SequentialImgDirective.queue.push(this);
    SequentialImgDirective.tryLoadNext();
  }

  ngOnDestroy() {
    // 从队列中移除
    const idx = SequentialImgDirective.queue.indexOf(this);
    if (idx !== -1) {
      SequentialImgDirective.queue.splice(idx, 1);
    }
  }

  private load() {
    if (this.resolved) return;
    this.resolved = true;
    SequentialImgDirective.loading++;

    const img = this.el.nativeElement;

    const done = () => {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      SequentialImgDirective.loading--;
      SequentialImgDirective.tryLoadNext();
    };

    const onLoad = () => {
      img.style.opacity = '1';
      done();
    };

    const onError = () => {
      img.style.opacity = '1';
      done();
    };

    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
    img.src = this.src;
  }

  private static tryLoadNext() {
    while (
      this.loading < this.maxConcurrent &&
      this.queue.length > 0
    ) {
      const next = this.queue.shift();
      if (next && !next.resolved) {
        next.load();
      }
    }
  }
}
