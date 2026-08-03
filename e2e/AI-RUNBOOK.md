---
document_type: ai-executable-runbook
repository_root: aily-blockly
default_shell: PowerShell
test_framework: Playwright Electron
primary_entry: npm run test:e2e
---

# E2E 测试 AI 执行手册

本文供 AI 编码代理和发布执行者选择、运行并汇报 aily-blockly 的 E2E 测试。内容按“要完成的操作”分类，而不是按测试文件分类。

实现原理、全部环境变量和测试代码索引见 [README.md](README.md)。如果本文与代码不一致，以 `package.json`、`playwright.config.ts`、`scripts/run-e2e.mjs` 和实际 spec 为准，并同步修正文档。

## 1. AI 执行约定

执行测试时必须遵守以下规则：

1. 先从第 3 节选择一个操作类型，不得用“跑过一些 E2E”代替明确的测试范围。
2. 所有命令默认在仓库根目录执行。
3. 所有 E2E 入口都会先重新构建并暂存生产渲染层；不得通过环境变量或手工保留产物绕过构建。
4. `test:e2e:fast` 仅为历史兼容入口，执行行为与 `test:e2e` 相同，不再复用旧产物。
5. 必须记录退出码、失败、跳过项和未覆盖项。环境变量未开启而被跳过的测试不算通过。
6. AI 或 CI 无人值守执行批量全流程时，设置 `AILY_E2E_STOP_ON_ERROR=0`，跑完后统一汇总。
7. `AILY_E2E_CLEAR_APPDATA=1` 会删除 aily-project 应用数据中的开发板包、编译器、SDK 和工具安装。仅在任务明确要求“全新环境/冷启动/发布完整验收”时使用。
8. 不得删除真实项目。测试自动创建的项目会自行清理；`AILY_E2E_PROJECT` 必须指向可用于测试的项目。
9. E2E 中断时只按一次 `Ctrl+C` 并等待进程清理。再次按下会强制结束，报告可能不完整。
10. 测试失败时保留 `playwright-report/`、`test-results/` 和相关 checkpoint；先报告根因，不得通过弱化断言来获得通过结果。

## 2. 通用准备

### 2.1 检查工作区和运行时

```powershell
git status --short
node --version
npm --version
```

记录当前 commit、平台、Node 版本和已有未提交文件。不要清理或覆盖与本次任务无关的工作区改动。

全新工作区安装依赖：

```powershell
npm ci --include=dev
npm --prefix electron ci --include=dev --force
```

根依赖提供 Angular、Playwright 和 Electron；`electron/` 依赖供主进程运行。依赖已经完整时不必重复安装。

### 2.2 清除上一个场景遗留的开关

```powershell
Get-ChildItem Env:AILY_E2E_* -ErrorAction SilentlyContinue | Remove-Item
```

不要顺带清除用户显式配置的 `AILY_APPDATA_PATH` 或其他非 E2E 环境变量；如存在，必须在结果中记录，因为它会改变测试使用的数据目录。

### 2.3 命令入口

| 目的 | 命令 | 使用限制 |
|---|---|---|
| 当前代码完整 E2E | `npm run test:e2e` | 会重新构建生产渲染层；正式结论优先使用 |
| 历史兼容入口 | `npm run test:e2e:fast` | 与 `test:e2e` 一样重新构建，不复用旧产物 |
| 指定 spec | `npm run test:e2e -- smoke.spec.ts` | `--` 后参数透传给 Playwright |
| 有界面调试 | `npm run test:e2e:headed -- smoke.spec.ts` | 用于定位，不代替无交互验收 |
| Playwright UI | `npm run test:e2e:ui` | 用于开发测试，不作为最终发布证据 |
| 打开上次报告 | `npm run test:e2e:report` | 不会重新运行测试 |

## 3. 按操作类型选择测试

