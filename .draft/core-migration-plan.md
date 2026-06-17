# Core 迁移计划

## 目标

把旧仓库中应当属于后端/核心领域的逻辑逐步迁移到 `packages/core/*`，优先迁纯逻辑、纯模型、纯转换，避免让 Angular 组件、Electron API 或 Blockly 实例继续承载核心业务语义。

## 已完成

- `core/agent`
  - AI SDK runtime、prompt、session、tool registry、事件协议
- `core/hardware`
  - 开发板/库索引模型、结构化搜索、分类统计
- `core/project`
  - package.json 语义、依赖聚合、最近项目规则、宏定义更新
- `core/metadata`
  - block type 收集、used-library manifest 规范化与生成
- `core/document`
  - Blockly 项目文档模型
  - 单页 / 多页 ABI 归一化
  - workspace payload 组合与 shared model 抽离
- `core/abi`
  - project.abi 载荷归一化
  - 文本 parse/stringify
  - 块数量统计

## 当前迁移顺序

1. `core/abs`
   - ABS 相关的纯数据模型和转换
2. `core/build`
   - 编译输入、依赖检查、错误抽取、构建产物判定
3. `core/project`
   - 继续吸收 project lifecycle 的纯逻辑部分
4. `core/metadata`
   - 继续吸收 block definition / block analyzer 侧纯逻辑

## 迁移准则

- 只先迁纯逻辑、纯模型、纯函数。
- 宿主相关逻辑继续留在 UI / desktop，直到 core 有稳定接口可接。
- 新增 core 域时必须提供：
  - `types.ts`
  - `index.ts`
  - 字段级 JSDoc
  - `export * from './x'` barrel
  - `pnpm exec rslib build` 验证

## 当前 focus

当前 focus 是把旧 ABS / ABI 双向转换链中宿主无关的类型与工具函数迁到 `core/abs`。
