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
  - 已新增 agent config 纯逻辑层
  - 包含默认值、旧版迁移、tool/security/model/api-key 选择与更新规则
  - 已新增可直接输出 UI message stream 的 run-stream helper
- `core/hardware`
  - 开发板/库索引模型、结构化搜索、分类统计
  - 已新增 legacy board/library 模糊校验与关键词提取
- `core/project`
  - package.json 语义、依赖聚合、最近项目规则、宏定义更新
  - 已新增语言文件名归一化
  - 已新增开发板使用次数记录/查询/排序规则
  - 已新增资源源运行时环境变量载荷生成
  - 已新增 `appdata_path + platform` 解析 helper
  - 已新增 `projectRootPath / projectPath` 解析与比较 helper
  - 已新增 app config 只读 selector（语言、toolbar、skip versions、quick send、serial monitor、ai mode）
  - 已新增 app config mutation / model-selection 纯逻辑
  - 已新增 app store 布局归一化与可见性判定规则
  - 已补 selectedLanguage 写回逻辑
  - 已补默认布局创建与可见顺序合并规则
  - 已补 layout set/add/remove/toggle/reset 状态转换规则
  - 已新增串口监视器配置规范化、默认模式与连接参数构造
  - 已新增 theme / devmode 纯规则
  - 已补 `toggleThemeMode` / `setDevmodeConfig`
  - 已补 Monaco / Mermaid / Blockly 主题映射与 `devmode.enabled` selector
  - 已新增 recent model projects 与 onboarding 状态规则
  - 已补普通 recent projects 读写规则到 app 路由
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
- `core/rpc`
  - 已建立 `hono + trpc` 独立服务骨架
  - 已暴露 health / document / abi / build / project 纯逻辑 RPC 面
  - 已补 standalone 入口，供 desktop 后续通过 `utilityProcess.fork` 启动
  - 已新增 hardware / agent / app 路由
  - 已把硬件模糊校验、分类、兼容搜索与 agent 配置归一化/只读规则挂到 typed router
  - 已新增 app 路由，暴露应用配置摘要 `get` selector
  - `app.get` 已补 `appDataPathTemplate / appDataPath`
  - `project` 路由已补 `resolveProjectPath / resolveProjectRootPath / getDefaultProjectRootPath / isSameProjectPath`
  - `app.get` 已补 `monacoTheme / mermaidTheme / blocklyThemeId / devmodeEnabled`
  - 已新增 app 的 `resolveModel` / `previewUpdate` / `resolveLayout` 路由
  - app 路由已覆盖 selector / resolve / update preview 三类能力
  - app update preview 已覆盖 selectedLanguage / serialMonitor 等写回场景
  - app 已新增 `setTheme` / `setLanguage` / `setDevmodeAutoSave` / `skipVersion` / `clearSkippedVersions` / `setToolbarApps` / `setQuickSends` / `setSerialMonitor`
  - app 已新增 `toggleTheme` / `setDevmode`
  - app 已新增 `setModel`
  - RPC 命名与组织方式已开始对齐 polywise（`p` / `r` / `router` / `Router`）
  - app 已新增 `createDefaultLayout` 与 `mergeVisibleOrder` 能力
  - `core/rpc/app/*` 已按子域拆分，不再维持单个大路由文件
  - `core/rpc/app/*` 已开始按“单动作单文件”方式拆分
  - app layout 已新增 `setLayout` / `addApp` / `removeApp` / `toggleApp` / `reset`
  - app 已新增 `buildSerialConnectOptions`，`app.get` 也开始返回串口默认模式
  - app.get / app.previewUpdate 已新增 theme / devmode 相关结果
  - app 已新增 recent model project / onboarding 读写能力
  - app 已新增 recent project 读写能力
  - app 已新增 recent project / recent model project 的整表写回动作
  - 这批动作已经足以直接承接 theme / devmode / recent / onboarding 的 legacy 写回路径
  - 已新增 `/api/agent/session` hono API 骨架，预留 AI SDK Angular 通过 API + resumable stream 接入
  - stream resume 语义已对齐为“无活跃流返回 204”，并补了 resumable stream 的恢复/取消 helper