| 操作类型 | 必须执行 | 条件执行 | 不能由该操作证明 |
|---|---|---|---|
| `OP-UI-CHANGE` 普通 UI/路由改动 | 冒烟 + 受影响页面 spec | 默认 E2E 全集 | 编译工具链、安装包更新 |
| `OP-E2E-INFRA` E2E 基础设施改动 | 默认 E2E 全集 + 受影响的辅助逻辑 spec | 中断/续跑人工验证 | 产品全功能正确 |
| `OP-PROJECT-OPEN` 打开已有项目 | `blockly-editor.spec.ts` | `compile.spec.ts` | 新建项目与所有开发板兼容 |
| `OP-BUILDER` 测试 aily-builder | 辅助逻辑回归 + 指定板两次编译 + 项目广场随机抽样 50% | 全新安装、全开发板、缓存清理 | 真实硬件上传、未实际安装的 builder 版本 |
| `OP-BOARD-PACKAGE` 测试开发板包 | 指定板全流程两次编译 | 清空应用数据后重跑、真实上传 | 其他开发板包 |
| `OP-PROJECT-PLAZA` 测试项目广场 | 项目广场全量加载和编译 | 清空应用数据 | 新建项目第二次增量编译 |
| `OP-RELEASE` 发布软件更新前验收 | 默认 E2E + 冷环境 builder + 全开发板 + 项目广场 | 安装包/升级/签名/上传人工验收 | 任何被跳过或未执行的平台/硬件 |
| `OP-FAILURE-RETRY` 失败定位与续跑 | 原命令续跑 + 报告分析 | 定向 headed/UI 重跑 | 整批从头通过，除非先清断点重跑 |

## 4. `OP-UI-CHANGE`：普通 UI 或路由改动

先运行冒烟测试和受影响页面。首次命令使用非 fast 入口：

```powershell
npm run test:e2e -- smoke.spec.ts <affected.spec.ts>
```

页面与 spec 的映射：

| 改动区域 | spec |
|---|---|
| 启动、主窗口、preload、头部、底部 | `smoke.spec.ts` |
| 指南主页、入口菜单、版本显示 | `guide.spec.ts` |
| 新建项目向导、开发板选择 | `project-new.spec.ts` |
| 串口监视器、终端、底部面板布局 | `tools.spec.ts` |
| AI 聊天离线 UI | `aily-chat.spec.ts` |

受影响 spec 通过后，合并前至少运行一次默认集合：

```powershell
npm run test:e2e
```

通过标准：命令退出码为 `0`，受影响 spec 没有失败；必须单独列出因缺少环境变量而跳过的项目/编译/全流程用例。

## 5. `OP-E2E-INFRA`：修改 E2E 配置、夹具或失败处理

适用文件包括 `playwright.config.ts`、`scripts/run-e2e.mjs`、`e2e/global-setup.ts`、`e2e/fixtures/`、诊断、错误决策和 checkpoint 实现。

运行：

```powershell
npm run test:e2e -- compile-diagnostic.spec.ts electron-app-cleanup.spec.ts error-decision.spec.ts full-flow-mode.spec.ts full-flow-checkpoint.spec.ts project-plaza-selection.spec.ts
npm run test:e2e:fast
```

如果修改了进程清理或中断转发，还要人工执行一次：启动较长用例，只按一次 `Ctrl+C`，确认 Electron 及编译/终端子进程退出且 HTML 报告生成。该人工检查必须在结果中标为 `manual`，不能伪装成自动化通过。

## 6. `OP-PROJECT-OPEN`：打开或编译已有项目

前置条件：项目目录为绝对路径且包含 `project.abi`；编译测试还要求对应开发板包、编译器、SDK 和 `aily-builder` 已经安装。

只验证项目打开和 Blockly 工具箱：

```powershell
$env:AILY_E2E_PROJECT = (Resolve-Path 'D:\path\to\project').Path
npm run test:e2e -- blockly-editor.spec.ts
```

验证一次真实编译：

```powershell
$env:AILY_E2E_PROJECT = (Resolve-Path 'D:\path\to\project').Path
$env:AILY_E2E_COMPILE = '1'
npm run test:e2e -- compile.spec.ts
```

通过标准：编辑器、工作区和工具箱可见；编译场景出现“编译完成”或 Flash/RAM 成功信息，且日志面板有输出。`compile.spec.ts` 只验证一次编译，不能替代 `OP-BUILDER` 的冷/热两轮编译。

## 7. `OP-BUILDER`：测试 aily-builder

### 7.1 必测行为

测试 aily-builder 时，至少验证以下操作：

