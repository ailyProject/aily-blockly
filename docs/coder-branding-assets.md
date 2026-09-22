# Aily Coder 品牌图片

## 引用范围

| 原资源 | 当前用途 | Coder 对应资源 |
| --- | --- | --- |
| `public/imgs/logo.webp` | 首页深色主题；登录页品牌标识 | `public/imgs/logo-coder.png` |
| `public/imgs/logo-light.webp` | 首页浅色主题 | `public/imgs/logo-coder.png` |
| `public/imgs/subject.webp` | 项目广场缺省封面及加载失败回退；云空间缺省封面 | `public/imgs/subject-coder.png` |

`pages/playground/subject-list` 还保留旧封面引用，但没有路由或组件调用，不在当前运行路径。

`ConfigService.getApplicationLogoSrc()` 和 `getDefaultProjectImageSrc()` 通过
`isCoderProduct()` 选择独立 Coder 的资源。普通 Blockly 产品沿用原图片及主题行为。

Coder 首页和登录页共用一张透明字标。深色主题通过 `brightness(0) invert(1)`
显示白色字形，浅色主题显示原深灰色；两种主题的透明度、字形与尺寸完全一致。
不再使用这两个页面原先的 Coder 纯文本占位。

## 资源与生成方式

- `logo-coder.png`：489 × 110，RGBA，实际显示高度为首页 32 px、登录页 26 px。
- `subject-coder.png`：500 × 250，RGB，沿用蓝色渐变及两行白字风格。
- 使用内置 imagegen 生成。输出经裁边和缩小后放入项目；原 Blockly 资源未覆盖。
- 生成的白色字标候选有透明边缘或背景问题，未采用；最终深浅主题共用合格的透明深灰字标。

### 字标最终生成提示

Create a production-ready pure typographic logo asset. Exact text: "aily coder" in lowercase, bold humanist sans-serif similar to the typeface used by the Ubuntu wordmark but ordinary straight type. One horizontal line. Pure solid dark charcoal #4b4b49 letters, with perfectly smooth solid fills and clean antialiased edges. NO texture, distressing, speckles, extra strokes, outline, shadow, bevel, gradient or icon. Genuine transparent alpha-channel background, completely empty outside the glyphs and in letter counters. Do NOT draw a checkerboard or simulated transparency. Render the text sharply as if exported from a vector design file. Leave 5% transparent padding on all sides. Wide landscape canvas. This will be used at 32px height in a software UI, so keep the text tightly framed, perfectly legible and flat.

### 封面最终生成提示

Use case: text-localization. Asset type: 500x250 desktop application project-card fallback thumbnail. Reference image is the edit target. Replace only the text "aily blockly" with exact lowercase text "aily coder". Keep the second line exactly "example". Preserve the reference blurred blue gradient background, white bold sans-serif letters, left alignment, two-line layout, text size, line spacing and margins. Output is 2:1 aspect ratio. No new imagery, no code symbols, no icons, no added decorations, no borders, no watermark. Final text must be exactly two lines: "aily coder" and "example".

## 验证

- 147 项现有单元测试通过。
- Angular development 构建通过，两个 PNG 已进入构建产物。
- 服务架构检查：0 violations、0 cycles。
- 浏览器资源预览覆盖 Coder/Blockly × 深色/浅色；16 个图像元素均加载成功。
- 浏览器预览使用项目样式和资源验证颜色、透明边缘及 26/32 px 显示，未操作实际 Electron 登录会话。

