import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  OnDestroy,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { TranslateModule } from '@ngx-translate/core';
import { ThemeService } from '../../services/theme.service';
import type { DevelopmentModePreference } from '../../services/config.service';
import {
  CoderDependencyService,
  CoderDependencyState,
} from '../../services/coder-dependency.service';

type WelcomeSide = DevelopmentModePreference;

/**
 * 首次进入时的全屏「开发模式」引导。
 * 左右对立两块面板（Blockly / Coder），带入场与选择动画，
 * 选择结果通过 (select) 回传，跳过通过 (skip) 回传。
 */
@Component({
  selector: 'app-mode-welcome',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './mode-welcome.component.html',
  styleUrl: './mode-welcome.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModeWelcomeComponent implements OnDestroy {
  /** 控制整体显隐 */
  @Input() show = false;

  /** 用户确认选择某个模式 */
  @Output() select = new EventEmitter<WelcomeSide>();

  /** 用户选择「稍后再说」 */
  @Output() skip = new EventEmitter<void>();

  /** 当前 hover 的一侧，用于左右对立的强调/弱化效果 */
  hoveredSide: WelcomeSide | null = null;

  /** 当前选择项；切换到 Coder 时立即开始安装依赖。 */
  selectedSide: WelcomeSide = 'blockly';

  /** 已确认选中的一侧，触发收尾动画 */
  chosenSide: WelcomeSide | null = null;

  coderDependencyState: CoderDependencyState;

  /** 收尾动画进行中，避免重复触发 */
  private leaving = false;
  private readonly dependencySubscription: Subscription;

  /** Blockly 面板的特性列表 i18n key */
  readonly blocklyFeatures = [
    'MODE_WELCOME.BLOCKLY_FEATURE_1',
    'MODE_WELCOME.BLOCKLY_FEATURE_2',
    'MODE_WELCOME.BLOCKLY_FEATURE_3',
  ];

  /** Coder 面板的特性列表 i18n key */
  readonly coderFeatures = [
    'MODE_WELCOME.CODER_FEATURE_1',
    'MODE_WELCOME.CODER_FEATURE_2',
    'MODE_WELCOME.CODER_FEATURE_3',
  ];

  constructor(
    private readonly themeService: ThemeService,
    private readonly coderDependency: CoderDependencyService,
    private readonly cdr: ChangeDetectorRef,
  ) {
    this.coderDependencyState = this.coderDependency.state;
    this.dependencySubscription = this.coderDependency.state$.subscribe((state) => {
      this.coderDependencyState = state;
      this.cdr.markForCheck();
    });
    void this.coderDependency.initialize();
  }

  get logoSrc(): string {
    return this.themeService.theme() === 'light'
      ? 'imgs/logo-light.webp'
      : 'imgs/logo.webp';
  }

  onHover(side: WelcomeSide | null): void {
    if (this.leaving) {
      return;
    }
    this.hoveredSide = side;
  }

  selectSide(side: WelcomeSide): void {
    if (this.leaving) {
      return;
    }
    this.selectedSide = side;
    if (side === 'coder' && !this.coderDependencyState.installed) {
      void this.installCoderDependency();
    }
  }

  choose(event: Event, side: WelcomeSide): void {
    event.stopPropagation();
    if (this.leaving) {
      return;
    }
    if (this.selectedSide !== side) {
      this.selectSide(side);
      if (side === 'coder') {
        return;
      }
    }
    if (!this.canChoose(side)) {
      return;
    }
    this.leaving = true;
    this.chosenSide = side;
    this.hoveredSide = side;
    // 等收尾动画播放后再回传，保证视觉连贯
    setTimeout(() => {
      this.select.emit(side);
    }, 620);
  }

  canChoose(side: WelcomeSide): boolean {
    return side === 'blockly'
      || (this.coderDependencyState.installed && !this.coderDependencyState.installing);
  }

  retryCoderInstall(event: Event): void {
    event.stopPropagation();
    if (!this.coderDependencyState.installing) {
      void this.installCoderDependency();
    }
  }

  onSkip(): void {
    if (this.leaving) {
      return;
    }
    this.leaving = true;
    setTimeout(() => {
      this.skip.emit();
    }, 260);
  }

  ngOnDestroy(): void {
    this.dependencySubscription.unsubscribe();
  }

  private async installCoderDependency(): Promise<void> {
    try {
      await this.coderDependency.ensureInstalled();
    } catch {
      // 具体错误由依赖服务投影到当前卡片，用户可在原处重试。
    }
  }
}