- `ui`
  - 已开始 `src/app -> src` 扁平化，当前入口和路径别名已部分切换
  - 已新增 `core-service` / `desktop-service` 句柄 provider 骨架
  - 已新增 `agent-api` 句柄 provider，明确 AI 通过 `core` 的 hono API 接入
  - 已新增 `agent` 页面，使用 `@ai-sdk/angular` + `agent-api` transport，并预留 resume
  - 首页与 bridge 层命名已统一使用 `core` / `desktop`
  - 启动层已切到 zoneless change detection
  - 首页已开始消费 `core/rpc` 的 `hardware` / `agent` 路由结果
  - 首页已开始消费 `core/rpc` 下的 `app` 路由结果
  - 首页已开始消费 app 的 `resolveModel` 结果
  - 首页已开始消费 app 的 `resolveLayout` 结果
  - 首页已开始消费 app 的 `previewUpdate` 结果
  - 首页已开始消费 `previewUpdate` 的 selectedLanguage / serialMonitor 结果
  - `ui -> core` 保持直连 `core/rpc`；`ui -> desktop` 仅承接 desktop 自身 erpc 能力
  - 首页已开始消费 `createDefaultLayout` 与 `mergeVisibleOrder` 结果
  - 首页已开始消费 `toggleApp` 与 `reset` 结果
  - 首页已开始消费串口默认模式与连接参数结果
  - 首页已开始消费 theme / devmode 结果
  - 首页已开始消费 recent model project / onboarding 结果
  - 首页已开始消费 recent project 结果
- `shared`
  - 已建立成可编译 workspace 包骨架
  - 已新增 core service 地址、健康检查、启动选项等共享协议类型与常量
  - 已新增 agent config 公共类型与默认值
  - 已新增 project 公共类型与 app-config 公共模型/默认值
  - 已新增 app-store 公共类型
  - 已新增 model-project 与 onboarding 公共类型
  - 已新增 AI API 请求载荷公共类型
- `desktop`
  - 已新增 core service manager 薄壳骨架
  - 已通过 `utilityProcess.fork` 约定好 core standalone 进程启动边界
  - 已新增 desktop main `trpc + erpc` 根路由与 preload 暴露入口
  - RPC 命名与组织方式已开始对齐 polywise（`p` / `router` / `routers` / `Router`）
  - desktop 不再代理 core 规则 RPC，仅保留 desktop 自身 erpc 能力
  - desktop 对 core 进程控制能力通过 `desktop.core.*` 分组暴露
- 规范收口
  - 已补齐当前 `types.ts` 的类型级 / 字段级 / 联合值级 JSDoc
  - 已清理剩余不符合要求的非 default barrel 导出

## 当前迁移顺序

1. 继续把旧 service / tool / component 里的纯后端逻辑迁入 `core/*`
   - `abs`
   - `build`
   - `project`
   - `metadata`
   - `document`
   - `agent config`
2. 继续把共用类型 / 常量迁入 `packages/shared`
3. 把 `core/rpc + core/api` 与 `desktop/core-service manager` 接到真实业务入口
4. 完成 `packages/ui/src/app -> packages/ui/src` 扁平化，并把 typed handle / erpc handle 接到真实页面
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
2. 把刚建立的 `core/rpc + core/api + shared + desktop manager` 骨架继续接上真实启动链路与 UI typed handle / ERPC handle

## 最新进展（2026-06-18）

- 已完成的本轮规范收口
  - `ui/pages/home/home-page.types.ts` 已改为 `ui/pages/home/types.ts`
  - `core-service` / `desktop-service` 的公开类型已回收到 `types.ts`
  - `core/agent` 下 `prompts` / `tools` / `session` / `utils` 新增或拆分了多处 `types.ts`
  - `core/agent/session/turns.ts` 与 `serialization.ts` 的类型已拆到 `session/turns/types.ts`、`session/serialization/types.ts`
  - `core/agent/types` 已新增 `types.ts` 与 `index.ts`
  - `core/api/types.ts`、`desktop/src/rpc/types.ts` 已补上
  - `packages/core/rpc/app/layout.ts` 的语法错误已修复
