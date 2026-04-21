# aily-blockly E2E

基于 Playwright for Electron 的端到端自动化测试。

## 快速开始

```powershell
# 首次：安装依赖
cd e2e
npm install
npx playwright install chromium   # 某些 CDP/trace 功能需要

# 本地跑（headed，看到真实窗口）
npm run test:headed

# 跑单个 spec
npm run test:dev -- specs/01-startup.spec.ts

# 跑"全板卡建项目+编译"矩阵
npm run aily-test -- boards run --mock

# 环境自检
npm run doctor
```

## 目录
- `cli/` — `aily-test` CLI（commander）
- `fixtures/` — Playwright fixture、mock 二进制、测试数据（boards.json、sample-projects）
- `pages/` — Page Object 层（每个路由一个 class）
- `specs/` — 测试用例
- `utils/` — 选择器常量、IPC bridge helper
- `reports/` — HTML/JSON 报告（gitignore）

## 环境变量
- `AILY_TEST_TARGET` — `dev` | `prod`（决定启动 `ng serve` + electron --serve 还是 dist 产物）
- `AILY_TEST_WORKERS` — 并发数
- `MOCK_BUILDER=1` — 用假 aily-builder，编译只跑 UI/IPC 链路
- `MOCK_HARDWARE=1` — probe-rs / serial 走 mock
- `HARDWARE=real` — 显式切真硬件
- `AILY_USERDATA` — 测试专用 userData（fixture 自动注入临时目录，一般无需手填）

## 约定
- 选择器集中在 `utils/selectors.ts`；渲染端组件需加 `data-testid`（见根目录 docs 或与开发对齐）
- 每个 test 用独立临时 userData + 临时项目目录，杜绝串扰
- 主进程只在 `--test-mode` 下加载 `electron/test-hooks.js`，生产产物零污染
