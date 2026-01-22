import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, OnChanges, SimpleChanges, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { OnboardingConfig, OnboardingStep } from '../../services/onboarding.service';

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss'
})
export class OnboardingComponent implements OnInit, OnDestroy, OnChanges, AfterViewChecked {
  /** 是否显示新手引导 */
  @Input() show = false;
  
  /** 引导配置 */
  @Input() config!: OnboardingConfig;
  
  /** 当前步骤索引 */
  @Input() initialStep = 0;
  
  /** 关闭/跳过引导时触发 */
  @Output() closed = new EventEmitter<void>();
  
  /** 完成引导时触发 */
  @Output() completed = new EventEmitter<void>();
  
  /** 步骤变化时触发 */
  @Output() stepChange = new EventEmitter<number>();

  /** 提示框元素引用 */
  @ViewChild('tooltipRef') tooltipRef?: ElementRef<HTMLDivElement>;

  /** 当前步骤索引 */
  currentStep = 0;
  
  /** 高亮区域样式 */
  highlightStyle: { [key: string]: string } = {};
  
  /** 提示框样式 */
  tooltipStyle: { [key: string]: string } = {};
  
  /** 箭头样式 */
  arrowStyle: { [key: string]: string } = {};

  /** 实际的箭头位置（可能因空间不足而与配置不同） */
  actualArrowPosition: string = 'top';

  /** resize 监听器 */
  private resizeObserver?: ResizeObserver;
  private resizeListener?: () => void;
  
  /** 当前目标元素的 rect，用于位置调整 */
  private currentTargetRect?: DOMRect;
  
  /** 是否需要调整位置 */
  private needsPositionAdjustment = false;

  ngOnInit(): void {
    this.currentStep = this.initialStep;
    if (this.show) {
      this.setupListeners();
      this.updateHighlight();
    }
  }

  ngAfterViewChecked(): void {
    // 在视图更新后，根据实际提示框高度调整位置
    if (this.needsPositionAdjustment && this.tooltipRef && this.currentTargetRect) {
      this.needsPositionAdjustment = false;
      this.adjustTooltipPosition();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['show']) {
      if (this.show) {
        this.currentStep = this.initialStep;
        this.setupListeners();
        // 延迟更新，确保 DOM 已渲染
        setTimeout(() => this.updateHighlight(), 50);
      } else {
        this.cleanupListeners();
      }
    }
    if (changes['config'] && this.show) {
      setTimeout(() => this.updateHighlight(), 50);
    }
  }

  ngOnDestroy(): void {
    this.cleanupListeners();
  }

  /** 设置监听器 */
  private setupListeners(): void {
    // 窗口大小变化时更新位置
    this.resizeListener = () => this.updateHighlight();
    window.addEventListener('resize', this.resizeListener);
  }

  /** 清理监听器 */
  private cleanupListeners(): void {
    if (this.resizeListener) {
      window.removeEventListener('resize', this.resizeListener);
      this.resizeListener = undefined;
    }
  }

  /** 获取当前步骤 */
  get step(): OnboardingStep | null {
    return this.config?.steps?.[this.currentStep] ?? null;
  }

  /** 获取步骤总数 */
  get totalSteps(): number {
    return this.config?.steps?.length ?? 0;
  }

  /** 获取配置值（带默认值） */
  private getConfig<K extends keyof OnboardingConfig>(key: K, defaultValue: NonNullable<OnboardingConfig[K]>): NonNullable<OnboardingConfig[K]> {
    return (this.config?.[key] ?? defaultValue) as NonNullable<OnboardingConfig[K]>;
  }

  /** 更新高亮区域位置 */
  updateHighlight(): void {
    if (!this.step) return;
    
    const element = document.querySelector(this.step.target) as HTMLElement;
    if (!element) {
      console.warn(`[Onboarding] Target element not found: ${this.step.target}`);
      return;
    }

    const rect = element.getBoundingClientRect();
    const padding = this.getConfig('padding', 8);
    
    this.highlightStyle = {
      top: `${rect.top - padding}px`,
      left: `${rect.left - padding}px`,
      width: `${rect.width + padding * 2}px`,
      height: `${rect.height + padding * 2}px`
    };

    // 保存当前 rect，用于后续调整
    this.currentTargetRect = rect;
    this.needsPositionAdjustment = true;
    
    // 先用估计值计算位置，后续会根据实际高度调整
    this.calculateTooltipPosition(rect, this.step.position);
  }

  /** 根据实际提示框高度调整位置 */
  private adjustTooltipPosition(): void {
    if (!this.tooltipRef || !this.currentTargetRect || !this.step) return;
    
    const tooltipElement = this.tooltipRef.nativeElement;
    const actualHeight = tooltipElement.offsetHeight;
    const actualWidth = tooltipElement.offsetWidth;
    
    // 使用实际尺寸重新计算位置
    this.calculateTooltipPositionWithSize(this.currentTargetRect, this.step.position, actualWidth, actualHeight);
  }