- 已完成的构建验证
  - `packages/shared` 可单独 `rslib build`
  - `packages/erpc` 可单独 `rslib build`
  - `packages/desktop` 可单独 `rslib build`
  - `packages/core` 已可单独 `rslib build`
  - `packages/ui` 已可单独 `ng build`
  - 当前 `ui` build 仍有两个已知 warning：
    - 初始包体积超预算
    - `@vercel/oidc` CommonJS 依赖警告
- 已完成的 domain 级 RPC 形状调整
  - `ui` 首页聚合调用已不再使用 `core.app.*`
  - `core/rpc` 根路由已新增并挂载：
    - `core.config.*`
    - `core.store.*`
    - `core.onboarding.*`
    - `core.project.*`
  - `core.project.*` 现已收缩为更接近项目域的动作：
    - 项目路径
    - 区域解析
    - 最近项目列表
    - 最近模型项目列表
  - `config` / `store` / `onboarding` 已开始形成真实目录模块，而不是只有顶层 router 名
  - 旧 `core/rpc/app/*` 的活跃配置实现已整体迁入 `core/rpc/config/*`
  - `core/rpc/app` 当前已不再承载活跃实现文件
- 当前主要阻塞
  - 当前不再是构建阻塞，而是结构继续演进的问题：
    - `ui` 为兼容 Angular 编译器对跨包声明解析的限制，当前保留了最小的 `src/types/core-modules.d.ts` shim
    - packaging / release 工具链仍只是初始骨架，尚未补齐 desktop release 配置、trim package 和 release 产物裁剪
    - `ui` 目前已经补了 legacy 风格的路由骨架，但大量功能页仍是迁移占位态，真正的编辑器/工具 UI 还需逐域落地
- 下一个执行切面
  1. 继续检查 `ui` / `desktop` 中是否还有应下沉到 `core` 的纯 domain 逻辑
  2. 对齐 packaging / workflow：desktop packaging skeleton、standalone workflow、trim package 流程
  3. 继续按 legacy / deepwiki 对照补漏

## UI 基线（2026-06-18）

- `packages/ui/src/app.routes.ts` 已对齐 legacy 的大体结构，当前包含：
  - `main/*` 壳层
  - tools 路由骨架
  - windows / editor 路由骨架
- 已新增：
  - `pages/main/*` 作为新的 workspace 壳层
  - `pages/migration/*` 作为迁移中的功能页占位承接
  - `routes/main-routes.ts`
  - `routes/tool-routes.ts`
  - `routes/window-routes.ts`
- 当前真实接入的页面仍主要是：
  - `main/guide` -> 现有 home diagnostics 页
  - `aily-chat` -> 现有 agent 页
  - `settings` -> 已接入真实 settings 页面
  - `serial-monitor` -> 已接入真实 serial monitor 页面
  - `main/project-new` -> 已接入真实 project new 页面
  - `main/blockly-editor` -> 已接入真实 blockly editor shell 页面
  - `main/code-editor` -> 已接入真实 code editor shell 页面
  - `main/playground` -> 已接入真实 playground 页面
  - `about` -> 已接入真实 about 页面
  - `project-new` window route -> 已复用真实 project new 页面
- 其余 legacy 页面当前先通过占位壳承接，等待逐域替换
- 新增的真实 UI 页面
  - `pages/about/*`
  - `pages/playground/*`
  - `pages/project-new/*`
  - `pages/blockly-editor/*`
  - `pages/code-editor/*`
  - `pages/settings/*`
  - `pages/serial-monitor/*`
- 路由优化
  - 新接入的真实页面已改成 `loadComponent` 懒加载
  - `ng build` 后初始包体已从约 `970 kB` 降到约 `846 kB`

## Workflow 基线（2026-06-18）

- root `package.json` 已补 `packageManager: pnpm@11.7.0`
- `.github/tsflows/desktop.ts` 已改为从 root `packageManager` 读取 pnpm 版本，并补 `Setup Bun`
- 已新增 `.github/tsflows/standalone.ts`
- 已重新生成：
  - `.github/workflows/desktop.generated.yml`
  - `.github/workflows/standalone.generated.yml`