1. 应用能发现并执行 `aily-builder --version`，工具状态不是“未安装/命令不存在”。
2. 开发板依赖安装完成后，后台预处理或编译流程的同步预处理能正常完成。
3. 清理 `aily-builder/project` 与 `aily-builder/cache` 后，第一次完整编译成功。
4. 不清缓存立即执行第二次编译，增量/缓存路径成功。
5. 编译失败时能提取具体编译器诊断，而不是只显示退出码。
6. 关闭 Electron 后，builder 相关子进程能够清理。
7. 使用可复现的随机种子，从项目广场抽取 50% 项目各编译一次，验证真实项目兼容性。

现有 `full-flow.spec.ts` 对每个新建开发板项目自动清理 builder 的 `project` 和 `cache` 目录，然后连续编译两次，覆盖第 2～4 项。其余辅助行为由定向 spec 和必要的人工检查覆盖。

### 7.2 先跑无外部资源的辅助逻辑回归

```powershell
npm run test:e2e -- compile-diagnostic.spec.ts electron-app-cleanup.spec.ts error-decision.spec.ts full-flow-checkpoint.spec.ts project-plaza-selection.spec.ts
```

### 7.3 指定代表性开发板做冷/热两轮编译

常规兼容性检查，保留已安装依赖：

```powershell
$env:AILY_E2E_MODE = 'specified-boards'
$env:AILY_E2E_BOARD_KEYWORDS = 'uno r4,esp32'
$env:AILY_E2E_STOP_ON_ERROR = '0'
npm run test:e2e -- full-flow.spec.ts
```

如果只测一块板，使用 `AILY_E2E_BOARD_KEYWORD`；多个关键字使用逗号分隔的 `AILY_E2E_BOARD_KEYWORDS`，后者优先。

通过标准：每个关键字都选到目标板，依赖安装成功，新项目进入编辑器，第 1 次和第 2 次编译都成功，命令最终退出码为 `0`。

### 7.4 验证全新安装的 latest aily-builder

此操作会清空 aily-project 应用数据。先确认任务允许，再删除指定板断点并运行：

```powershell
Remove-Item e2e\.artifacts\full-flow-checkpoints\specified-boards.json* -Force -ErrorAction SilentlyContinue
$env:AILY_E2E_MODE = 'specified-boards'
$env:AILY_E2E_BOARD_KEYWORDS = 'uno r4,esp32'
$env:AILY_E2E_CLEAR_APPDATA = '1'
$env:AILY_E2E_ALLOW_TOOL_REFRESH = '1'
$env:AILY_E2E_STOP_ON_ERROR = '0'
npm run test:e2e -- full-flow.spec.ts
Remove-Item Env:AILY_E2E_CLEAR_APPDATA -ErrorAction SilentlyContinue
Remove-Item Env:AILY_E2E_ALLOW_TOOL_REFRESH -ErrorAction SilentlyContinue
```

E2E 默认不自动刷新 `aily-builder` 和 `aily-linter`。本场景显式设置 `AILY_E2E_ALLOW_TOOL_REFRESH=1`；应用数据被清空后，测试会先启动一次应用完成初始化，并从当前配置的 npm registry 安装 `@aily-project/aily-builder@latest`。必须从日志或设置页记录实际安装版本。

重要限制：当前 E2E 没有“指定 aily-builder 版本”的环境变量，也没有自动断言期望版本。测试候选版本时，必须先明确候选版本如何进入测试 registry/安装目录，并记录实际版本；否则只能声称“当前已安装版本”或“registry latest”通过，不能声称某个指定版本通过。

### 7.5 从项目广场随机抽取 50%

`OP-BUILDER` 不跑项目广场全量，而是按项目稳定 key 做 50% 随机抽样。抽样数量使用向上取整；例如广场有 9 个项目时抽取 5 个。随机种子必须记录并在断点续跑时复用。

开始新一轮 builder 验证：

```powershell
Remove-Item e2e\.artifacts\full-flow-checkpoints\project-plaza.json* -Force -ErrorAction SilentlyContinue
Get-ChildItem Env:AILY_E2E_* -ErrorAction SilentlyContinue | Remove-Item
$env:AILY_E2E_MODE = 'project-plaza'
$env:AILY_E2E_PROJECT_PLAZA_SAMPLE_RATE = '0.5'
$env:AILY_E2E_PROJECT_PLAZA_SAMPLE_SEED = [guid]::NewGuid().ToString('N')
$env:AILY_E2E_STOP_ON_ERROR = '0'
Write-Host "sample seed: $env:AILY_E2E_PROJECT_PLAZA_SAMPLE_SEED"
npm run test:e2e:fast -- full-flow.spec.ts
```