  /** 使用指定尺寸计算提示框位置 */
  private calculateTooltipPositionWithSize(rect: DOMRect, position: string, tooltipWidth: number, tooltipHeight: number): void {
    const gap = this.getConfig('gap', 20);
    const padding = this.getConfig('padding', 8);
    
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const edgePadding = 10;

    // 高亮框的实际位置（包含 padding）
    const highlightTop = rect.top - padding;
    const highlightLeft = rect.left - padding;
    const highlightWidth = rect.width + padding * 2;
    const highlightHeight = rect.height + padding * 2;
    const highlightRight = highlightLeft + highlightWidth;
    const highlightBottom = highlightTop + highlightHeight;
    const highlightCenterX = highlightLeft + highlightWidth / 2;
    const highlightCenterY = highlightTop + highlightHeight / 2;

    // 重置箭头样式
    this.arrowStyle = {};
    // 箭头位置表示"箭头指向的方向"
    this.actualArrowPosition = this.getOppositePosition(position);

    let top: number;
    let left: number;

    switch (position) {
      case 'right':
        top = highlightCenterY - tooltipHeight / 2;
        left = highlightRight + gap;
        if (left + tooltipWidth > windowWidth - edgePadding) {
          left = highlightLeft - tooltipWidth - gap;
          this.actualArrowPosition = 'right';
        }
        break;
        
      case 'left':
        top = highlightCenterY - tooltipHeight / 2;
        left = highlightLeft - tooltipWidth - gap;
        if (left < edgePadding) {
          left = highlightRight + gap;
          this.actualArrowPosition = 'left';
        }
        break;
        
      case 'bottom':
        top = highlightBottom + gap;
        left = highlightCenterX - tooltipWidth / 2;
        break;
        
      case 'top':
      default:
        top = highlightTop - tooltipHeight - gap;
        left = highlightCenterX - tooltipWidth / 2;
        if (top < edgePadding) {
          top = highlightBottom + gap;
          this.actualArrowPosition = 'top';
        }
        break;
    }

    // 限制提示框在可见范围内
    left = Math.max(edgePadding, Math.min(left, windowWidth - tooltipWidth - edgePadding));
    top = Math.max(edgePadding, Math.min(top, windowHeight - tooltipHeight - edgePadding));

    this.tooltipStyle = {
      top: `${top}px`,
      left: `${left}px`
    };

    // 计算箭头样式
    this.calculateArrowStyle(this.actualArrowPosition, left, top, tooltipWidth, tooltipHeight, highlightCenterX, highlightCenterY);
  }

  /** 计算提示框位置（使用配置的默认尺寸） */
  private calculateTooltipPosition(rect: DOMRect, position: string): void {
    const tooltipWidth = this.getConfig('tooltipWidth', 280);
    const tooltipHeight = this.getConfig('tooltipHeight', 200); // 增加默认高度
    this.calculateTooltipPositionWithSize(rect, position, tooltipWidth, tooltipHeight);
  }

  /** 获取相反的位置（用于箭头方向） */
  private getOppositePosition(position: string): string {
    switch (position) {
      case 'top': return 'bottom';    // 提示框在上方，箭头指向下方
      case 'bottom': return 'top';    // 提示框在下方，箭头指向上方
      case 'left': return 'right';    // 提示框在左边，箭头指向右边
      case 'right': return 'left';    // 提示框在右边，箭头指向左边
      default: return 'bottom';
    }
  }

  /** 计算箭头样式 */
  private calculateArrowStyle(
    arrowPosition: string,
    tooltipLeft: number,
    tooltipTop: number,
    tooltipWidth: number,
    tooltipHeight: number,
    highlightCenterX: number,
    highlightCenterY: number
  ): void {
    // arrowPosition 表示箭头指向的方向
    switch (arrowPosition) {
      case 'left':
        // 箭头指向左边（提示框在高亮框右边，箭头在提示框左侧）
        const arrowTopForLeft = highlightCenterY - tooltipTop - 6;
        this.arrowStyle = { top: `${Math.max(15, Math.min(arrowTopForLeft, tooltipHeight - 27))}px` };
        break;
        
      case 'right':
        // 箭头指向右边（提示框在高亮框左边，箭头在提示框右侧）
        const arrowTopForRight = highlightCenterY - tooltipTop - 6;
        this.arrowStyle = { top: `${Math.max(15, Math.min(arrowTopForRight, tooltipHeight - 27))}px` };
        break;
        
      case 'top':
        // 箭头指向上方（提示框在高亮框下方，箭头在提示框顶部）
        const arrowLeftForTop = highlightCenterX - tooltipLeft - 6;
        this.arrowStyle = { left: `${Math.max(15, Math.min(arrowLeftForTop, tooltipWidth - 27))}px` };
        break;
        
      case 'bottom':
      default:
        // 箭头指向下方（提示框在高亮框上方，箭头在提示框底部）
        const arrowLeftForBottom = highlightCenterX - tooltipLeft - 6;
        this.arrowStyle = { left: `${Math.max(15, Math.min(arrowLeftForBottom, tooltipWidth - 27))}px` };
        break;
    }
  }

  /** 下一步 */
  nextStep(): void {
    if (this.currentStep < this.totalSteps - 1) {
      this.currentStep++;
      this.stepChange.emit(this.currentStep);
      this.updateHighlight();
    } else {
      this.finish();
    }
  }

  /** 上一步 */
  prevStep(): void {
    if (this.currentStep > 0) {
      this.currentStep--;
      this.stepChange.emit(this.currentStep);
      this.updateHighlight();
    }
  }

  /** 跳过引导 */
  skip(): void {
    this.closed.emit();
  }

  /** 完成引导 */
  private finish(): void {
    this.completed.emit();
  }
}
