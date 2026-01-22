# Onboarding 新手引导组件

一个通用的新手引导（onboarding）组件，用于在页面上高亮显示目标元素并展示引导提示框。

## 架构说明

新手引导采用集中式管理：
- **OnboardingComponent**: 唯一的引导 UI 组件，放置在 `main-window` 中
- **OnboardingService**: 服务层，其他组件通过服务触发引导
- **onboarding.config.ts**: 集中管理所有引导配置

## 基本用法

### 1. 在配置文件中定义引导步骤

在 `src/app/configs/onboarding.config.ts` 中添加配置：

```typescript
import { OnboardingConfig } from '../services/onboarding.service';

export const YOUR_ONBOARDING_CONFIG: OnboardingConfig = {
  steps: [
    {
      target: '.your-element',
      titleKey: 'YOUR_MODULE.ONBOARDING.STEP1_TITLE',
      descKey: 'YOUR_MODULE.ONBOARDING.STEP1_DESC',
      position: 'right'
    },
    // 更多步骤...
  ]
};
```

### 2. 在组件中通过服务触发引导

```typescript
import { OnboardingService } from '../../services/onboarding.service';
import { YOUR_ONBOARDING_CONFIG } from '../../configs/onboarding.config';

@Component({
  // ...
})
export class YourComponent {
  constructor(
    private onboardingService: OnboardingService,
    private configService: ConfigService
  ) {}

  ngOnInit() {
    this.checkOnboarding();
  }

  private checkOnboarding() {
    const hasSeenOnboarding = this.configService.data.yourOnboardingCompleted;
    if (!hasSeenOnboarding) {
      setTimeout(() => {
        this.onboardingService.start(YOUR_ONBOARDING_CONFIG, {
          onClosed: () => this.onOnboardingClosed(),
          onCompleted: () => this.onOnboardingClosed()
        });
      }, 500);
    }
  }

  private onOnboardingClosed() {
    this.configService.data.yourOnboardingCompleted = true;
    this.configService.save();
  }
}
```

## 配置接口

### OnboardingConfig

```typescript
interface OnboardingConfig {
  /** 引导步骤列表（必填） */
  steps: OnboardingStep[];
  
  /** 高亮区域的内边距，默认为 8 */
  padding?: number;
  
  /** 提示框与高亮区域的间距，默认为 20 */
  gap?: number;
  
  /** 提示框宽度，默认为 280 */
  tooltipWidth?: number;
  
  /** 提示框高度（用于初始位置计算），默认为 200 */
  tooltipHeight?: number;
}
```

> **注意**: 按钮文本（跳过、上一步、下一步、完成）统一使用 `COMMON.ONBOARDING.*` 的翻译键，无需在配置中指定。

### OnboardingStep

```typescript
interface OnboardingStep {
  /** 目标元素的 CSS 选择器 */
  target: string;
  
  /** 标题的国际化 key */
  titleKey: string;
  
  /** 描述的国际化 key */
  descKey: string;
  
  /** 提示框相对于高亮元素的位置 */
  position: 'top' | 'bottom' | 'left' | 'right';
}
```

## OnboardingService API

### 方法

| 方法 | 参数 | 说明 |
|------|------|------|
| `start(config, options?)` | `config: OnboardingConfig`, `options?: { onClosed?, onCompleted? }` | 启动引导 |
| `close()` | 无 | 关闭引导（触发 onClosed 回调） |
| `complete()` | 无 | 完成引导（触发 onCompleted 回调） |
| `reset()` | 无 | 重置服务状态 |

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `isShowing` | `boolean` | 当前是否正在显示引导 |
| `currentConfig` | `OnboardingConfig \| null` | 当前引导配置 |
| `show$` | `Observable<boolean>` | 显示状态的可观察对象 |
| `config$` | `Observable<OnboardingConfig \| null>` | 配置的可观察对象 |

## 现有配置

项目中已定义的引导配置（位于 `src/app/configs/onboarding.config.ts`）：

- `GUIDE_ONBOARDING_CONFIG` - 引导页面的新手引导
- `BLOCKLY_ONBOARDING_CONFIG` - Blockly 编辑器的新手引导
- `AILY_CHAT_ONBOARDING_CONFIG` - AI 助手的新手引导

## 添加国际化文本

在 `public/i18n/zh_cn/zh_cn.json` 中添加步骤文本：

```json
{
  "YOUR_MODULE": {
    "ONBOARDING": {
      "STEP1_TITLE": "步骤标题",
      "STEP1_DESC": "步骤描述内容"
    }
  }
}
```

按钮文本已在 `COMMON.ONBOARDING` 中统一定义：

```json
{
  "COMMON": {
    "ONBOARDING": {
      "SKIP": "跳过",
      "PREV": "上一步",
      "NEXT": "下一步",
      "DONE": "完成"
    }
  }
}
```

## 位置说明

`position` 属性决定提示框相对于高亮元素的位置：

- `top`: 提示框在高亮元素**上方**，箭头指向下方
- `bottom`: 提示框在高亮元素**下方**，箭头指向上方
- `left`: 提示框在高亮元素**左边**，箭头指向右边
- `right`: 提示框在高亮元素**右边**，箭头指向左边

> **注意**: 如果指定位置空间不足，组件会自动调整到相反位置。

## 特性

- ✅ 集中式配置管理
- ✅ 通过服务触发，组件间解耦
- ✅ 自动高亮目标元素
- ✅ 智能位置调整（空间不足时自动切换方向）
- ✅ 箭头自动指向高亮框中心
- ✅ 响应窗口大小变化
- ✅ 支持国际化
- ✅ 根据实际内容高度动态调整位置
- ✅ 支持上一步/下一步/跳过操作
- ✅ 支持关闭和完成回调

## 样式自定义

组件使用了以下 CSS 变量和类名，可以通过全局样式覆盖：

```scss
// 高亮框样式
.onboarding-highlight {
  border: 2px solid #3b82f6;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.7);
}

// 提示框样式
.onboarding-tooltip {
  background: #1e1e1e;
  border: 1px solid #3b82f6;
  border-radius: 12px;
}

// 按钮样式
.btn-next {
  background: #3b82f6;
}
```