日志会输出抽样总数、seed 和项目清单。重跑时不得生成新 seed，也不得删除 checkpoint；必须复用首次记录的 `AILY_E2E_PROJECT_PLAZA_SAMPLE_SEED`。

#### AI 错误归因与自动跳过规则

项目失败后，AI 必须先按证据归入以下三类：

| 分类 | 判定证据 | 后续动作 |
|---|---|---|
| `builder` | `aily-builder` 未安装/版本异常；preprocess 或 compile 命令无法启动、崩溃、超时；CLI 参数不兼容；缓存/路径/进程问题；多个无关项目出现相同工具链错误 | 不得跳过，保留 checkpoint，builder 验证失败并修复根因 |
| `project` | 错误仅在单个项目出现，诊断明确指向该项目源码语法/语义、项目声明但缺失的库、损坏的项目配置或项目数据；同时至少有一个已抽样项目使用同一 builder 成功编译 | 记录证据和项目 ID，加入跳过列表，不再编译该项目 |
| `environment-or-unknown` | 网络/registry/磁盘/权限/服务异常，或现有证据不足以区分 builder 与项目 | 不得跳过；修复环境或补充对照测试后再分类 |

硬性规则：只有 `project` 分类可以自动跳过。不能仅凭“只有一个项目失败”就判为项目问题；无法确认时一律按 `environment-or-unknown` 处理。若多个项目出现相同错误，不得逐个标成项目问题绕过 builder 故障。

AI 确认项目自身问题后，在同一终端设置逗号分隔的项目 ID，并用原 seed 续跑：

```powershell
$env:AILY_E2E_PROJECT_PLAZA_SKIP_PROJECT_IDS = '<project-id-1>,<project-id-2>'
npm run test:e2e:fast -- full-flow.spec.ts
```

测试会从 checkpoint 中移除这些项目并记录“根据 AI 已确认的项目自身问题跳过”，不会再次下载或编译它们，然后继续其他失败/未完成项。跳过项目必须写入最终结果的 `skipped_projects`，不能计入 `passed_scopes`。只要剩余 builder 相关项目全部成功，项目自身问题的跳过不阻止 `builder_decision: pass`；它仍然是项目广场内容问题，需要另行反馈。

### 7.6 aily-builder 扩展矩阵

以下场景根据改动范围追加：

| builder 改动 | 追加测试 |
|---|---|
| 安装、升级、npm prefix、PATH、版本探测 | 全新应用数据启动；设置页检查版本；再次启动确认不重复异常安装 |
| preprocess、编译参数、工具链发现 | 指定板全流程；至少覆盖 Arduino/AVR 类与 ESP32 类板卡 |
| 对象缓存、哈希缓存、增量编译 | 每板连续编译两次；缓存清理后再完整编译；项目广场批量编译 |
| 错误输出或退出码 | `compile-diagnostic.spec.ts` + 一个预期失败的测试项目人工确认详情日志 |
| 跨平台路径或 shell 调用 | Windows 与 macOS 分别运行代表性开发板全流程 |
| 进程生命周期 | `electron-app-cleanup.spec.ts` + 中断长编译后确认无残留子进程 |
| upload/烧录 | 连接真实设备人工验收；当前 E2E 不覆盖 |

设置页的“缓存清理”会调用 `aily-builder cache clear --all`、`--unused-7` 或 `--unused-30`。修改缓存命令时至少人工验证一个清理选项、退出码/提示和清理后的再次编译。

## 8. `OP-BOARD-PACKAGE`：测试某个开发板包

```powershell
$env:AILY_E2E_MODE = 'specified-boards'
$env:AILY_E2E_BOARD_KEYWORD = '<board search keyword>'
$env:AILY_E2E_STOP_ON_ERROR = '0'
npm run test:e2e -- full-flow.spec.ts
```

若开发板包变更了依赖、编译器或 SDK 定义，再用 `AILY_E2E_CLEAR_APPDATA=1` 从零安装重跑。通过标准是“选板 → 创建项目 → 安装依赖 → 第一次完整编译 → 第二次编译”全部成功。

如果改动涉及上传参数、串口或探针，必须增加真实硬件验收；现有自动化只覆盖无设备的串口监视器 UI，不覆盖 upload。

## 9. `OP-PROJECT-PLAZA`：测试项目广场

