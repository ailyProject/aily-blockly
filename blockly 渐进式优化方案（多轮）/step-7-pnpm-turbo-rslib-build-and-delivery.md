# Step 7: pnpm、Turbo、Rslib 与构建交付体系升级

## 本轮目标

把当前“单仓 npm + Angular CLI + Electron Builder + child 脚本”的构建方式，逐步升级为更适合多包治理的 workspace 构建体系。

## 关键判断

- `turbo` 负责 monorepo 任务编排和缓存
- `rslib` 适合构建 Node 运行时、共享包、桌面壳
- `packages/ui` 短期保留现有 Angular 构建，先不强行替换

## 根层建议

新增：

- `pnpm-workspace.yaml`
- 根级 `package.json` scripts
- `turbo.json`
- 根级 `tsconfig.base.json`

最小骨架示例：

```yaml
packages:
  - packages/*
```

## 运行时路径兼容原则

构建与交付收口阶段，不把“修改运行时目录”作为目标。

明确要求：

- 不主动调整当前 app data 路径
- 不主动调整当前 toolchain / SDK / board 资源路径
- 不主动调整当前用户配置路径
- 优先保证现有运行环境与本地配置继续可用

## 构建职责

- `packages/ui`: 保留现有 Angular 构建，作为过渡方案
- `packages/desktop`: 使用 `rslib`
- `packages/core/agent`: 使用 `rslib`
- `packages/shared` / `packages/shared/utils`: 优先 `tsc` 或轻量构建
- `packages/core`: 使用 `rslib`

## 推荐推进方式

### 阶段 7.1

先引入 `pnpm workspace + turbo`

### 阶段 7.2

先把基础包迁到 workspace：

- `shared`
- `shared/utils`

### 阶段 7.3

再把运行时/领域包迁到 `rslib`：

- `blockly`
- `desktop`

### 阶段 7.4

最后处理根目录 `child/scripts/*` 的 TS 化与产物收口，建议归宿：

```text
packages/core/agent/build/
packages/core/build/
packages/desktop/toolchain/
```
