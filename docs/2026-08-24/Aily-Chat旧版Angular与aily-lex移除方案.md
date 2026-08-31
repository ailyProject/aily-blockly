# Aily Chat 旧版 Angular 与 `aily-lex` 移除实施记录

日期：2026-08-24

状态：已实施；M2、M3 暂停服务，等待新版 AI 重新设计

主软件：`/Users/downey/Projects/OutSource/aily--blockly`

新版 Aily Chat：`/Users/downey/Projects/aily-lex-pro/packages/aily-chat`

新版 Agent：`/Users/downey/Projects/aily-lex-pro/packages/aily-agent`

## 1. 实施结论

旧 Angular Aily Chat 和 `aily-lex` 兼容执行宿主已经从主软件移除。主软件只保留新版 React Aily Chat 子应用入口，不再提供旧 UI、旧会话运行时或旧 Electron execution host 回退。

本次采用以下边界：

- 主软件能力留在主软件：Blockly 编辑、ABS/ABI、自动同步、构建、库搜索、连接图、文件 Diff、性能追踪、账号状态和生命周期判断。
- 新版 Aily Chat 保持独立：只负责聊天 UI、会话和交互，不接收旧 Angular Chat 的产品域实现。
- 新版 Agent 是后续 AI 能力的运行层；主软件不得为了后台任务依赖 Aily Chat UI 或 Chat Server。
- M2 Project Scene Proposal 和 M3 Scene Code Reconciliation 的旧执行链直接移除，本次不重构、不做兼容转发。
- 根目录 `e2e/` 保留；其他源码目录中的 `*.spec.ts`、`*.spec.js`、`*.spec.mjs`、`*.spec.json` 等单元测试按当前策略删除，后续随新架构重建。

## 2. 最终所有权分组

### A 组：主软件直接拥有，已从旧 Chat 目录迁出

| 模块 | 能力 | 当前实现位置 | 结论 |
| --- | --- | --- | --- |
| M4 | Blockly 创建、删除、连接、字段修改等宿主操作 | `src/app/integrations/blockly/blockly-host-operations.ts` | 主软件实现 |
| M4 | 板卡/库搜索、项目构建 | `src/app/integrations/blockly/board-library-search.ts`、`project-build-operation.ts` | 主软件实现 |
| M5 | ABI/ABS 转换、解析、定义与自动同步 | `src/app/integrations/blockly/abs/` | 主软件实现 |
| M6 | 编辑事件、工具结果、AI Diff 摘要 | `src/app/integrations/blockly/`、`src/app/services/integrations/automation/coder-diff/ai-edit-summary.types.ts` | 主软件通用类型 |
| M6 | 性能追踪 | `src/app/services/core/platform/observability/performance-tracer.ts` | Builder 直接使用 |
| M9 | 活跃 AI/子应用操作登记 | `src/app/services/integrations/automation/ai-operation-registry.service.ts` | 不再读取旧 Chat runtime inventory |
| M10 | 连接图/Schematic 宿主操作 | `src/app/integrations/schematic/connection-graph-operations.ts` | 主软件实现 |
| M11-H | 账号与额度的 token-free 信息 | `src/app/services/core/auth/models/auth-quota-info.ts` 及现有 AuthService | 真实凭证仍由宿主持有 |

这些实现不依赖新版 Aily Chat，也不允许反向 import `src/app/tools/aily-chat`。

### B 组：新版 AI 后续重构，本次主动下线

| 模块 | 旧职责 | 本次处理 | 后续需要迁移/重构的内容 |
| --- | --- | --- | --- |
| M2 | Project Scene hardware intent、提案生成、取消、候选提交 | 删除 Angular provider、Electron scene broker 和旧 runtime 调用 | 在新版 Agent 中重新定义 Scene Agent、输入 DTO、取消、deadline、结构化 proposal；主软件继续负责校验、预览、应用和持久化 |
| M3 | Simulator Scene Code Reconciliation、候选协调、构建回调 | 删除 reconciliation provider/service/ports、rebuild coordinator、renderer IPC bridge | 在新版 Agent 中重新定义 reconciliation task；主软件继续负责项目身份校验、候选接收、构建、revision 校验和落库 |

M2/M3 当前不会回退到旧 Aily Chat，也不会经由新版 Aily Chat 间接执行。相关 Simulator 主体仍保留；没有新适配器时会明确表现为对应 Agent/broker 不可用。

### C 组：新版 Aily Chat/Agent 已有或应独立拥有，旧实现直接删除

| 模块 | 处理结论 |
| --- | --- |
| M7 会话、消息、流式输出 | 使用新版 Aily Chat/Agent 当前会话与事件模型，旧 Angular session/turn/stream 全删 |
| M8 旧会话数据与兼容读取 | 不进入新版常驻运行链；本次不迁旧 session index/snapshot |
| M11-C 模型、权限、Chat 设置 | 使用新版实现，只消费宿主提供的 token-free 状态 |
| M12-C 图片、附件、审批、问题、计划等 Chat UI | 使用新版实现，旧 Angular projection/media/interaction 代码全删 |
| M13 旧 Prompt、Tool、Agent 定义 | 不复制；未来只按新版产品需求在 `packages/aily-agent` 重建必要定义 |

### D 组：通用后台 AI 能力的后续决策

旧 M1 实际上是为 Angular/`aily-lex` 提供后台 scoped session 的运行器。旧实现已经随 runtime host 删除，不迁到 Aily Chat。

如果主软件未来仍需要无 UI 的后台 AI 任务，应在 `packages/aily-agent` 或独立 Node host adapter 中新增 headless task runner，至少具备：

