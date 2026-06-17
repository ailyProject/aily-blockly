# Step 8: 执行路线图、灰度策略与验收体系

## 推荐分 5 个执行批次

### 批次 A: 基线与基础设施

- 定义架构边界
- 建 `shared`
- 建 workspace
- 建 `shared` 与 `shared/utils` 基础包

### 批次 B: AI runtime 后移

- 建立新的 `packages/core/agent` 主执行边界
- 迁移 prompt pipeline
- 迁移 tool loop
- `packages/ui` 改成 UI facade

### 批次 C: Blockly / Build / Library 领域模块化

- 建 `packages/core` 聚合边界

### 批次 D: 前端壳层与样式现代化

- 接入 Tailwind v4
- 建 `packages/ui/components` 原子组件层

### 批次 E: 构建体系升级与收口

- `pnpm + turbo + rslib` 完成 monorepo 编排与核心运行时构建收口

## 关键风险与防护

- AI runtime 改造阶段不要同时大改 `packages/core/build` 行为
- 协议层推进时，先 shared，再 typed wrapper，再业务路由
- Tailwind 改造先壳层、先原子组件，不全站翻新

## 最终目标

- `packages/ui` 主要负责 UI
- `packages/core/agent` 主要负责推理和编排
- `packages/desktop` 主要负责本地系统能力
- `packages/erpc` 主要负责 Electron typed RPC 工具支持
- `packages/shared` 统一跨边界协议
- `packages/core` 承载核心领域逻辑
