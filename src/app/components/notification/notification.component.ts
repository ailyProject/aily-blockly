import { ChangeDetectorRef, Component } from '@angular/core';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { CommonModule } from '@angular/common';
import { NoticeOptions, NoticeService, UiService } from '@core/app-shell/public-api';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-notification',
  imports: [
    NzProgressModule,
    CommonModule,
    TranslateModule
  ],
  templateUrl: './notification.component.html',
  styleUrl: './notification.component.scss'
})
export class NotificationComponent {

  data: NoticeOptions;
  isClosable = true;

  willClose = false;

  progressValue = 0; // 显示的当前进度值
  targetProgress = 0; // 目标进度值
  animationFrameId: number; // 动画帧ID
  animationDuration = 300; // 动画持续时间（毫秒）

  constructor(
    private noticeService: NoticeService,
    private cd: ChangeDetectorRef,
    private uiService: UiService
  ) { }

  timer;

  ngOnInit(): void {
    this.noticeService.stateSubject.subscribe((data) => {
      if (data && data.showProgress !== false) {
        data.showProgress = true;
      }

      const closable = data ? (data.closable ?? data.state !== 'doing') : true;
      this.isClosable = closable;
      this.data = data ? { ...data, closable, text: data.text ? this.cleanAnsi(data.text) : data.text } : data;

      // 如果有进度值，启动进度动画
      if (this.data && this.data.progress !== undefined) {
        this.startProgressAnimation(this.data.progress);
      }

      if (this.timer) {
        clearTimeout(this.timer);
      }
      if (this.data?.setTimeout) {
        this.timer = setTimeout(() => {
          this.close();
        }, this.data.setTimeout);
      }
      // Intrinsic CSS sizing keeps progress updates from forcing repeated
      // synchronous layouts of the entire (potentially very large) workspace.
      this.cd.detectChanges();
    });
  }

  ngOnDestroy(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  close() {
    this.willClose = true;
    setTimeout(() => {
      this.data = null;
      this.willClose = false;
      this.cd.detectChanges();
    }, 500);
  }

  // 开始进度动画
  startProgressAnimation(targetValue: number): void {
    targetValue = this.clampProgress(targetValue);

    // 取消之前的动画帧
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    const startValue = this.clampProgress(this.progressValue);
    const startTime = performance.now();
    const endValue = targetValue;

    // 动画函数
    const animateProgress = (currentTime: number) => {
      const elapsedTime = currentTime - startTime;
      // A frame's shared timestamp can precede this animation's start time
      // when earlier callbacks in that frame do expensive workspace rendering.
      const progress = Math.max(0, Math.min(elapsedTime / this.animationDuration, 1));

      // 计算当前值（使用缓动函数使动画更平滑）
      this.progressValue = this.clampProgress(
        Math.round(startValue + (endValue - startValue) * this.easeOutQuad(progress))
      );
      this.cd.detectChanges();

      // 如果动画未完成，则继续请求动画帧
      if (progress < 1) {
        this.animationFrameId = requestAnimationFrame(animateProgress);
      } else {
        this.progressValue = endValue; // 确保最终值准确
        this.targetProgress = endValue;
      }
    };

    // 保存目标值并启动动画
    this.targetProgress = targetValue;
    this.animationFrameId = requestAnimationFrame(animateProgress);
  }

  // 缓动函数，使动画更自然
  private clampProgress(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.floor(value)));
  }

  easeOutQuad(t: number): number {
    return t * (2 - t);
  }

  stop() {
    this.data.stop();
  }

  /** 通知条「重试」：由业务注入 onRetry（须自行幂等/防并发） */
  onRetryClick() {
    this.data?.onRetry?.();
  }

  view() {
    console.log('viewDetail');
    console.log(this.data);
    this.uiService.openBottomSider('log');
  }

  // 清除 ANSI 格式化字符，先移除 SGR 颜色序列，再清除残留 ESC 字符
  private cleanAnsi(text: string): string {
    if (!text) return '';
    return text.replace(/\x1b\[[\d;]*m/g, '').replace(/\x1b/g, '');
  }

  private cleanLogContent(text: string): string {
    if (!text) return '';
    let cleaned = this.cleanAnsi(text);
    cleaned = cleaned.replace(/^\s*\[(ERROR|INFO|WARN|WARNING|DEBUG|TRACE|FATAL)\]\s*/gim, '');
    return cleaned;
  }

  sendAI() {
    console.log(this.data);
    const detail = this.cleanLogContent(this.data?.detail || '');
    this.uiService.openAndSendToChat(`log:\n${detail}`, {
      sender: 'NotificationComponent',
      type: 'log'
    });
  }

}