- request ID、取消、超时和单次结构化结果；
- 项目路径、权限和宿主工具的窄协议；
- 与 Chat UI、Aily Chat Server、窗口生命周期相互独立；
- 由主软件的通用 operation registry 记录活动状态。

当前连线图的“生成”入口不再启动旧后台进程，只把 `@SchematicAgent` 提示词转交给新版 Aily Chat；这只是显式用户会话入口，不等同于恢复 M1/M2/M3 后台执行链。

## 3. 已删除内容

### 3.1 Angular 旧版 Aily Chat

整个 `src/app/tools/aily-chat` 已删除，包括：

- 旧组件、Viewer、设置、会话列表、对话框和样式；
- `ChatEngineService`、session/runtime owner、checkpoint、投影和调度服务；
- `lex-*` helpers、旧 Agent bootstrap、工具审批和流式事件桥；
- 旧 Prompt、Tool、Skill、SchematicAgent 定义；
- Tiktoken worker、tokenizer 资产、旧 i18n 和主题变量；
- 原目录内的 Blockly/ABS/ABI/Schematic 工具实现（必要产品能力迁出后删除）。

### 3.2 Electron `aily-lex` 运行链

已删除：

- `electron/chat-runtime-*` host、session store、controller、worker、dispatcher 和 runtime bundle；
- external edit capture、旧 E2E image execution runtime；
- Project Scene generation broker 和 Simulator project rebuild coordinator；
- preload 中旧 chat runtime API、M3 rebuild request/response API 及对应类型；
- `build-electron-worker.js`、`run-electron-lex-execution-host.js`、`clean_lex_cache.sh`；
- Electron build metadata 中的 `ailyChatExecutionHost*` 配置。

### 3.3 npm、构建和资产

已从 `package.json` 和 `package-lock.json` 删除：

- `aily-lex`；
- `js-tiktoken`；
- 旧 Tiktoken Angular asset 配置。

同时执行 `npm prune --ignore-scripts`，清除了本地 `node_modules` 中的 extraneous 安装残留。

### 3.4 单元测试

根 `e2e/` 之外的仓库源码单元测试已删除。扫描到的唯一额外 `*.spec.js` 位于 `electron/node_modules/json-schema-traverse`，属于第三方依赖，不纳入源码清理。

## 4. 当前运行关系

```text
Angular / Electron 主软件
├── Blockly / ABS / ABI / Build / Search / Sync
├── Schematic 与 Simulator 产品主体
├── token-free Auth Snapshot
├── AI Operation Registry
└── ChildToolHost
      └── @aily-project/subapp-aily-chat（React）
            └── @aily-project/aily-agent

已断开：
主软件 -X-> Angular Aily Chat -X-> Electron chat-runtime-host -X-> aily-lex
Simulator -X-> 旧 M2 Scene Broker
Simulator -X-> 旧 M3 Reconciliation/Rebuild Coordinator
```

新版 Aily Chat 仍通过受控宿主接口使用主软件能力，但不直接 import Angular 产品代码；真实认证凭证不传入 React。

## 5. 防回归守卫

`scripts/guard-aily-chat-mainline.js` 会阻止以下内容重新出现：

- `src/app/tools/aily-chat` 目录；
- `aily-lex`、`js-tiktoken` 依赖；
- `electron/chat-runtime-host.js` 和旧 lex runtime 文件；
- 旧 Angular Aily Chat 组件、provider、协议或 Shell 入口。

允许保留的 `aily-chat` 字样仅用于新版子应用工具 ID、受控 auth bridge、文档和守卫目标。

## 6. 验证结果

本次已通过：

```bash
npm run guard:aily-chat-mainline
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development
node --check electron/window.js
node --check electron/preload.js
node --check electron/main.js
node --check scripts/build-electron.js
node --check scripts/guard-aily-chat-mainline.js
git diff --check
```

结果：

- Aily Chat 主链守卫通过；
- Angular TypeScript 检查通过；
- Angular development build 通过；
- 修改过的 Electron/构建 JavaScript 语法检查通过；
- Git whitespace 检查通过；
- package/lockfile 不再声明 `aily-lex` 或 `js-tiktoken`，本地安装残留已清除；
- 源码目录中不存在旧 `tools/aily-chat`、`chat-runtime-*` 或 `aily-lex` 文件。

## 7. 尚未执行的真实验收

本次没有启动或重启用户现有开发服务，也没有完成以下运行态验收：

- Electron 主窗口和独立 Aily Chat 窗口的首次安装、登录、首轮对话、停止和关闭；
- Blockly 真实编辑、ABS/ABI 导入导出、自动同步、库搜索和实际编译；
- Schematic/连接图宿主工具真实调用；
- macOS/Windows 打包产物扫描与安装升级；
- Simulator 正常非 AI 功能回归。

M2/M3 的 Agent 流程不在本次验收范围，因为旧链已经移除且新版尚未实现；验收时应确认入口明确不可用，不应期待生成、协调或构建成功。

## 8. 后续迁移清单

只有以下内容需要后续重新实现，不应从旧代码恢复：

1. M2：新版 Project Scene Agent、结构化 proposal、取消与宿主校验协议。
2. M3：新版 Scene Code Reconciliation task、候选与 revision 协议、构建和落库编排。
3. 可选 M1：仅在确有无 UI 后台任务需求时实现独立 headless runner。
4. M13：按新版 Agent 的实际产品缺口补 Agent/Prompt/Tool/Skill，不做旧定义批量搬运。
5. 为迁出的主软件能力重建新架构下的测试；根 Playwright E2E 继续作为跨进程验收入口。

不需要迁移：旧 Angular UI、旧会话模型、旧事件投影、旧 `aily-lex` adapter/runtime、旧 tiktoken 资产、旧认证/额度兼容层及重复的 Chat 交互实现。
