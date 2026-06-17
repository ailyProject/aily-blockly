# Step 5: 前端壳层重构与 Tailwind CSS v4 接入

## 本轮目标

把 `packages/ui` 从“功能和样式一起堆”的状态，改造成：

- UI shell 清晰
- 样式系统统一
- 新组件开发成本更低
- 不再继续扩散样板 SCSS

这一轮重点解决：

- 未集成 Tailwind CSS v4
- 需要写大量样板样式代码
- 组件职责过重

## 核心判断

Tailwind v4 值得引入，但不应该作为第一步改造。

先有：

- 分层
- shared
- AI runtime 边界

再引入 Tailwind，收益才会稳定。

## 目标形态

### UI 分层

建议 `packages/ui` 内部按下面方式拆分，参考 `polywise/packages/app` 的组织思路：

```text
packages/ui/
  components/
  context/
  hooks/
  layout/
  models/
  pages/
  runtime/
  styles/
  types/
```

### 命名语义

- `components`: 前端公共原子组件和可复用展示组件
- `context`: 全局上下文和状态容器
- `hooks`: 复用交互逻辑
- `layout`: 主布局、工作台、聊天壳、底部面板壳
- `models`: 前端展示模型
- `pages`: 页面入口和路由容器
- `runtime`: 前端运行时适配逻辑
- `styles`: 主题、tokens、全局样式
- `types`: 前端局部类型

## Tailwind v4 接入策略

### 原则 1: 新旧样式并存一段时间

不要尝试一轮里把所有 SCSS 改成 Tailwind。

正确做法：

- 新组件优先 Tailwind
- 旧组件按“有修改再迁”的方式渐进替换
- 全局 token 先统一

### 原则 2: 保留设计 token，不做 class 拼贴工程

接入 Tailwind v4 后，先定义设计 token：

- color
- spacing
- radius
- shadow
- z-index
- animation
- surface semantic tokens

目标不是“所有样式都写成超长 class”，而是建立稳定设计语义。

### 原则 3: 组件级样式规范化

建议配套引入：

- `tailwindcss v4`
- `class-variance-authority` 或等价 variant 模式
- 统一的 `cn()` 拼装函数

即使是 Angular，也应该形成：

- base class
- variant
- size
- intent

的规范，而不是散乱条件类拼接。

## 优先改造的前端区域

### 第一优先级

- 主工作台 shell
- 聊天面板
- 工具栏
- 底部面板
- 通知/状态提示

原因：

- 这些区域被频繁触达
- 视觉和交互一致性最重要
- 后续功能还会继续长在这里

### 第二优先级

- 项目创建页
- 开发板/库选择对话框
- 设置页
- 用户中心

### 第三优先级

- 编辑器内部复杂 UI
- 历史遗留细碎组件

## 与现有 SCSS 的关系

当前项目已经有主题变量和大量组件级 SCSS。

建议做法：

1. 保留现有 theme token
2. 把关键 token 映射到 Tailwind v4
3. 让 Tailwind 接管新组件的布局和视觉
4. 逐步减少巨量组件内联 SCSS

## 组件职责拆分原则

每个组件尽量只承担一类职责：

### Container 组件

负责：

- 数据获取
- 调用 use case
- 处理路由和状态

### Presentational 组件

负责：

- 纯展示
- 事件抛出
- 不直接碰 service

### Adapter 组件

负责：

- 连接旧组件和新组件
- 过渡期协议兼容

## 原子组件归位原则

根据你的要求，公共原子组件不再单独放独立组件包，而是统一放在：

```text
packages/ui/components/
```

建议在 `components` 下再按语义分组：

```text
packages/ui/components/
  atoms/
  forms/
  feedback/
  layout/
  navigation/
  dialogs/
```

第一批可以沉淀：

- Button
- IconButton
- Input
- Select
- Dialog
- Panel
- Badge
- Tabs
- Notice
- Progress

## 迁移步骤

### 阶段 4.1

接入 Tailwind v4，但只做基础设施：

- postcss 配置
- token 映射
- 样式 reset 和基础层
- 约定目录

### 阶段 4.2

在 `packages/ui/components` 创建基础原子组件，不碰业务组件。

### 阶段 4.3

优先重做：

- 主壳 layout
- 聊天壳
- 底部面板壳

### 阶段 4.4

在迭代业务时顺手替换旧样式，不做一次性清理运动。

## 本轮不做

- 不重写所有页面
- 不一次性移除全部 SCSS
- 不强推每个细节都 Tailwind 化
- 不在样式改造阶段同时大改业务逻辑

## 验收标准

- Tailwind v4 已接入
- 有统一 token 策略
- 有第一批 `packages/ui/components` 基础组件
- 新增页面和新组件不再默认写大段 SCSS 模板
- 至少 2 个核心壳层完成新样式体系迁移

## 预期收益

- 样式开发速度明显提升
- 视觉一致性提升
- 巨型组件中的“样式噪音”减少
- 新功能 UI 更容易迭代