正式全量运行前删除项目广场 checkpoint，避免只运行上次剩余项：

```powershell
Remove-Item e2e\.artifacts\full-flow-checkpoints\project-plaza.json* -Force -ErrorAction SilentlyContinue
Remove-Item Env:AILY_E2E_PROJECT_PLAZA_SAMPLE_RATE -ErrorAction SilentlyContinue
Remove-Item Env:AILY_E2E_PROJECT_PLAZA_SAMPLE_SEED -ErrorAction SilentlyContinue
Remove-Item Env:AILY_E2E_PROJECT_PLAZA_SKIP_PROJECT_IDS -ErrorAction SilentlyContinue
$env:AILY_E2E_MODE = 'project-plaza'
$env:AILY_E2E_STOP_ON_ERROR = '0'
npm run test:e2e -- full-flow.spec.ts
```

默认并发数为 `2`，可用 `AILY_E2E_PROJECT_PLAZA_CONCURRENCY` 调整。每个项目会下载、进入 Blockly 或代码编辑器、等待依赖并编译一次。

通过标准：项目广场至少返回一个项目，每个公开项目都能加载并编译，最终失败汇总为空。该场景保留 aily-builder 自身管理的哈希缓存，且每个项目只编译一次，所以不能代替新建板卡的冷/热两轮测试。

## 10. `OP-RELEASE`：发布软件更新前

### 10.1 发布门禁

按顺序执行，任一步失败都阻止发布：

1. 记录待发布 commit、`package.json` 版本、目标平台和 CN/global flavor。
2. 清除所有 `AILY_E2E_*` 遗留变量。
3. 运行默认生产渲染层 E2E：`npm run test:e2e`。
4. 删除 `specified-boards` checkpoint，在允许清空应用数据的测试机上，以 `AILY_E2E_CLEAR_APPDATA=1` 对 `uno r4,esp32` 或发布负责人指定的代表板运行 builder 全流程。
5. 按第 7.5 节从项目广场随机抽取 50%，完成 builder 兼容性验证；项目自身问题可按规则跳过，builder/环境/未知问题不可跳过。
6. 清除全流程模式变量、抽样变量、项目跳过变量和 `AILY_E2E_CLEAR_APPDATA`。
7. 删除 `all-boards` checkpoint，设置 `AILY_E2E_MODE=all-boards`、`AILY_E2E_STOP_ON_ERROR=0`，运行 `full-flow.spec.ts`。
8. 清除全流程模式变量。
9. 作为项目广场功能的独立发布验收，删除 `project-plaza` checkpoint、清除抽样/跳过变量，再以 100% 全量运行；此阶段任何项目失败都阻止发布。
10. 在每个目标 OS/flavor 构建最终安装包，并完成第 10.2 节验收。

本地构建入口：

| flavor | 命令 |
|---|---|
| Global | `npm run build:global` |
| CN | `npm run build:cn` |

本地包通常没有发布流水线追加的最终签名/公证，只能用于打包结构和安装预检；发布结论必须基于流水线最终产物。

全开发板命令：

```powershell
Remove-Item e2e\.artifacts\full-flow-checkpoints\all-boards.json* -Force -ErrorAction SilentlyContinue
$env:AILY_E2E_MODE = 'all-boards'
$env:AILY_E2E_STOP_ON_ERROR = '0'
npm run test:e2e:fast -- full-flow.spec.ts
```

步骤 3 已经为同一 commit 生成生产渲染层后，后续长流程可以使用 `fast`；如果期间代码或构建配置有变化，重新执行非 fast 构建。

当前 `.github/workflows/main.yml` 在 `deploy`/`beta` 分支上构建、签名并发布，但没有 E2E job。因此“CI/CD workflow 成功”不能代替上述发布前测试，门禁应在触发发布工作流前完成。

### 10.2 最终安装包与升级验收

Playwright 当前直接启动 `electron/main.js` 并加载暂存的生产 `renderer/`，不安装 electron-builder 产物。因此每个发布平台和 flavor 还必须验证：

