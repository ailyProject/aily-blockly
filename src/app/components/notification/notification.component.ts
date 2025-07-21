import { ChangeDetectorRef, Component, ElementRef, Renderer2 } from '@angular/core';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { CommonModule } from '@angular/common';
import { NoticeOptions, NoticeService } from '../../services/notice.service';
import { UiService } from '../../services/ui.service';

@Component({
  selector: 'app-notification',
  imports: [
    NzProgressModule,
    CommonModule
  ],
  templateUrl: './notification.component.html',
  styleUrl: './notification.component.scss'
})
export class NotificationComponent {

  data: NoticeOptions;

  willClose = false;

  progressValue = 0; // 显示的当前进度值
  targetProgress = 0; // 目标进度值
  animationFrameId: number; // 动画帧ID
  animationDuration = 300; // 动画持续时间（毫秒）

  tempWidth = 250;

  constructor(
    private noticeService: NoticeService,
    private cd: ChangeDetectorRef,
    private elementRef: ElementRef,
    private renderer: Renderer2,
    private uiService: UiService
  ) { }

  timer;

  ngOnInit(): void {
    this.noticeService.stateSubject.subscribe((data) => {
      this.data = data;

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
      this.tempWidth = 112 + this.getTextWidth();
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
    // 取消之前的动画帧
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    const startValue = this.progressValue;
    const startTime = performance.now();
    const endValue = targetValue;

    // 动画函数
    const animateProgress = (currentTime: number) => {
      const elapsedTime = currentTime - startTime;
      const progress = Math.min(elapsedTime / this.animationDuration, 1);

      // 计算当前值（使用缓动函数使动画更平滑）
      this.progressValue = Math.round(startValue + (endValue - startValue) * this.easeOutQuad(progress));

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
  easeOutQuad(t: number): number {
    return t * (2 - t);
  }

  // 计算.text的宽度
  getTextWidth() {
    const text = this.data?.text;
    if (!text) {
      return 0;
    }
    const span = this.renderer.createElement('span');
    this.renderer.setStyle(span, 'position', 'absolute');
    this.renderer.setStyle(span, 'white-space', 'nowrap');
    this.renderer.setStyle(span, 'font-size', '12px');
    this.renderer.setStyle(span, 'opacity', '0');
    this.renderer.setStyle(span, 'z-index', '-1');
    this.renderer.appendChild(span, this.renderer.createText(text));
    this.renderer.appendChild(this.elementRef.nativeElement, span);
    const width = span.offsetWidth;
    this.renderer.removeChild(this.elementRef.nativeElement, span);
    return width;
  }


  stop() {
    this.data.stop();
  }

  view() {
    console.log('viewDetail');
    console.log(this.data);
    this.uiService.openBottomSider('log');
  }

  askAI() {
    console.log('askAI');
  }

}
