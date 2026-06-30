import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ThemeService } from '../../services/theme.service';
import type { DevelopmentModePreference } from '../../services/config.service';

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
export class ModeWelcomeComponent {
  /** 控制整体显隐 */
  @Input() show = false;

  /** 用户确认选择某个模式 */
  @Output() select = new EventEmitter<WelcomeSide>();

  /** 用户选择「稍后再说」 */
  @Output() skip = new EventEmitter<void>();

  /** 当前 hover 的一侧，用于左右对立的强调/弱化效果 */
  hoveredSide: WelcomeSide | null = null;

  /** 已确认选中的一侧，触发收尾动画 */
  chosenSide: WelcomeSide | null = null;

  /** 收尾动画进行中，避免重复触发 */
  private leaving = false;

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

  constructor(private themeService: ThemeService) {}

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

  choose(side: WelcomeSide): void {
    if (this.leaving) {
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

  onSkip(): void {
    if (this.leaving) {
      return;
    }
    this.leaving = true;
    setTimeout(() => {
      this.skip.emit();
    }, 260);
  }
}
