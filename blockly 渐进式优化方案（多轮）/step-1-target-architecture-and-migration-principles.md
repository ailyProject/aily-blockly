# Step 1: 目标架构与迁移原则

## 本轮目标

先把“以后要长成什么样”定清楚，再做任何技术迁移。

这一轮不追求功能变化，追求三件事：

1. 定义长期目标架构
2. 定义迁移边界和分层职责
3. 定义未来所有改造必须遵守的工程约束

## 当前主要架构问题

### 1. 前端包承担了过多后端职责

当前前端不仅负责 UI，还直接承担了：

- AI 会话编排
- Prompt 和工具拼装
- MCP 初始化和聚合
- 文件系统直接读写
- npm 执行策略
- Blockly/ABS 编辑编排
- 编译流程调度

### 2. 系统能力与业务语义混在一起

大量代码直接依赖：

- `window['fs']`
- `window['path']`
- `window['npm']`
- `ipcRenderer`
- `AilyHost.get().xxx`

### 3. 单仓目录分组不是边界分组

目前更多是目录分组，不是 package 边界分组，导致依赖方向和职责边界模糊。

### 4. 容易误把所有复杂逻辑都“后端化”

有一类逻辑不能被粗暴搬到后端：

- 真实 Blockly workspace 变更
- DOM 相关编辑器状态
- 依赖浏览器事件和渲染上下文的操作

## 目标架构

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
  desktop/
  erpc/
  shared/
    utils/
  core/
    agent/
    project/
    build/
    hardware/
    document/
    abs/
    abi/
    metadata/

scripts/
```

## 路径兼容约束

这次重构不以“修改运行时目录结构”为目标。

明确约束：

- 不主动修改现有 app data 路径
- 不主动修改现有 toolchain / SDK / board 资源路径
- 不主动修改现有配置文件路径
- 不要求用户迁移本地已有目录

目标是让当前已经能运行的项目和本地配置，在重构后的代码上仍然能运行。

## 目标分层

### 第一层: `packages/ui`

职责：

- 页面
- 组件
- 用户交互
- 状态展示
- 浏览器侧编辑器执行环境

不应该承担：

- AI 规划
- Prompt 构造
- 工具执行编排
- 真实编译流程决策
- 文件系统策略

### 第二层: 业务与领域

主要收敛到：

- `packages/core`

其中包含：

- 项目语义
- Blockly 文档语义
- ABS/ABI 转换
- 构建和硬件索引
- agent 运行时与工具

### 第三层: Infra

职责：

- `packages/desktop`
- `packages/erpc`
- 本地文件系统
- 子进程
- IPC
- 串口
- 上传器

其中需要特别强调：

- `packages/erpc` 是基础设施工具包
- 它负责 Electron / typed RPC 支撑能力
- 它不承担业务编排、业务状态或业务流程

## 需要保留在 `packages/ui` 的能力

下面这些即使做前后端解耦，也不应该被强行迁走：

- Blockly workspace 真实 mutation
- 编辑器视图状态
- 代码查看器联动高亮
- 需要浏览器环境的 Monaco / Blockly / Mermaid 渲染

正确方式不是“全部后移”，而是：

- 语义模型和编排后移
- 真实 UI/DOM 执行保留在 `packages/ui` capability 层

## 架构守则

1. UI 组件不能直接访问 `window['fs'] / window['npm'] / ipcRenderer`
2. 新增 AI 工具不能直接定义在 Angular component 内
3. 新增 schema 必须统一放在 `packages/shared`
4. 新增跨包公共函数默认优先放在 `packages/shared/utils`
5. 前端公共原子组件默认放在 `packages/ui/components`
6. 新增后端用例不能依赖 Angular 类型
7. 新增 domain 模块不得依赖 Electron
8. 新增 infra 模块不得直接拼接 UI 消息文案
9. 真实 Blockly workspace mutation 不能脱离 `packages/ui` 执行环境
10. 重构阶段不主动调整任何现有运行时路径策略
