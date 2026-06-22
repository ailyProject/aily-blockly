# aily-blockly 渐进式架构改进方案

这组文档不是一次性重写方案，而是一套可执行的多轮改造计划。

目标是把当前项目从“Electron + Angular + Blockly + AI 能力混合堆叠”的单体桌面工程，逐步演进为：

- monorepo + 分包边界清晰
- 前后端职责明确
- AI 工作流可测试、可替换、可扩展
- 前后端调用有统一协议和类型安全
- UI 层样式体系现代化
- 巨型文件和巨型组件逐步拆解
- 构建链路更快、更稳定、更适合多人协作
- 类型体系集中、边界清晰

## 参考结构

这套方案明确参考 [polywise/packages](https://github.com/MatrixAges/polywise/tree/master/packages) 的组织思路，尤其是：

- 前端主包集中在 `packages/ui`
- 桌面壳集中在 `packages/desktop`
- Electron typed RPC 工具能力集中在 `packages/erpc`
- 共享 schema 与工具函数集中管理

## 最终目标架构

```text
packages/
  ui/                        # 前端主包（Angular UI）
    components/               # 公共原子组件
    context/
    hooks/
    layout/
    models/
    pages/
    runtime/
    styles/
    types/
  desktop/                    # Electron main/preload/桌面壳，内部包含能力分层
  erpc/                       # Electron typed RPC 工具包，不承载业务
  shared/                     # schema / dto / event payload / 共享协议类型
    utils/                    # 跨包可复用的非平凡公共函数
  core/                       # 核心业务聚合包
    agent/                    # 原 agent-runtime + agent-tools
    project/                  # 项目模型、依赖模型、板卡切换语义
    build/                    # 预编译、编译、日志抽取、工具链解析
    hardware/                 # board/library/tool index 查询
    document/                 # Blockly 文档模型
    abs/                      # ABS 语义与转换
    abi/                      # ABI 语义与转换
    metadata/                 # 块元信息、分析、映射

scripts/                      # 根目录构建、发布、迁移、检查脚本
```

## monorepo 基础设施

仓库级基础设施统一使用：

- `pnpm` 负责 workspace 和依赖管理
- `turbo` 负责 monorepo 任务编排和缓存
- `rslib` 负责 Node 运行时、共享包、桌面壳构建

## 路径兼容原则

这次重构方案**不主动修改任何现有路径策略**。

目标是保证：

- 当前已经能运行的项目目录结构继续可运行
- 当前已有的本地配置继续可运行
- 重构后的代码仍能兼容现有路径约定

也就是说，本轮方案里不强推任何新的统一运行时目录，不要求把运行时数据迁移到新位置。

## 关键组织约束

- 前端主包统一放在 `packages/ui`
- 前端公共原子组件统一放在 `packages/ui/components`
- 共享 schema、dto、event payload 统一放在 `packages/shared`
- 跨包复用的非平凡公共函数统一放在 `packages/shared/utils`
- `packages/erpc` 只提供 Electron typed RPC 工具能力，不承载业务
- 原 `agent-runtime` 和 `agent-tools` 统一收敛到 `packages/core/agent`
- 原 `blockly-domain / build-domain / hardware-index / project-domain` 统一收敛到 `packages/core/*`
- `scripts` 不再作为包存在，直接放仓库根目录

## 文档顺序

1. [step-1-target-architecture-and-migration-principles.md](./step-1-target-architecture-and-migration-principles.md)
2. [step-2-monorepo-and-functional-packaging.md](./step-2-monorepo-and-functional-packaging.md)
3. [step-3-ai-runtime-backend-decoupling.md](./step-3-ai-runtime-backend-decoupling.md)
4. [step-4-erpc-shared-and-type-system.md](./step-4-erpc-shared-and-type-system.md)
5. [step-5-frontend-shell-and-tailwind-v4.md](./step-5-frontend-shell-and-tailwind-v4.md)
6. [step-6-codebase-decomposition-and-package-splitting.md](./step-6-codebase-decomposition-and-package-splitting.md)
7. [step-7-pnpm-turbo-rslib-build-and-delivery.md](./step-7-pnpm-turbo-rslib-build-and-delivery.md)
8. [step-8-execution-roadmap-and-acceptance.md](./step-8-execution-roadmap-and-acceptance.md)

## 推荐执行顺序

1. 先定目标架构、边界、包结构和迁移原则
2. 先落 monorepo 骨架和按职责分包，再建 `shared / erpc / 类型基础`
3. 先把 AI 流程从前端包挪走，再重做前端 UI 和样式体系
4. 先拆巨型文件，再加速构建，否则只是更快地打一个更乱的包
5. `pnpm + turbo` 先负责 monorepo 编排，`rslib` 先用于共享包和 Node 运行时
