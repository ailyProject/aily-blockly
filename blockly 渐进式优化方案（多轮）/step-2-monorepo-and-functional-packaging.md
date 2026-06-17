# Step 2: Monorepo 改造流程与按功能职责分包

## 本轮目标

把当前单仓目录工程，改造成真正可治理的 monorepo。

## 目标仓库结构

```text
packages/
  ui/
    components/
    context/
    hooks/
    layout/
    models/
    pages/
    runtime/
    styles/
    types/
  desktop/                     # Electron main + preload，内部包含能力分层
  erpc/                        # Electron typed RPC 工具包，不承载业务
  shared/                      # zod schema / dto / event payload / shared protocol types
    utils/                     # 跨包可复用的非平凡公共函数
  core/                        # 核心业务聚合包
    agent/                     # 原 agent-runtime + agent-tools
    project/
    build/
    hardware/
    document/
    abs/
    abi/
    metadata/

scripts/
```

## 现有目录到未来包的映射建议

- `src/app/tools/aily-chat/tools/*`
  - 目标: `packages/core/agent`
- `src/app/tools/aily-chat/services/*` 中纯 AI/runtime 逻辑
  - 目标: `packages/core/agent`
- `src/app/editors/blockly-editor/services/*` 中纯语义/转换逻辑
  - 目标: `packages/core/document` / `packages/core/abs` / `packages/core/abi` / `packages/core/metadata`
- `src/app/services/*` 中项目/依赖/构建语义
  - 目标: `packages/core/project` / `packages/core/build` / `packages/core/hardware`
- `src/app/services/*` 中 Electron 能力适配
  - 目标: `packages/desktop`
- `electron/*`
  - 目标: `packages/desktop`
- `child/scripts/*`
  - 目标: `packages/core/build` / `packages/core/agent` / `packages/desktop`
- `src/app/components/*` 和 `src/app/main-window/*`
  - 目标: `packages/ui`；其中公共原子组件统一沉淀到 `packages/ui/components`

## 推荐的职责拆法

### `packages/core`

这是核心业务聚合包，内部按子域拆目录：

```text
packages/core/
  agent/
  project/
  build/
  hardware/
  document/
  abs/
  abi/
  metadata/
```

分别承载：

- `agent/`: 会话、tool loop、planner、tool 实现
- `project/`: 项目模型、依赖模型、开发板切换语义
- `build/`: 预编译、编译、日志抽取、工具链解析
- `hardware/`: board/library/tool index 查询
- `document/ abs/ abi/ metadata/`: Blockly 文档模型、ABS/ABI 转换、块元信息

### `packages/shared`

负责：

- zod schema
- dto
- event payload
- 共享协议类型
- rpc 输入输出模型

### `packages/shared/utils`

负责：

- 跨包可复用的非平凡公共函数
- 不适合继续散落在 `src/app/utils`、`services`、`tools` 内部的纯函数
- 与具体 UI、Electron、Angular 生命周期无关的工具方法

### `packages/desktop`

负责：

- Electron main / preload
- 桌面壳
- capability 接口与实现分层

### `packages/erpc`

负责：

- Electron 场景下的 typed RPC 工具支持
- main / renderer 两侧的 transport 与适配层
- 与具体业务无关的 bridge 能力

不负责：

- AI 业务编排
- 项目业务逻辑
- Blockly 业务语义

## 关键架构边界

### 边界 1: Blockly DOM 运行时仍属于 `packages/ui`

不合理的做法：

- 把所有 Blockly 操作都理解成“后端逻辑”，试图全部搬到 `packages/core/agent`

正确做法：

- `packages/core/agent` 负责发出结构化 workspace command
- `packages/ui` 作为 `WorkspaceCapabilityExecutor` 执行这些命令
- `packages/core` 负责共享语义模型和转换规则

### 边界 2: Electron 特权能力属于 `packages/desktop`

不再允许：

- `packages/ui` 业务代码直接到处碰 `window['fs']`
- AI 工具直接依赖 `ipcRenderer`

正确做法：

- `packages/desktop` 提供 typed capability bridge
- `packages/ui` 和 `packages/core/agent` 只依赖 capability 接口

## monorepo 改造流程

### 阶段 2.1: 建 workspace 骨架

动作：

1. 新增 `pnpm-workspace.yaml`
2. 根级 `package.json` 改为 workspace scripts
3. 新增 `turbo.json`
4. 新增 `tsconfig.base.json`

验收：

- 仓库能以 workspace 方式安装依赖
- `packages/*` 能被 turbo 识别

### 阶段 2.2: 先抽基础共享包

- `shared`
- `shared/utils`

### 阶段 2.3: 抽聚合业务包

- `blockly`

原则：

- 先迁纯逻辑和纯模型
- 不先迁 UI 依赖

### 阶段 2.4: 建 app 边界

- `packages/ui` 承接原 Angular 应用
- `packages/desktop` 承接原 `electron/`
- `packages/core` 承接新的 AI runtime、工具和领域核心
- `packages/erpc` 提供 typed RPC 工具能力

## 包依赖方向规则

1. `packages/ui`、`packages/desktop` 可以依赖其他 `packages/*`
2. `packages/core` 不能反向依赖 `packages/ui`
3. `packages/core/agent` 可以依赖 `shared` / `shared/utils` / `erpc`
4. `packages/desktop` 可以包含 capability 实现，但前端和 blockly agent 不能直接越过 `erpc` 依赖 Electron 细节
5. `packages/ui` 可以依赖 `shared` / `shared/utils` / `erpc` / `blockly`
6. `packages/ui/components` 不能依赖具体后端运行时实现

## 第一批实际迁移清单

- `buildProjectTool` 的输入输出 shared schema
- `getContextTool` 的输出 schema
- `searchBoardsLibrariesTool` 的 schema
- `extractCompileErrors` 进入 `packages/core/build`
- `blockAnalyzer` 进入 `packages/core/metadata`
- `AilyHost` 的能力类型进入 `packages/desktop`
