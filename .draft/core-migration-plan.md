# Core 迁移计划

## 目标

把旧仓库中应当属于后端/核心领域的逻辑逐步迁移到 `packages/core/*`，优先迁纯逻辑、纯模型、纯转换，避免让 Angular 组件、Electron API 或 Blockly 实例继续承载核心业务语义。

在 `core` 域逐步稳定后，继续完成整仓分层迁移：

- `packages/ui`
  - 承接前端界面与交互
  - 扁平化 `src/app -> src`
  - 使用 Tailwind CSS + Spartan 组件体系
  - 参考 `polywise` 的字体基线引入 GoogleSans 和 GeistMono
- `packages/desktop`
  - 保持为很薄的一层
  - Electron main / preload / capability bridge
  - 与前端通过 `erpc` 交互
- `packages/shared`
  - 前后端共用类型、常量、协议载荷
- `core <-> ui`
  - 通过 typed IPC / `trpc` 风格契约交互
- 构建链
  - 对齐 `polywise` 的 turbo / desktop packaging / GitHub tsflow
  - 跑通 `dev` / `build`
  - 补 trim package / release resources 裁剪策略
- 收尾
  - 调用 review
  - 对照 `legacy_deepwiki` 与旧仓库补漏
  - 针对大型单文件做专门诊断
  - 输出根目录重构报告

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
- `core/abs`
  - ABS 输入名规范化
  - 解析结果类型
  - 字符串工具与语法糖规则
- `core/build`
  - 编译错误提取与诊断解析
  - lint 语法检查结果解析
  - 诊断报告与快照恢复
- `ui`
  - 已开始 `src/app -> src` 扁平化，当前入口和路径别名已部分切换
- `shared`
  - 已建立成可编译 workspace 包骨架
- `desktop`
  - 尚未建立成可承载迁移的薄壳包

## 当前迁移顺序

1. 继续把旧 service / tool / component 里的纯后端逻辑迁入 `core/*`
   - `abs`
   - `build`
   - `project`
   - `metadata`
   - `document`
2. 继续把共用类型 / 常量迁入 `packages/shared`
3. 建立 `packages/desktop` 薄壳骨架，并明确与 `core` / `ui` 的边界
4. 完成 `packages/ui/src/app -> packages/ui/src` 扁平化
5. 对齐 `polywise` 的 turbo / packaging / tsflow
6. 完整 review / legacy 对照 / 大文件诊断 / 重构报告

## 迁移准则

- 只先迁纯逻辑、纯模型、纯函数。
- 宿主相关逻辑继续留在 UI / desktop，直到 core 有稳定接口可接。
- 新增 core 域时必须提供：
  - `types.ts`
  - `index.ts`
  - 字段级 JSDoc
  - `export * from './x'` barrel
  - `pnpm exec rslib build` 验证
- 新增 shared / desktop / ui 结构迁移时也应同步满足：
  - 包入口清晰
  - typed contract 明确
  - 不把宿主细节反向污染到 core
  - 构建链可验证

## 当前 focus

当前 focus 是两条线并行推进：

1. 继续把旧 tool / service 中的诊断、配置、文档状态和转换规则往 `core` 下沉
2. 建立 `shared` / `desktop` / `ui` 迁移所需的可运行骨架，避免后续迁移卡在包结构上
