# Legacy UI Alignment Plan

## Goal

在保留当前重构后底层架构与包边界的前提下，把 `packages/ui` 的用户可见体验重新对齐到 legacy `aily-blockly` 仓库。

## Constraints

- `REFACTOR.md` 是唯一重构基线。
- 目标不是“风格接近”，而是尽量直接复刻 legacy UI 的布局、元素层级、窗口行为、页面跳转逻辑。
- legacy 参考必须同时使用：
  - `/Users/xiewendao/Documents/aily/aily-blockly/`
  - `legacy_deepwiki/README.md`
  - `legacy_deepwiki/6-user-interface.md`
  - `legacy_deepwiki/6.1-main-window-layout.md`
  - `legacy_deepwiki/6.2-header-and-controls.md`
  - `legacy_deepwiki/8.2-themes-and-styling.md`
- 允许重写实现，但不允许继续保留与 legacy 明显不一致的主界面体验。
- 当前 `packages/ui` 使用 Angular 22，修改后必须执行 `ng build` 验证。

## Findings

- 当前 `packages/ui` 已偏离 legacy：
  - 主壳层是新的 `AppShellComponent` + 左侧导航卡片布局。
  - 主页面 `pages/main` 采用“workspace/tools”卡片导航，不是 legacy 的桌面 IDE 三栏结构。
  - 全局样式走 Tailwind token 和现代卡片视觉，不是 legacy 的 IDE 主题变量体系。
- 用户已明确否决任何主观设计发挥，必须停止“基于 legacy 再设计”。
- 当前还有功能性回归，优先级高于视觉细节：
  - Electron 主窗口默认不是 legacy 的 frameless 无边框窗口。
  - UI 在 desktop -> core bridge 完成前就提前构造 `getCore()` 单例，导致 recent projects / create project 等 RPC 命中错误 baseUrl。
- legacy 的核心 UI 合同：
  - 固定头部 `Header`
  - 中央内容区 `router-outlet`
  - 底部诊断面板：`log` / `terminal`
  - 右侧工具栏：`code-viewer` / `serial-monitor` / `aily-chat` / `model-store` 等
  - 深色主题默认、`--aily-*` 变量驱动、MiSans/FiraCode 字体体系

## Implementation Order

1. 修复 frameless 窗口与 core bridge 启动时序
2. 撤销/替换所有主观设计化的主壳层改动
3. 直接按 legacy `main-window` / `header` / `guide` / `project-new` 迁移 DOM 结构与 SCSS
4. 对齐页面跳转逻辑与最近项目 / 创建项目 / 打开项目行为
5. 构建验证并记录剩余差异

## Current Status

- 已确认 user brief：底层可变，体验和界面不能变。
- 已修复：
  - `packages/desktop` 主窗口恢复 frameless 参数。
  - `packages/ui` 改为在应用启动前等待 desktop core bridge，就绪后再初始化路由与会话恢复。
- 下一步需要直接移植 legacy 页面，而不是继续调整现有“实验版”壳层。

## Next Actions

1. 读取当前 `packages/ui` 的 `main`、`guide`、`blockly-editor`、主题文件。
2. 读取 legacy 对应页面与主题文件。
3. 先改主壳层与主题变量，再改入口页。
4. 运行 `pnpm --filter ui build` 并修复编译问题。