1. 全新安装：安装、首次启动、主窗口、版本号、builder/linter 初始化、新建项目和代表板编译。
2. 覆盖升级：从上一正式版升级到候选版，确认下载、退出安装、重启、版本变化和用户项目/设置保留。
3. 自动更新元数据：CN/global 使用正确更新地址，manifest 文件名、版本、文件大小和 SHA512 与最终签名产物一致。
4. 平台安全：Windows 签名有效；macOS 签名、公证和 stapling 有效。
5. 资源完整性：内置 Node、7z、probe-rs、rg、preload、原生依赖和 updater 配置都存在且可运行。
6. 离线/失败路径：更新或工具下载失败时给出可理解错误，重试后可恢复。
7. 若本次涉及上传：在至少一块目标真实设备上完成编译和上传。

只有自动 E2E 与目标安装包验收都通过，才能给出 `release_decision: pass`。

## 11. `OP-FAILURE-RETRY`：失败定位与断点续跑

### 11.1 普通用例失败

1. 查看控制台中的首个产品错误，而不是只看 Playwright 最后一行。
2. 打开报告：`npm run test:e2e:report`。
3. 检查 `test-results/` 中保留的 trace、截图和视频。
4. 修复后先定向运行失败 spec；当前构建可信时可使用 fast。
5. 定向通过后，重新运行该操作类型要求的完整集合。

### 11.2 全流程失败

checkpoint 位于 `e2e/.artifacts/full-flow-checkpoints/`：

| 模式 | checkpoint |
|---|---|
| 指定单板/多板 | `specified-boards.json` |
| 所有开发板 | `all-boards.json` |
| 项目广场 | `project-plaza.json` |

直接重跑原命令会从剩余项继续，适合定位和恢复，但只能证明“剩余项本次通过”。正式发布需要删除对应 `.json` 和 `.json.bak` 后从头运行，才能证明整批在同一验收轮次通过。

无人值守批量测试使用：

```powershell
$env:AILY_E2E_STOP_ON_ERROR = '0'
```

这会继续执行其他项，成功项从 checkpoint 移除，失败项保留，最后仍以失败退出。不得因为测试跑完了就忽略最终非零退出码。

## 12. 覆盖边界

当前自动 E2E 能证明：

- Electron 主进程可启动，生产渲染层可加载，主窗口与关键页面可交互；
- 新建项目、已有 Blockly 项目打开、依赖等待和编译 UI 主链路可工作；
- 指定/全部开发板可执行两次真实编译；
- 项目广场项目可批量下载、加载和编译；
- 编译诊断、错误决策、checkpoint 与 Electron 清理逻辑可回归。

当前自动 E2E 不能证明：

- electron-builder 最终安装包能安装或自动升级；
- Windows 签名或 macOS 公证正确；
- CN/global 更新源和线上 manifest 已正确部署；
- 真实串口、USB、probe-rs 或网络 OTA 上传成功；
- 未实际安装并记录版本的 aily-builder 候选版通过；
- 每个平台都通过，除非该平台实际执行过相应测试。

## 13. AI 结果输出格式

完成后按以下结构汇报；字段不得省略，可填写 `none` 或 `not-run`：

```yaml
operation_type: OP-RELEASE
revision: <git commit>
app_version: <package.json version>
platform: <os/arch>
build_flavor: <cn|global|not-applicable>
aily_builder_version: <observed version|unknown>
project_plaza_sample_rate: <0.5|1|not-run>
project_plaza_sample_seed: <seed|not-run>
sampled_projects:
  - id: <project id>
    name: <project name>
commands:
  - command: <exact command>
    exit_code: <number>
    result: <passed|failed|interrupted>
passed_scopes:
  - <scope>
failed_scopes:
  - <scope or none>
skipped_scopes:
  - <scope or none>
skipped_projects:
  - id: <project id>
    name: <project name>
    classification: project
    evidence: <why this is a project issue rather than a builder issue>
manual_checks:
  - name: <check>
    result: <passed|failed|not-run>
artifacts:
  html_report: playwright-report/index.html
  test_results: test-results/
not_covered:
  - <explicit gap>
builder_decision: <pass|blocked|not-applicable>
release_decision: <pass|blocked|not-applicable>
```

判定原则：`OP-BUILDER` 中经证据确认的项目自身问题可以列入 `skipped_projects`，不单独阻止 `builder_decision: pass`，但不能计为测试通过。任一 builder、环境或未知错误仍未解决时，`builder_decision` 必须为 `blocked`。正式发布的 100% 项目广场验收、其他必测命令、实际 aily-builder 版本或目标平台安装包任一缺失时，`release_decision` 必须为 `blocked`，不能写成“基本通过”。
