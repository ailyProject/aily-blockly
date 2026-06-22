# Step 3: AI Runtime 后移与前后端解耦

## 本轮目标

把 AI 相关的“业务脑子”从前端包搬到 `packages/core/agent`，前端只保留聊天 UI、工具展示和用户确认交互。

## 当前问题定位

当前 AI 链路核心集中在前端：

- `src/app/tools/aily-chat/aily-chat.component.ts`
- `src/app/tools/aily-chat/services/chat-engine.service.ts`
- `src/app/tools/aily-chat/helpers/session-lifecycle.helper.ts`
- `src/app/tools/aily-chat/tools/*`

本质问题是：`packages/ui` 既是客户端，又在充当半个 agent runtime。

## 目标形态

建议把 AI runtime 核心收敛到 `packages/core/agent`，并通过 `packages/erpc` 与 `packages/ui`、`packages/desktop` 协作。

### 职责拆分

#### `packages/ui`

负责：

- 聊天窗口
- 输入框
- 工具调用可视化
- 用户确认
- 实时输出渲染
- Blockly / Monaco / Mermaid 等浏览器侧真实执行环境

不再负责：

- Prompt 最终拼装
- Tool loop 驱动
- MCP 聚合和调度
- AI 工作流编排

#### `packages/core/agent`

负责：

- 会话生命周期
- 模型调用
- tool routing
- prompt pipeline
- memory / context budgeting
- planner / executor / subagent orchestration
- AI 工具实现

建议内部结构：

```text
packages/core/agent/
  runtime/
  tools/
  prompts/
  orchestration/
  session/
  tool-loop/
  context/
  planner/
  executor/
  subagent/
  approval/
  adapters/
```

#### `packages/desktop`

负责：

- Electron main / preload
- 文件系统、串口、命令、锁、通知、上传、系统能力
- 向 `packages/core/agent` 与 `packages/ui` 暴露受控 capability

#### `packages/ui` 内的 workspace executor

这不是独立包，但职责必须明确存在：

- 执行来自 `packages/core/agent` 的结构化 Blockly workspace command
- 读取当前工作区概览
- 执行 ABS import/export
- 返回执行结果和视图相关元数据

## 配套要求

- `packages/core/agent` 负责“怎么组织会话、工具、子代理、审批、上下文”
- `packages/ui` 只负责交互与渲染
- `packages/desktop` 负责特权能力
- `packages/erpc` 只负责 transport / adapter，不负责业务

## 工具分类重构

### A. 纯运行时工具

- 搜索板卡和库
- 解析依赖
- 提取编译错误
- 远程搜索
- Prompt/context 处理

这些应完全在 `packages/core/agent` 内部完成。

### B. 本地特权工具

- 读写本地文件
- npm install/uninstall
- 调用编译
- 调用上传
- 访问串口

这些不能让模型直接碰 Electron，全都要通过受控 capability adapter。

### C. UI 协作工具

- ask_user
- ask_approval
- 展示代码 diff
- 展示工具执行状态

这些仍然需要 `packages/ui` 参与，但应由 `packages/core/agent` 发出结构化请求。

## 关键迁移动作

1. 把 prompt pipeline 从前端移走
2. 把 tool loop 从前端移走
3. 把 MCP 聚合后移
4. 建立 capability adapter

尤其要注意：

- `WorkspaceCapability` 是 `packages/ui` local capability
- `File/Command/Build/Upload/Serial` 更偏 `packages/desktop` capability

## 验收标准

- `packages/ui` 不再负责 tool loop 主调度
- 会话启动和流处理的核心逻辑进入 `packages/core/agent`
- 工具按 capability 接口访问本地能力
- 新增模型/工具不需要修改 Angular 大组件
