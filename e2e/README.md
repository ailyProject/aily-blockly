# 端到端测试（E2E）

使用 [Playwright](https://playwright.dev/) 的 `_electron` API 对 aily-blockly 桌面应用做端到端测试。
测试直接启动 `electron/main.js` 主进程，针对 **生产构建产物** 运行。

需要由 AI 按改动/发布类型选择测试、执行并汇报时，使用 [AI 执行手册](AI-RUNBOOK.md)。

## 快速开始：运行命令与场景

所有命令均在项目根目录执行。`npm run test:e2e* -- ...` 中 `--` 后面的参数会原样传给 Playwright。

运行前注意：

- 所有 E2E 测试入口都会先重新执行 Angular 构建并暂存 `renderer/`，不会复用上一次运行留下的渲染产物。`test:e2e:fast` 仅作为历史兼容命令保留。
- 运行中需要停止时只按一次 `Ctrl+C`，等待测试关闭 Electron、编译/终端子进程并生成 HTML 报告；再次按下会强制终止，此时报告可能不完整。
- PowerShell 环境变量会保留在当前终端。全流程场景统一使用 `AILY_E2E_MODE` 选择，切换场景时直接覆盖该变量即可。
- 旧版的 `AILY_E2E_FULLFLOW`、`AILY_E2E_ALL_BOARDS`、`AILY_E2E_PROJECT_PLAZA` 仍兼容单独使用；若同时启用多个，测试会立即报错，不再串到其他场景。
- `AILY_E2E_CLEAR_APPDATA=1` 会删除已安装的开发板包、编译器和 SDK 缓存，仅在确实需要全新环境时使用；它不会删除测试断点，如需从第一项重跑还要执行下方的断点清理命令。

### 常用运行入口

| 运行目标 | 命令 | 说明 |
|----------|------|------|
| 完整回归 | `npm run test:e2e` | 重新构建并暂存生产渲染层后运行测试 |
| 兼容入口 | `npm run test:e2e:fast` | 与完整回归一样重新构建，不再复用旧产物 |
| Playwright UI | `npm run test:e2e:ui` | 以 `--ui` 模式运行 |
| 有界面调试 | `npm run test:e2e:headed` | 以 `--headed` 模式运行 |
| 查看上次报告 | `npm run test:e2e:report` | 打开 Playwright HTML 报告，不运行测试 |
| 只跑某个文件 | `npm run test:e2e -- smoke.spec.ts` | 文件名也可换成下方测试套件中的任意 spec |
| 兼容入口跑某个文件 | `npm run test:e2e:fast -- full-flow.spec.ts` | 同样先重新构建，再运行指定 spec |

常用定向组合：

```powershell
# 只运行无需额外环境变量的应用 UI 回归
npm run test:e2e -- smoke.spec.ts guide.spec.ts project-new.spec.ts tools.spec.ts

# 只运行编译诊断、错误决策与断点逻辑回归
npm run test:e2e:fast -- compile-diagnostic.spec.ts electron-app-cleanup.spec.ts error-decision.spec.ts full-flow-mode.spec.ts full-flow-checkpoint.spec.ts project-plaza-selection.spec.ts
```

### PowerShell：按场景运行

打开已有 Blockly 项目（目录中需包含 `project.abi`）：

```powershell
$env:AILY_E2E_PROJECT = 'D:\path\to\blockly-project'
npm run test:e2e -- blockly-editor.spec.ts
```

编译已有项目（需要已安装对应编译器、SDK 和 `aily-builder`）：

```powershell
$env:AILY_E2E_PROJECT = 'D:\path\to\blockly-project'
$env:AILY_E2E_COMPILE = '1'
npm run test:e2e -- compile.spec.ts
```

以下全流程场景会真实安装依赖、创建项目并调用编译工具链，需要本机具备内置 Node 工具链、`aily-builder` 及相应编译器和 SDK。

指定一个开发板，完成“选板 → 新建项目 → 连续编译两次”：

```powershell
$env:AILY_E2E_MODE = 'specified-boards'
$env:AILY_E2E_BOARD_KEYWORD = 'uno r4' # 可省略，默认 uno r4
npm run test:e2e:fast -- full-flow.spec.ts
```

指定多个开发板逐个执行相同全流程：

```powershell
$env:AILY_E2E_MODE = 'specified-boards'
$env:AILY_E2E_BOARD_KEYWORDS = 'uno r4,esp32'
npm run test:e2e:fast -- full-flow.spec.ts
```

验证所有可创建开发板，每块板连续编译两次：

```powershell
$env:AILY_E2E_MODE = 'all-boards'
npm run test:e2e:fast -- full-flow.spec.ts
```

下载、打开并编译项目广场全部公开项目：

```powershell
$env:AILY_E2E_MODE = 'project-plaza'
npm run test:e2e:fast -- full-flow.spec.ts
```

测试 `aily-builder` 时，从项目广场随机抽取 50%，并记录 seed 以支持断点续跑：

```powershell
Remove-Item e2e\.artifacts\full-flow-checkpoints\project-plaza.json* -Force -ErrorAction SilentlyContinue
$env:AILY_E2E_MODE = 'project-plaza'
$env:AILY_E2E_PROJECT_PLAZA_SAMPLE_RATE = '0.5'
$env:AILY_E2E_PROJECT_PLAZA_SAMPLE_SEED = [guid]::NewGuid().ToString('N')
$env:AILY_E2E_STOP_ON_ERROR = '0'
npm run test:e2e:fast -- full-flow.spec.ts
```

如果 AI 根据编译诊断和对照项目确认失败只由项目自身导致，可在复用同一 seed 的续跑中设置 `AILY_E2E_PROJECT_PLAZA_SKIP_PROJECT_IDS=id1,id2`。测试会从 checkpoint 移除这些项目且不再编译。builder、环境或无法确定归因的错误不得加入跳过列表；完整规则见 [AI 执行手册](AI-RUNBOOK.md#ai-错误归因与自动跳过规则)。

全流程默认在交互终端中将错误正文标红并提示选择。编译失败时会自动读取通知中的“查看详情”日志，优先显示带源码位置的编译器根因；确实没有捕获到具体诊断时才回退到退出码。选择前只输出一次完整错误，编译层和场景层不再重复正文；测试结束时 Playwright 仍会在正式失败报告中保留该错误。输入 `c` 将当前项视为已处理并继续，但该错误仍进入最终汇总并使本次测试失败；输入 `a` 或直接回车会中止并保留断点。如需关闭颜色，PowerShell 设置 `$env:NO_COLOR = '1'`，macOS / Linux 设置 `NO_COLOR=1`。无人值守或希望自动跑完再汇总时，在上述任一全流程命令前增加：

```powershell
$env:AILY_E2E_STOP_ON_ERROR = '0'
```

#### 继续运行、重头开始与完全重置

| 目标 | 操作 |
|------|------|
| 从中止位置继续 | 直接重新执行原来的场景命令 |
| 所有全流程场景从头开始 | 删除整个 `full-flow-checkpoints` 目录 |
| 单个场景从头开始 | 删除下方对应的 checkpoint 文件及其备份 |
| 连依赖环境一起完全重置 | 删除断点，并设置 `AILY_E2E_CLEAR_APPDATA=1` 后重新运行 |

只重置进度、保留已经安装的开发板包、编译器和 SDK：

```powershell
# 所有全流程场景都从第一项开始
Remove-Item e2e\.artifacts\full-flow-checkpoints -Recurse -Force -ErrorAction SilentlyContinue

# 或者只重置其中一个场景（*.json* 会同时删除主文件与 .bak 备份）
Remove-Item e2e\.artifacts\full-flow-checkpoints\specified-boards.json* -Force -ErrorAction SilentlyContinue # 指定单板/多板
Remove-Item e2e\.artifacts\full-flow-checkpoints\all-boards.json* -Force -ErrorAction SilentlyContinue      # 所有开发板
Remove-Item e2e\.artifacts\full-flow-checkpoints\project-plaza.json* -Force -ErrorAction SilentlyContinue  # 项目广场
```

如果还要删除 AppData 中已安装的开发板包、编译器和 SDK，让依赖环境也从零开始：

```powershell
Remove-Item e2e\.artifacts\full-flow-checkpoints -Recurse -Force -ErrorAction SilentlyContinue
$env:AILY_E2E_CLEAR_APPDATA = '1'
# 然后重新执行上方对应的全流程场景命令
```

`AILY_E2E_CLEAR_APPDATA=1` 本身不会删除断点；完全重置时必须同时执行断点删除命令。完成这次全新运行后，可执行 `Remove-Item Env:AILY_E2E_CLEAR_APPDATA -ErrorAction SilentlyContinue`，避免后续运行再次清空 AppData。

### macOS / Linux：按场景运行

npm 命令与 Windows 相同，环境变量可直接写在命令前：

```bash
# 打开或编译已有项目
AILY_E2E_PROJECT='/path/to/blockly-project' npm run test:e2e -- blockly-editor.spec.ts
AILY_E2E_PROJECT='/path/to/blockly-project' AILY_E2E_COMPILE=1 npm run test:e2e -- compile.spec.ts

# 指定单板、多板、所有开发板、项目广场
AILY_E2E_MODE=specified-boards AILY_E2E_BOARD_KEYWORD='uno r4' npm run test:e2e:fast -- full-flow.spec.ts
AILY_E2E_MODE=specified-boards AILY_E2E_BOARD_KEYWORDS='uno r4,esp32' npm run test:e2e:fast -- full-flow.spec.ts
AILY_E2E_MODE=all-boards npm run test:e2e:fast -- full-flow.spec.ts
AILY_E2E_MODE=project-plaza npm run test:e2e:fast -- full-flow.spec.ts

# 项目广场无人值守执行；其他全流程模式同样可添加 STOP_ON_ERROR=0
AILY_E2E_MODE=project-plaza AILY_E2E_STOP_ON_ERROR=0 npm run test:e2e:fast -- full-flow.spec.ts

# 放弃全部全流程断点并从头运行
rm -rf e2e/.artifacts/full-flow-checkpoints
```

需要长期保留变量时也可先执行 `export NAME=value`。切换全流程场景时覆盖 `AILY_E2E_MODE` 即可；其他场景专用配置仍需按需清理。

### 全流程可选配置

| 环境变量 | 默认值 | 作用 |
|----------|--------|------|
| `AILY_E2E_MODE` | 未设置 | 全流程场景：`specified-boards`、`all-boards` 或 `project-plaza` |
| `AILY_E2E_BOARD_KEYWORD` | `uno r4` | 指定单个开发板搜索关键字 |
| `AILY_E2E_BOARD_KEYWORDS` | 未设置 | 逗号分隔的多个关键字；设置后优先于单板关键字 |
| `AILY_E2E_CLEAR_APPDATA` | `0` | 设为 `1` 才会在启动前清空并重建应用数据 |
| `AILY_E2E_ALLOW_TOOL_REFRESH` | `0` | E2E 默认不自动刷新 `aily-builder`/`aily-linter`；设为 `1` 才允许应用版本变化时安装线上 latest |
| `AILY_E2E_STOP_ON_ERROR` | `1` | 交互终端提示继续/中止；设为 `0` 时不提示并在最后汇总 |
| `AILY_E2E_SINGLE_BOARD_TIMEOUT_MS` | `3600000` | 单块开发板全流程超时（60 分钟） |
| `AILY_E2E_INSTALL_TIMEOUT_MS` | `1800000` | 开发板依赖安装超时（30 分钟） |
| `AILY_E2E_COMPILE_TIMEOUT_MS` | `600000` | 单次编译超时（10 分钟） |
| `AILY_E2E_PROJECT_PLAZA_LOAD_TIMEOUT_MS` | `180000` | 单个广场项目下载并进入编辑器的超时（3 分钟） |
| `AILY_E2E_PROJECT_PLAZA_INSTALL_TIMEOUT_MS` | `300000` | 单个广场项目安装依赖的超时（5 分钟） |
| `AILY_E2E_PROJECT_PLAZA_CONCURRENCY` | `2` | 项目广场并发数；交互错误决策模式临时降为 `1` |
| `AILY_E2E_PROJECT_PLAZA_SAMPLE_RATE` | `1` | 项目广场抽样比例，范围 `(0, 1]`；builder 验证设为 `0.5` |
| `AILY_E2E_PROJECT_PLAZA_SAMPLE_SEED` | 未设置 | 抽样比例小于 `1` 时必填；相同 seed 稳定选择同一批项目 |
| `AILY_E2E_PROJECT_PLAZA_SKIP_PROJECT_IDS` | 未设置 | 逗号分隔的项目 ID；仅填写 AI 已确认属于项目自身问题的失败项 |

`AILY_E2E_INTERACTIVE_DECISIONS` 由 [run-e2e.mjs](../scripts/run-e2e.mjs) 自动管理，不需要手动设置。`E2E_SKIP_BUILD` 已停用，即使外部环境残留该变量也不会跳过构建。

## 工作原理

1. 所有测试模式下，`global-setup`（[global-setup.ts](global-setup.ts)）都会先执行 `ng build --base-href ./`，
   再删除并重建项目根目录下的 `renderer/`，其内容来自 `dist/aily-blockly/browser`。历史 `fast` 入口也执行同一流程。
   这正是 `electron-builder` 打包时的映射关系（`browser` → `renderer`）。
2. 启动夹具（[fixtures/electron-app.ts](fixtures/electron-app.ts)）用 `_electron.launch`
   以项目根为 `cwd`、`args: ['.']` 启动 Electron。主进程走「非 `--serve`」分支，
   通过 `loadFile('renderer/index.html')` 加载生产渲染层 —— 无需完整 `electron-builder` 打包。
3. 每个测试使用独立的临时 `--user-data-dir`，隔离 Electron 的用户配置；全流程所需的开发板包、编译器与 SDK 仍使用配置中的应用数据目录。

应用采用 hash 路由（`withHashLocation()`），测试用 `navigate(win, '/路由')` 切换页面。

## 运行

```powershell
# 完整跑（每次重新构建渲染层，最接近真实）
npm run test:e2e

# 快速迭代（复用已暂存的 renderer/，跳过重新构建）
npm run test:e2e:fast

# 注意：fast 模式会复用现有 renderer/，改过前端代码后请先跑一次完整 test:e2e

# 可视化 / 调试
npm run test:e2e:ui
npm run test:e2e:headed

# 查看上次 HTML 报告
npm run test:e2e:report

# 只跑某个文件
npm run test:e2e -- smoke.spec.ts
```

## ESP32-S3 仿真与块调试闭环

Windows x64 可使用单命令执行 Blockly 编辑、真实 Arduino ESP32-S3 编译、Artifact、
项目块断点及 QEMU/GDB 命中：

```powershell
npm run test:e2e:simulator-debug
```

命令要求 `aily-builder` 和 `aily-simulator` 与本仓库相邻。准备阶段会：

1. 按 fixture `package-lock.json` 把 9 个板卡/核心包安装到
   `e2e/.artifacts/esp32s3-package-source`；
2. 构建相邻 Builder，并把 Blockly 实际使用的应用 npm prefix 切换到该源码；
3. 校验 Builder Artifact/source-map/debug-source snapshot capability；
4. 校验 patchset0012 QEMU/GDB runtime bundle 的文件与 hash。

已完成准备时可快速重跑：

```powershell
npm run test:e2e:simulator-debug -- --skip-prepare
```

完整用例会验证 iframe 调试面板折叠/展开、项目块断点应用、调用栈 blockId 与
GDB frame/stackTop 的一致性，并从真实 GDB 验证局部变量/watch、寄存器分页、Artifact
内存区域读取、Arduino `String` 复合局部变量两级递归展开、临时函数断点新增/删除、
watch 删除/重建、step-over 到下一 Blockly 块、step-into 进入 Arduino SDK/FreeRTOS
函数及切换回 `loop` 栈帧。用例还会终止当前 Electron 隔离会话所属的 QEMU，验证
iframe 显示 crashed、recover 创建新 PID、GDB 重连不会自动恢复配置，以及块断点与
作用域 watch 的两阶段显式恢复。

同一用例使用真实双端器件接线，而不是单引脚逻辑替身：

```text
GPIO3 ── 220Ω Resistor ── LED(A→C) ── GND
GPIO4(INPUT_PULLUP) ── Button(NO) ── GND
```

它会检查 iframe 中 Aily 自有 `aily.appearance.resistor@1.0.0` 外观、LED
`off → on → off` 闪烁、按下后持续点亮及松开后恢复闪烁。Button 没有隐藏上拉电阻；
松开时由 QEMU IOMUX 根据固件的 `INPUT_PULLUP` 解析电平。若改用外接上拉/下拉，
电阻必须作为连接图中的独立双端组件出现。

用例还会读取真实 GDB hardware thread/core 列表，并在存在多个线程时切换到另一线程
再切回原 stopped 线程，验证每线程调用栈和 Blockly 源码定位不会串线。线程名只接受
GDB 明确返回的值；缺失时报告 `GDB thread N`，不能把顶层函数或线程顺序推断为
FreeRTOS task 名称。

块级控制还会验证：Blockly 用户选中的目标不会被 GDB 当前执行块覆盖；“运行到选中块”
使用的临时断点完成后被清理且不污染持久配置；“下一 Blockly 块”会跳过嵌套值块，
停在下一条语句块。iframe 只发送空操作，目标 blockId 与 source-map revision 由本地
Blockly adapter 读取并交给 Gateway。

Builder 会把本次实际编译输入复制为 hash 绑定的 `debug-source` Artifact。完整源码只在
Electron 主进程校验后交给受信任的 Blockly renderer；云端 iframe 只接收当前选中栈帧
附近最多 21 行的只读上下文。E2E 会同时验证当前行与 blockId 联动，以及进入 Arduino
SDK/FreeRTOS 外部源码时只显示相对文件和行号、不转发源码正文。
可独立复核生成的结构化报告：

```powershell
npm run validate:e2e:simulator-debug
```

从当前 Simulator 源码重新打包使用 `--refresh-runtime`；没有补丁 QEMU 构建和现成
runtime bundle 时，安装 Docker 后使用 `--build-patched-qemu`。脚本不会回退到不含
Aily Engine Bridge 的官方 QEMU。

结构化结果保存在：

```text
e2e/.artifacts/simulator-debug-preparation.json
e2e/.artifacts/simulator-debug-report.json
```

专用 CI 定义在 `.github/workflows/simulator-debug-e2e.yml`，会缓存 Linux
交叉编译的 Windows 补丁 QEMU，并在 hosted Windows 上执行同一桌面用例。

## 测试套件

| 文件 | 覆盖 | 默认是否运行 |
|------|------|------|
| [tests/smoke.spec.ts](tests/smoke.spec.ts) | 启动、主窗口、标题、版本、无崩溃 | ✅ |
| [tests/guide.spec.ts](tests/guide.spec.ts) | 指南主页与入口菜单 | ✅ |
| [tests/project-new.spec.ts](tests/project-new.spec.ts) | 新建项目向导渲染（含已装开发板时的选择） | ✅ |
| [tests/tools.spec.ts](tests/tools.spec.ts) | 串口监视器 / 终端面板（无需真实设备） | ✅ |
| [tests/compile-diagnostic.spec.ts](tests/compile-diagnostic.spec.ts) | 编译器根因诊断提取 | ✅ |
| [tests/electron-app-cleanup.spec.ts](tests/electron-app-cleanup.spec.ts) | Electron 退出清理生命周期 | ✅ |
| [tests/error-decision.spec.ts](tests/error-decision.spec.ts) | 失败后继续/中止决策逻辑 | ✅ |
| [tests/full-flow-mode.spec.ts](tests/full-flow-mode.spec.ts) | 全流程场景互斥选择与旧开关兼容 | ✅ |
| [tests/full-flow-checkpoint.spec.ts](tests/full-flow-checkpoint.spec.ts) | 全流程断点保存、恢复与清理 | ✅ |
| [tests/project-plaza-selection.spec.ts](tests/project-plaza-selection.spec.ts) | 项目广场可复现抽样与项目跳过配置 | ✅ |
| [tests/blockly-editor.spec.ts](tests/blockly-editor.spec.ts) | 打开项目、Blockly 工作区/工具箱 | ⏭️ 需环境变量 |
| [tests/compile.spec.ts](tests/compile.spec.ts) | 点击编译并等待结果 | ⏭️ 需环境变量 |
| [tests/full-flow.spec.ts](tests/full-flow.spec.ts) | 单/全开发板连续编译两次；项目广场全量或抽样编译 | ⏭️ 需环境变量 |

## 失败处理与断点续跑

全流程默认启用遇错停止（`AILY_E2E_STOP_ON_ERROR` 默认为 `1`）。通过上述 `npm run test:e2e*` 命令在交互式终端运行时，遇错会先保存断点和输出错误信息，再提示选择：输入 `c` 将该项视为已处理并继续，输入 `a` 或直接回车中止。选择继续的失败项会从断点移除，不再阻塞后续运行，但仍会列入最终错误汇总，因此本次测试仍以失败结束；选择中止则保留当前失败项和其他未完成项。

CI、输入或输出不是 TTY，或者直接调用 Playwright CLI 时不会等待输入，而是直接中止并保留断点。设置 `AILY_E2E_STOP_ON_ERROR=0` 后不会显示提示，测试会自动执行所有条目并在最后汇总错误；成功项会从断点移除，失败项留待下次重试。

断点保存在 `e2e/.artifacts/full-flow-checkpoints/`。再次运行相同模式时会从剩余条目继续；所有待处理项均从断点移除后（全部成功，或在交互提示中选择继续将失败项视为已处理）自动删除对应断点。如需从头运行，删除整个 `full-flow-checkpoints` 目录；若只重置单个模式，需同时删除对应的 `.json` 与 `.json.bak` 文件。项目广场抽样续跑必须复用原来的 sample rate 和 seed，否则 checkpoint 会因候选集合变化而失效。AI 确认是项目自身问题后，可通过 `AILY_E2E_PROJECT_PLAZA_SKIP_PROJECT_IDS` 将对应项目从断点移除并跳过编译。项目广场在交互决策模式下会临时使用单并发，以便逐项处理错误；其他情况下使用 `AILY_E2E_PROJECT_PLAZA_CONCURRENCY`（默认 `2`）。遇错中止时只停止派发新项目，已经启动的项目会完成收尾，不会被强制终止。

> 说明：当前未覆盖「上传(upload)」流程，因为它需要连接真实外设，不便在 CI/本地稳定运行。

> 全流程用例默认保留应用数据目录（Windows 默认 `C:\Users\<user>\AppData\Local\aily-project`，macOS 默认 `~/Library/aily-project`）。仅当设置 `AILY_E2E_CLEAR_APPDATA=1` 时，启动前才会清空并重建该目录；这会删除已安装的开发板包、编译器与 SDK 缓存。新建开发板项目前会清理 `aily-builder` 的临时项目与对象缓存；项目广场批量测试会保留 `aily-builder` 自身管理的哈希缓存。新建项目使用页面生成的默认项目名，项目广场项目则下载到默认项目目录；测试结束后都会清理。开发板项目第一次编译成功后才执行第二次编译；第一次失败会记录为“第 1 次编译失败”并结束该板子的编译。

## 备注

- Playwright 用例仍串行执行（`workers: 1`）；项目广场通常内部并发处理 2 个隔离 Electron，交互错误决策模式下会临时降为单并发。
- 选择器优先使用组件标签（如 `app-header`、`app-serial-monitor`）与稳定 CSS 类；
  应用目前几乎没有 `data-testid`，后续可逐步补充以提升稳定性。
- `renderer/`、`test-results/`、`playwright-report/` 已加入 `.gitignore`。
