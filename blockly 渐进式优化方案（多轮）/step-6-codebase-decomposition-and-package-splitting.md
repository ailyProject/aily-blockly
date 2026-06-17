# Step 6: 巨型文件拆分、巨型组件治理与包化重构

## 本轮目标

系统性治理“巨型单文件”“巨型组件”“巨型 service”问题，把维护负担从个人记忆转回模块边界。

## 重点拆分方案

### 1. `editBlockTool.ts`

建议拆到：

```text
packages/core/agent/tools/blockly/
  context/
  workspace/
  create/
  connect/
  configure/
  delete/
  overview/
  query-definition/
  library-analysis/
  abs/
```

### 2. `atomicBlockTools.ts`

建议拆到：

```text
packages/core/agent/tools/blockly-atomic/
  create-single-block.ts
  connect-blocks-simple.ts
  set-block-field.ts
  set-block-input.ts
  batch-create-blocks.ts
  workspace-overview.ts
  mapping-store.ts
```

### 3. `blockly.service.ts` 与相关领域逻辑

建议逐步拆进：

```text
packages/core/
  document/
  abs/
  abi/
  metadata/
  project/
  build/
  hardware/
  agent/
```

### 4. `electron/main.js` 与 `preload.js`

建议拆进：

```text
packages/desktop/
  src/main/
  src/preload/
  src/capabilities/
  src/ipc/
  src/window/
```

## 包化策略

- 业务规则进入 `packages/core`
- AI 工具与运行时进入 `packages/core/agent`
- Electron 能力进入 `packages/desktop`
- 前端 UI 主体进入 `packages/ui`
- 跨包公共函数进入 `packages/shared/utils`
