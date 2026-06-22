# Step 4: eRPC、Shared 与全量类型体系

## 本轮目标

建立统一协议层，让 `packages/ui`、`packages/core/agent`、`packages/desktop` 之间的调用摆脱“散装 RPC + any + stringly typed”的状态。

## 目标形态

建议建立统一的 `shared + erpc + typed capability event` 体系。

这里特别强调：

- `packages/erpc` 对齐 `polywise/packages/erpc`
- 它是 Electron 场景下的 typed RPC 工具包
- 它负责 transport、adapter、client/server link
- 它不承担业务编排，不持有业务状态

## 推荐目录

```text
packages/shared/
  src/chat/
  src/project/
  src/build/
  src/hardware/
  src/files/
  src/system/
  src/events/
  src/index.ts
  utils/

packages/erpc/
  src/router/
  src/client/
  src/server/
  src/links/
  src/ipc/
```

## 设计原则

1. 所有跨边界调用先定义 schema
2. 不把 Electron IPC 当业务协议
3. 类型定义集中，不分散在组件附近

所有共享类型和跨包协议辅助能力应该收拢到：

- `packages/shared`
- `packages/shared/utils`

## Electron 场景下的 eRPC 方案

- `packages/ui` 调 `packages/core/agent` 走 `packages/erpc`
- `packages/core/agent` 与 `packages/desktop` 之间走自定义 typed IPC bridge

## 关键迁移动作

### 动作 1: 先建 shared

优先抽出：

- `ChatSessionStartInput/Output`
- `BuildProjectInput/Output`
- `SearchBoardsLibrariesInput/Output`
- `SyncAbsInput/Output`
- `InstallLibraryInput/Output`

### 动作 2: 收拢工具输入输出

- shared 里定义
- tool 只引用 shared schema

### 动作 3: 给 IPC 加 typed wrapper，并沉淀到 `packages/erpc`

注意：

- `packages/erpc` 只沉淀通用 bridge、link、adapter、types
- 业务 router 和业务用例不应该塞进 `erpc`

## 验收标准

- 至少 5 条核心业务链路完成 shared schema 化
- `packages/ui` 到 `packages/core/agent` 的新链路使用 typed RPC
- 新增跨边界调用不再允许裸 `any`
- Electron IPC 至少有一层 typed wrapper
